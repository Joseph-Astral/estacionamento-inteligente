// ============================================================
// simulator.js — Simulador de 90 sensores + 3 gateways
// Tempo simulado: 1 segundo real = 1 minuto simulado
// ============================================================
const mqtt = require('mqtt');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const SIM_PORT    = process.env.SIM_PORT || 3001;

// ── Config ──────────────────────────────────────────────────
const SECTORS = ['A', 'B', 'C'];
const SPOTS_PER_SECTOR = 30;
const TICK_MS = 1000; // 1s = 1 min simulado

// Horários de pico (em "minutos simulados" do dia, 0..1439)
const PEAK_HOURS = [
  { start: 7 * 60,  end: 9 * 60  }, // manhã
  { start: 17 * 60, end: 19 * 60 }, // fim da tarde
];

// Estado das vagas
// { spotId: { sectorId, state, lastChange, fault } }
const spots = {};

function initSpots() {
  for (const s of SECTORS) {
    for (let i = 1; i <= SPOTS_PER_SECTOR; i++) {
      const spotId = `${s}-${String(i).padStart(2, '0')}`;
      spots[spotId] = {
        sectorId: s,
        state: 'FREE',
        lastChange: 0,   // tick simulado
        fault: null      // null | 'stuck_occupied' | 'stuck_free' | 'flapping'
      };
    }
  }
}

// ── MQTT ────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 3000 });
client.on('connect', () => console.log('[SIM] MQTT conectado'));
client.on('error', e => console.error('[SIM] MQTT erro:', e.message));

function publishEvent(spotId, sectorId, state, source = 'sensor') {
  const payload = {
    eventId: uuidv4(),
    ts: new Date().toISOString(),
    sectorId,
    spotId,
    state,
    source
  };
  const topic = `campus/parking/sectors/${sectorId}/spots/${spotId}/events`;
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
}

function publishGatewayStatus(sectorId) {
  const topic = `campus/parking/sectors/${sectorId}/gateway/status`;
  client.publish(topic, JSON.stringify({
    sectorId,
    ts: new Date().toISOString(),
    status: 'online'
  }));
}

// ── Lógica de simulação ─────────────────────────────────────
let simTick = 0; // minuto do dia (0..1439), reinicia todo dia

function isPeakHour(minuteOfDay) {
  return PEAK_HOURS.some(p => minuteOfDay >= p.start && minuteOfDay <= p.end);
}

function probabilityOfArrival(minuteOfDay) {
  // Pico: 15% por tick | Off-peak: 4% por tick
  return isPeakHour(minuteOfDay) ? 0.15 : 0.04;
}

function randomStayDuration() {
  // 30 min a 360 min (ticks, já que 1 tick = 1 min)
  return 30 + Math.floor(Math.random() * 330);
}

function simulateTick() {
  const minuteOfDay = simTick % 1440;

  for (const [spotId, spot] of Object.entries(spots)) {
    // Falhas injetadas
    if (spot.fault === 'stuck_occupied') {
      if (spot.state !== 'OCCUPIED') {
        spot.state = 'OCCUPIED';
        publishEvent(spotId, spot.sectorId, 'OCCUPIED', 'sensor');
      }
      continue;
    }
    if (spot.fault === 'stuck_free') {
      if (spot.state !== 'FREE') {
        spot.state = 'FREE';
        publishEvent(spotId, spot.sectorId, 'FREE', 'sensor');
      }
      continue;
    }
    if (spot.fault === 'flapping') {
      // Alterna a cada 2 ticks
      if (simTick % 2 === 0) {
        spot.state = spot.state === 'FREE' ? 'OCCUPIED' : 'FREE';
        publishEvent(spotId, spot.sectorId, spot.state, 'sensor');
      }
      continue;
    }

    // Comportamento normal
    if (spot.state === 'FREE') {
      const prob = probabilityOfArrival(minuteOfDay);
      if (Math.random() < prob) {
        spot.state = 'OCCUPIED';
        spot.lastChange = simTick;
        spot.stayUntil = simTick + randomStayDuration();
        publishEvent(spotId, spot.sectorId, 'OCCUPIED', 'sensor');
      }
    } else if (spot.state === 'OCCUPIED') {
      if (simTick >= (spot.stayUntil || 0)) {
        spot.state = 'FREE';
        spot.lastChange = simTick;
        publishEvent(spotId, spot.sectorId, 'FREE', 'sensor');
      }
    }
  }

  // Gateway heartbeat a cada 30 ticks
  if (simTick % 30 === 0) {
    for (const s of SECTORS) publishGatewayStatus(s);
  }

  simTick++;
}

// ── HTTP para injeção de falhas ─────────────────────────────
const app = express();
app.use(express.json());

// POST /sim/fault  { spotId, fault: 'stuck_occupied'|'stuck_free'|'flapping'|null }
app.post('/sim/fault', (req, res) => {
  const { spotId, fault } = req.body;
  if (!spots[spotId]) return res.status(404).json({ error: 'Vaga não encontrada' });
  spots[spotId].fault = fault || null;
  console.log(`[SIM] Falha '${fault}' injetada em ${spotId}`);
  res.json({ ok: true, spotId, fault });
});

// POST /sim/clear-faults — limpar todas as falhas
app.post('/sim/clear-faults', (req, res) => {
  for (const spot of Object.values(spots)) spot.fault = null;
  res.json({ ok: true, message: 'Todas as falhas removidas' });
});

// POST /sim/fill-sector  { sectorId }  — lotar setor (>= 90%)
app.post('/sim/fill-sector', (req, res) => {
  const { sectorId } = req.body;
  if (!SECTORS.includes(sectorId)) return res.status(400).json({ error: 'Setor inválido' });
  const sectorSpots = Object.entries(spots).filter(([, s]) => s.sectorId === sectorId);
  const toFill = Math.ceil(sectorSpots.length * 0.93); // 93%
  let filled = 0;
  for (const [spotId, spot] of sectorSpots) {
    if (filled >= toFill) break;
    if (spot.state !== 'OCCUPIED') {
      spot.state = 'OCCUPIED';
      spot.stayUntil = simTick + 999;
      publishEvent(spotId, spot.sectorId, 'OCCUPIED', 'gateway');
      filled++;
    }
  }
  res.json({ ok: true, sectorId, filled });
});

// GET /sim/status — estado atual do simulador
app.get('/sim/status', (req, res) => {
  const summary = {};
  for (const s of SECTORS) {
    const ss = Object.entries(spots).filter(([, sp]) => sp.sectorId === s);
    summary[s] = {
      total: ss.length,
      occupied: ss.filter(([, sp]) => sp.state === 'OCCUPIED').length,
      faults: ss.filter(([, sp]) => sp.fault).map(([id, sp]) => ({ spotId: id, fault: sp.fault }))
    };
  }
  res.json({ simTick, minuteOfDay: simTick % 1440, summary });
});

app.listen(SIM_PORT, () => console.log(`[SIM] HTTP de controle em http://localhost:${SIM_PORT}`));

// ── Start ───────────────────────────────────────────────────
initSpots();
console.log('[SIM] Iniciando simulação (1 tick = 1 min simulado)...');
setInterval(simulateTick, TICK_MS);