// ============================================================
// server.js — Backend principal (HTTP + MQTT + SQLite)
// ============================================================
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir front-end estático
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Banco de dados ──────────────────────────────────────────
const db = new Database(path.join(__dirname, 'parking.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS spots (
    spotId       TEXT PRIMARY KEY,
    sectorId     TEXT NOT NULL,
    currentState TEXT NOT NULL DEFAULT 'FREE',
    lastChangeTs TEXT,
    lastEventId  TEXT
  );

  CREATE TABLE IF NOT EXISTS spot_events (
    eventId        TEXT PRIMARY KEY,
    ts             TEXT NOT NULL,
    sectorId       TEXT NOT NULL,
    spotId         TEXT NOT NULL,
    state          TEXT NOT NULL,
    rawPayloadJson TEXT
  );

  CREATE TABLE IF NOT EXISTS sector_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    sectorId      TEXT NOT NULL,
    occupiedCount INTEGER,
    freeCount     INTEGER,
    occupancyRate REAL
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tsOpen       TEXT NOT NULL,
    tsClose      TEXT,
    type         TEXT NOT NULL,
    severity     TEXT DEFAULT 'MEDIUM',
    sectorId     TEXT NOT NULL,
    spotId       TEXT NOT NULL,
    evidenceJson TEXT,
    status       TEXT DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS recommendations_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT NOT NULL,
    fromSector       TEXT NOT NULL,
    recommendedSector TEXT NOT NULL,
    reason           TEXT,
    dataJson         TEXT
  );
`);

// ── Inicializar vagas ───────────────────────────────────────
const SECTORS = ['A', 'B', 'C'];
const SPOTS_PER_SECTOR = 30;

const insertSpot = db.prepare(`
  INSERT OR IGNORE INTO spots (spotId, sectorId, currentState) VALUES (?, ?, 'FREE')
`);
for (const s of SECTORS) {
  for (let i = 1; i <= SPOTS_PER_SECTOR; i++) {
    const id = `${s}-${String(i).padStart(2, '0')}`;
    insertSpot.run(id, s);
  }
}

// ── MQTT ────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
let mqttClient;

function connectMQTT() {
  mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 3000 });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Conectado ao broker:', MQTT_BROKER);
    mqttClient.subscribe('campus/parking/sectors/+/spots/+/events', { qos: 1 });
    mqttClient.subscribe('campus/parking/sectors/+/gateway/status', { qos: 0 });
  });

  mqttClient.on('error', (err) => console.error('[MQTT] Erro:', err.message));

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (topic.includes('/events')) handleSpotEvent(payload);
    } catch (e) {
      console.error('[MQTT] Payload inválido:', e.message);
    }
  });
}

// ── Ingestão de eventos (idempotente) ───────────────────────
const stmtInsertEvent = db.prepare(`
  INSERT OR IGNORE INTO spot_events (eventId, ts, sectorId, spotId, state, rawPayloadJson)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtUpdateSpot = db.prepare(`
  UPDATE spots SET currentState=?, lastChangeTs=?, lastEventId=? WHERE spotId=?
`);
const stmtInsertSnapshot = db.prepare(`
  INSERT INTO sector_snapshots (ts, sectorId, occupiedCount, freeCount, occupancyRate)
  VALUES (?, ?, ?, ?, ?)
`);

// Rastrear histórico para detecção de incidentes
const spotHistory = {}; // { spotId: [{ ts, state }] }

function handleSpotEvent(payload) {
  const { eventId, ts, sectorId, spotId, state } = payload;
  if (!eventId || !spotId || !state) return;

  const inserted = stmtInsertEvent.run(
    eventId, ts, sectorId, spotId, state, JSON.stringify(payload)
  );

  if (inserted.changes > 0) {
    stmtUpdateSpot.run(state, ts, eventId, spotId);
    detectIncidents(spotId, sectorId, ts, state);
    checkSectorRecommendation(sectorId);
    saveSnapshot(sectorId);
  }
}

// ── Snapshot por setor ──────────────────────────────────────
function saveSnapshot(sectorId) {
  const rows = db.prepare(`
    SELECT currentState FROM spots WHERE sectorId=?
  `).all(sectorId);
  const total = rows.length;
  const occupied = rows.filter(r => r.currentState === 'OCCUPIED').length;
  const free = total - occupied;
  stmtInsertSnapshot.run(new Date().toISOString(), sectorId, occupied, free, occupied / total);
}

// ── Detecção de incidentes ──────────────────────────────────
const FLAP_WINDOW_MS = 60000; // 1 min
const FLAP_THRESHOLD = 5;
const STUCK_MS = 5 * 60000; // 5 min sem mudar (tempo simulado)

const openIncidents = {}; // { spotId: incidentId }

function detectIncidents(spotId, sectorId, tsStr, state) {
  if (!spotHistory[spotId]) spotHistory[spotId] = [];
  const hist = spotHistory[spotId];
  const now = new Date(tsStr).getTime();
  hist.push({ ts: now, state });

  // Manter só últimos 2 min
  const cutoff = now - FLAP_WINDOW_MS * 2;
  spotHistory[spotId] = hist.filter(h => h.ts >= cutoff);

  // Flapping: muitas trocas em 1 min
  const recent = hist.filter(h => h.ts >= now - FLAP_WINDOW_MS);
  const changes = recent.filter((h, i) => i > 0 && h.state !== recent[i - 1].state).length;
  if (changes >= FLAP_THRESHOLD) {
    registerIncident(spotId, sectorId, 'FLAPPING', 'HIGH', tsStr, { changes, window: '1min' });
  }

  // Stuck: mesma vaga por muito tempo (verificado periodicamente — veja setInterval abaixo)
}

function checkStuck() {
  const spots = db.prepare(`SELECT * FROM spots WHERE currentState IS NOT NULL`).all();
  const now = Date.now();
  for (const spot of spots) {
    if (!spot.lastChangeTs) continue;
    const age = now - new Date(spot.lastChangeTs).getTime();
    if (age >= STUCK_MS) {
      const type = spot.currentState === 'OCCUPIED' ? 'STUCK_OCCUPIED' : 'STUCK_FREE';
      registerIncident(spot.spotId, spot.sectorId, type, 'MEDIUM', new Date().toISOString(), {
        lastSeen: spot.lastChangeTs,
        state: spot.currentState,
        ageMinutes: Math.round(age / 60000)
      });
    }
  }
}
setInterval(checkStuck, 30000);

function registerIncident(spotId, sectorId, type, severity, ts, evidence) {
  const key = `${spotId}:${type}`;
  if (openIncidents[key]) return; // já aberto
  const result = db.prepare(`
    INSERT INTO incidents (tsOpen, type, severity, sectorId, spotId, evidenceJson, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(ts, type, severity, sectorId, spotId, JSON.stringify(evidence));
  openIncidents[key] = result.lastInsertRowid;
  console.log(`[INCIDENT] ${type} em ${spotId}`);
}

// ── Recomendação de setor ───────────────────────────────────
function checkSectorRecommendation(sectorId) {
  const rows = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(sectorId);
  const rate = rows.filter(r => r.currentState === 'OCCUPIED').length / rows.length;
  if (rate >= 0.90) buildRecommendation(sectorId);
}

function buildRecommendation(fromSector) {
  const candidates = SECTORS.filter(s => s !== fromSector).map(s => {
    const rows = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(s);
    const free = rows.filter(r => r.currentState === 'FREE').length;
    return { sector: s, free };
  }).sort((a, b) => b.free - a.free);

  const best = candidates[0];
  if (!best || best.free === 0) return;

  const fromRows = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(fromSector);
  const fromOccRate = Math.round(fromRows.filter(r => r.currentState === 'OCCUPIED').length / fromRows.length * 100);
  const reason = `Setor ${fromSector} com ${fromOccRate}% de ocupação; Setor ${best.sector} tem ${best.free} vagas livres`;

  db.prepare(`
    INSERT INTO recommendations_log (ts, fromSector, recommendedSector, reason, dataJson)
    VALUES (?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), fromSector, best.sector, reason, JSON.stringify(candidates));

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish('campus/parking/recommendations', JSON.stringify({
      fromSector, recommendedSector: best.sector, reason, ts: new Date().toISOString()
    }));
  }
}

// ── HTTP API ────────────────────────────────────────────────

// GET /api/v1/map
app.get('/api/v1/map', (req, res) => {
  const spots = db.prepare(`SELECT * FROM spots ORDER BY sectorId, spotId`).all();
  const map = {};
  for (const s of SECTORS) {
    map[s] = spots.filter(sp => sp.sectorId === s);
  }
  res.json({ sectors: map, ts: new Date().toISOString() });
});

// GET /api/v1/sectors
app.get('/api/v1/sectors', (req, res) => {
  const result = SECTORS.map(s => {
    const rows = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(s);
    const total = rows.length;
    const occupied = rows.filter(r => r.currentState === 'OCCUPIED').length;
    const lastRow = db.prepare(`SELECT lastChangeTs FROM spots WHERE sectorId=? ORDER BY lastChangeTs DESC LIMIT 1`).get(s);
    return {
      sectorId: s, total, occupiedCount: occupied,
      freeCount: total - occupied,
      occupancyRate: occupied / total,
      lastUpdateTs: lastRow?.lastChangeTs || null
    };
  });
  res.json(result);
});

// GET /api/v1/sectors/:sectorId/spots
app.get('/api/v1/sectors/:sectorId/spots', (req, res) => {
  const spots = db.prepare(`SELECT * FROM spots WHERE sectorId=? ORDER BY spotId`).all(req.params.sectorId);
  res.json(spots);
});

// GET /api/v1/sectors/:sectorId/free-spots
app.get('/api/v1/sectors/:sectorId/free-spots', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const spots = db.prepare(`
    SELECT * FROM spots WHERE sectorId=? AND currentState='FREE' ORDER BY spotId LIMIT ?
  `).all(req.params.sectorId, limit);
  res.json(spots);
});

// GET /api/v1/recommendation
app.get('/api/v1/recommendation', (req, res) => {
  const fromSector = req.query.fromSector;
  if (!fromSector) return res.status(400).json({ error: 'fromSector obrigatório' });
  const rows = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(fromSector);
  if (!rows.length) return res.status(404).json({ error: 'Setor não encontrado' });

  const candidates = SECTORS.filter(s => s !== fromSector).map(s => {
    const r = db.prepare(`SELECT currentState FROM spots WHERE sectorId=?`).all(s);
    return { sector: s, free: r.filter(x => x.currentState === 'FREE').length };
  }).sort((a, b) => b.free - a.free);

  const best = candidates[0];
  const fromOcc = rows.filter(r => r.currentState === 'OCCUPIED').length;
  const reason = `Setor ${fromSector} com ${Math.round(fromOcc / rows.length * 100)}% de ocupação; Setor ${best.sector} tem ${best.free} vagas livres`;

  res.json({
    fromSector,
    recommendedSector: best.sector,
    reason,
    ts: new Date().toISOString(),
    candidates
  });
});

// GET /api/v1/reports/turnover
app.get('/api/v1/reports/turnover', (req, res) => {
  const { sectorId, from, to } = req.query;
  let query = `
    SELECT sectorId, spotId, COUNT(*) as transitions
    FROM spot_events
    WHERE state='OCCUPIED'
  `;
  const params = [];
  if (sectorId) { query += ` AND sectorId=?`; params.push(sectorId); }
  if (from)     { query += ` AND ts >= ?`;     params.push(from); }
  if (to)       { query += ` AND ts <= ?`;     params.push(to); }
  query += ` GROUP BY sectorId, spotId ORDER BY transitions DESC`;
  const rows = db.prepare(query).all(...params);
  const total = rows.reduce((a, r) => a + r.transitions, 0);
  res.json({ total, rows });
});

// GET /api/v1/incidents
app.get('/api/v1/incidents', (req, res) => {
  const status = req.query.status || 'open';
  const rows = db.prepare(`SELECT * FROM incidents WHERE status=? ORDER BY tsOpen DESC LIMIT 50`).all(status);
  res.json(rows);
});

// POST /api/v1/incidents/:id/close  (fechar incidente)
app.post('/api/v1/incidents/:id/close', (req, res) => {
  db.prepare(`UPDATE incidents SET status='closed', tsClose=? WHERE id=?`)
    .run(new Date().toISOString(), req.params.id);
  // Limpar cache
  for (const k of Object.keys(openIncidents)) {
    if (openIncidents[k] == req.params.id) delete openIncidents[k];
  }
  res.json({ ok: true });
});

// GET /api/v1/recommendations-log
app.get('/api/v1/recommendations-log', (req, res) => {
  const rows = db.prepare(`SELECT * FROM recommendations_log ORDER BY ts DESC LIMIT 20`).all();
  res.json(rows);
});

// ── Iniciar ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[HTTP] Servidor rodando em http://localhost:${PORT}`);
  connectMQTT();
});
