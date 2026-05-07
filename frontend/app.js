// ============================================================
// app.js — Lógica do Dashboard SmartPark
// Polling a cada 2s no backend HTTP
// ============================================================

const API  = 'http://localhost:3000/api/v1';
const SIM  = 'http://localhost:3000/sim'; // proxy pelo backend (evita CORS)

let mapData = {};         // { sectorId: [spots] }
let faultSpots = new Set(); // vagas com falha injetada

// ── Clock ───────────────────────────────────────────────────
function updateClock() {
  document.getElementById('sys-time').textContent =
    new Date().toLocaleTimeString('pt-BR');
}
setInterval(updateClock, 1000);
updateClock();

// ── Fetch helpers ────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch {
    return null;
  }
}

// ── Render setores (painel esquerdo) ────────────────────────
function renderSectors(sectors) {
  const el = document.getElementById('sectors-list');
  el.innerHTML = '';
  for (const s of sectors) {
    const rate = s.occupancyRate;
    const cls  = rate >= 0.9 ? 'high' : rate >= 0.6 ? 'mid' : 'low';
    const card = document.createElement('div');
    card.className = `sector-card ${rate >= 0.9 ? 'alert' : ''}`;
    card.innerHTML = `
      <div class="sector-header">
        <span class="sector-id">SETOR ${s.sectorId}</span>
        <span class="sector-rate ${cls}">${Math.round(rate * 100)}%</span>
      </div>
      <div class="sector-bar-bg">
        <div class="sector-bar-fill ${cls}" style="width:${Math.round(rate*100)}%"></div>
      </div>
      <div class="sector-stats">
        <span class="stat-free">▼ ${s.freeCount} livres</span>
        <span class="stat-occ">▲ ${s.occupiedCount} ocupadas</span>
        <span>/ ${s.total}</span>
      </div>
    `;
    el.appendChild(card);
  }
}

// ── Render mapa de vagas ─────────────────────────────────────
function renderMap(mapObj) {
  const el = document.getElementById('map-container');
  // Só re-renderiza estrutura se necessário
  for (const [sectorId, spots] of Object.entries(mapObj)) {
    let sDiv = document.getElementById(`sector-map-${sectorId}`);
    if (!sDiv) {
      sDiv = document.createElement('div');
      sDiv.className = 'map-sector';
      sDiv.id = `sector-map-${sectorId}`;
      sDiv.innerHTML = `
        <div class="map-sector-title">── SETOR ${sectorId} ──────────</div>
        <div class="spots-grid" id="grid-${sectorId}"></div>
      `;
      el.appendChild(sDiv);
    }

    const grid = document.getElementById(`grid-${sectorId}`);

    for (const spot of spots) {
      let sEl = document.getElementById(`spot-${spot.spotId}`);
      const isFault = faultSpots.has(spot.spotId);
      const cls = isFault ? 'FAULT' : spot.currentState;

      if (!sEl) {
        sEl = document.createElement('div');
        sEl.className = `spot ${cls}`;
        sEl.id = `spot-${spot.spotId}`;
        const num = spot.spotId.split('-')[1];
        sEl.textContent = num;
        sEl.title = `${spot.spotId} — ${spot.currentState}`;
        grid.appendChild(sEl);
      } else {
        if (!sEl.className.includes(cls)) {
          sEl.className = `spot ${cls}`;
          sEl.title = `${spot.spotId} — ${spot.currentState}`;
          // Micro-animação de troca
          sEl.style.transition = 'background .3s';
        }
      }
    }
  }
}

// ── Render incidentes ────────────────────────────────────────
function renderIncidents(incidents) {
  const el = document.getElementById('incidents-list');
  el.innerHTML = '';
  if (!incidents || incidents.length === 0) {
    el.innerHTML = '<div class="empty-msg">SEM INCIDENTES ABERTOS</div>';
    return;
  }
  for (const inc of incidents) {
    const ev = JSON.parse(inc.evidenceJson || '{}');
    const d  = document.createElement('div');
    d.className = `incident-item ${inc.severity}`;
    d.innerHTML = `
      <div class="incident-type">${inc.type}</div>
      <div><b>${inc.spotId}</b> — Setor ${inc.sectorId}</div>
      <div class="incident-meta">
        Aberto: ${new Date(inc.tsOpen).toLocaleTimeString('pt-BR')}<br>
        ${ev.ageMinutes ? `Parado há ${ev.ageMinutes} min` : ''}
        ${ev.changes   ? `${ev.changes} trocas em 1min` : ''}
      </div>
      <button class="btn-close-inc" onclick="closeIncident(${inc.id})">FECHAR</button>
    `;
    el.appendChild(d);
  }
}

// ── Render log de recomendações ──────────────────────────────
function renderRecsLog(recs) {
  const el = document.getElementById('recs-log');
  el.innerHTML = '';
  if (!recs || recs.length === 0) {
    el.innerHTML = '<div class="empty-msg">SEM RECOMENDAÇÕES</div>';
    return;
  }
  for (const r of recs) {
    const d = document.createElement('div');
    d.className = 'rec-log-item';
    d.innerHTML = `
      <div class="rec-log-sectors">${r.fromSector} → ${r.recommendedSector}</div>
      <div>${r.reason}</div>
      <div style="color:var(--text-dim);font-size:8px">${new Date(r.ts).toLocaleTimeString('pt-BR')}</div>
    `;
    el.appendChild(d);
  }
}

// ── Polling principal ────────────────────────────────────────
async function refresh() {
  const [mapResp, sectorsResp, incidentsResp, recsLogResp] = await Promise.all([
    apiFetch(`${API}/map`),
    apiFetch(`${API}/sectors`),
    apiFetch(`${API}/incidents?status=open`),
    apiFetch(`${API}/recommendations-log`),
  ]);

  if (mapResp)       { mapData = mapResp.sectors; renderMap(mapData); }
  if (sectorsResp)   renderSectors(sectorsResp);
  if (incidentsResp) renderIncidents(incidentsResp);
  if (recsLogResp)   renderRecsLog(recsLogResp);
}

setInterval(refresh, 2000);
refresh();

// ── Ações do usuário ─────────────────────────────────────────

async function fetchRecommendation() {
  const from = document.getElementById('rec-from').value;
  const data = await apiFetch(`${API}/recommendation?fromSector=${from}`);
  const box  = document.getElementById('rec-result');
  if (!data) { box.innerHTML = '<span style="color:var(--red)">ERRO AO CONSULTAR</span>'; box.classList.remove('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `
    <span class="rec-sector">Setor ${from} → <b>${data.recommendedSector}</b></span>
    ${data.reason}<br>
    <span style="color:var(--text-dim);font-size:9px">${new Date(data.ts).toLocaleTimeString('pt-BR')}</span>
  `;
}

async function injectFault() {
  const spotId = document.getElementById('fault-spot').value.trim().toUpperCase();
  const fault  = document.getElementById('fault-type').value;
  if (!spotId) return alert('Informe o ID da vaga');
  const res = await apiFetch(`${SIM}/fault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spotId, fault })
  });
  if (res?.ok) {
    faultSpots.add(spotId);
    const el = document.getElementById(`spot-${spotId}`);
    if (el) el.className = 'spot FAULT';
    console.log(`[UI] Falha injetada: ${spotId} → ${fault}`);
  } else {
    alert('Vaga não encontrada no simulador');
  }
}

async function clearFaults() {
  await apiFetch(`${SIM}/clear-faults`, { method: 'POST' });
  faultSpots.clear();
  console.log('[UI] Falhas removidas');
}

async function fillSector() {
  const sectorId = document.getElementById('fill-sector').value;
  const res = await apiFetch(`${SIM}/fill-sector`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectorId })
  });
  if (res?.ok) {
    console.log(`[UI] Setor ${sectorId} lotado (${res.filled} vagas)`);
  }
}

async function closeIncident(id) {
  await apiFetch(`${API}/incidents/${id}/close`, { method: 'POST' });
  refresh();
}