# ==============================================================
# server.py — Backend Python (Flask + paho-mqtt + SQLite)
# ==============================================================
import sqlite3
import json
import threading
import time
import os
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory
import paho.mqtt.client as mqtt

# ── Config ─────────────────────────────────────────────────────
MQTT_BROKER  = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT    = int(os.getenv("MQTT_PORT", 1883))
HTTP_PORT    = int(os.getenv("PORT", 3000))
DB_PATH      = os.path.join(os.path.dirname(__file__), "parking.db")
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

SECTORS         = ["A", "B", "C"]
SPOTS_PER_SECTOR = 30
FLAP_WINDOW_S   = 60       # janela de detecção de flapping (segundos)
FLAP_THRESHOLD  = 5        # trocas dentro da janela
STUCK_S         = 5 * 60   # tempo parado para considerar "stuck"

app = Flask(__name__, static_folder=FRONTEND_DIR)

# ── Banco de dados ──────────────────────────────────────────────
# Conexão por thread (SQLite não é thread-safe por padrão)
_local = threading.local()

def get_db():
    if not hasattr(_local, "conn"):
        _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
    return _local.conn

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
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
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                TEXT NOT NULL,
            fromSector        TEXT NOT NULL,
            recommendedSector TEXT NOT NULL,
            reason            TEXT,
            dataJson          TEXT
        );
    """)
    # Inicializar vagas
    for s in SECTORS:
        for i in range(1, SPOTS_PER_SECTOR + 1):
            spot_id = f"{s}-{i:02d}"
            conn.execute(
                "INSERT OR IGNORE INTO spots (spotId, sectorId, currentState) VALUES (?, ?, 'FREE')",
                (spot_id, s)
            )
    conn.commit()
    conn.close()
    print("[DB] Banco inicializado em:", DB_PATH)

# Lock para escritas concorrentes
db_lock = threading.Lock()

def db_write(sql, params=()):
    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(sql, params)
        conn.commit()
        rowcount = cur.rowcount
        lastrow  = cur.lastrowid
        conn.close()
        return rowcount, lastrow

def db_read(sql, params=()):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def db_read_one(sql, params=()):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(sql, params).fetchone()
    conn.close()
    return dict(row) if row else None

# ── Estado em memória ────────────────────────────────────────
spot_history   = {}   # { spotId: [{"ts": float, "state": str}] }
open_incidents = {}   # { "spotId:type": incident_id }
mqtt_client    = None

def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

# ── Ingestão de eventos ──────────────────────────────────────
def handle_spot_event(payload: dict):
    event_id = payload.get("eventId")
    ts       = payload.get("ts")
    sector   = payload.get("sectorId")
    spot_id  = payload.get("spotId")
    state    = payload.get("state")

    if not all([event_id, ts, sector, spot_id, state]):
        return

    # Idempotente: INSERT OR IGNORE
    rows, _ = db_write(
        "INSERT OR IGNORE INTO spot_events (eventId, ts, sectorId, spotId, state, rawPayloadJson) VALUES (?,?,?,?,?,?)",
        (event_id, ts, sector, spot_id, state, json.dumps(payload))
    )

    if rows > 0:
        db_write(
            "UPDATE spots SET currentState=?, lastChangeTs=?, lastEventId=? WHERE spotId=?",
            (state, ts, event_id, spot_id)
        )
        detect_incidents(spot_id, sector, ts, state)
        check_sector_recommendation(sector)
        save_snapshot(sector)

# ── Snapshot ─────────────────────────────────────────────────
def save_snapshot(sector_id):
    rows = db_read("SELECT currentState FROM spots WHERE sectorId=?", (sector_id,))
    total    = len(rows)
    occupied = sum(1 for r in rows if r["currentState"] == "OCCUPIED")
    free     = total - occupied
    rate     = occupied / total if total else 0
    db_write(
        "INSERT INTO sector_snapshots (ts, sectorId, occupiedCount, freeCount, occupancyRate) VALUES (?,?,?,?,?)",
        (now_iso(), sector_id, occupied, free, rate)
    )

# ── Detecção de incidentes ───────────────────────────────────
def detect_incidents(spot_id, sector_id, ts_str, state):
    try:
        ts_epoch = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
    except Exception:
        ts_epoch = time.time()

    if spot_id not in spot_history:
        spot_history[spot_id] = []

    hist = spot_history[spot_id]
    hist.append({"ts": ts_epoch, "state": state})

    # Manter só últimos 2 min
    cutoff = ts_epoch - FLAP_WINDOW_S * 2
    spot_history[spot_id] = [h for h in hist if h["ts"] >= cutoff]
    hist = spot_history[spot_id]

    # Flapping
    recent  = [h for h in hist if h["ts"] >= ts_epoch - FLAP_WINDOW_S]
    changes = sum(
        1 for i in range(1, len(recent)) if recent[i]["state"] != recent[i-1]["state"]
    )
    if changes >= FLAP_THRESHOLD:
        register_incident(spot_id, sector_id, "FLAPPING", "HIGH", ts_str,
                          {"changes": changes, "window": "1min"})

def check_stuck():
    """Roda em thread separada a cada 30s."""
    while True:
        time.sleep(30)
        spots = db_read("SELECT * FROM spots WHERE currentState IS NOT NULL")
        now   = time.time()
        for spot in spots:
            if not spot.get("lastChangeTs"):
                continue
            try:
                last = datetime.fromisoformat(
                    spot["lastChangeTs"].replace("Z", "+00:00")
                ).timestamp()
            except Exception:
                continue
            age = now - last
            if age >= STUCK_S:
                itype = "STUCK_OCCUPIED" if spot["currentState"] == "OCCUPIED" else "STUCK_FREE"
                register_incident(
                    spot["spotId"], spot["sectorId"], itype, "MEDIUM", now_iso(),
                    {"lastSeen": spot["lastChangeTs"], "state": spot["currentState"],
                     "ageMinutes": round(age / 60)}
                )

def register_incident(spot_id, sector_id, itype, severity, ts, evidence):
    key = f"{spot_id}:{itype}"
    if key in open_incidents:
        return
    _, inc_id = db_write(
        "INSERT INTO incidents (tsOpen, type, severity, sectorId, spotId, evidenceJson, status) VALUES (?,?,?,?,?,?,'open')",
        (ts, itype, severity, sector_id, spot_id, json.dumps(evidence))
    )
    open_incidents[key] = inc_id
    print(f"[INCIDENT] {itype} em {spot_id}")

# ── Recomendação ─────────────────────────────────────────────
def check_sector_recommendation(sector_id):
    rows = db_read("SELECT currentState FROM spots WHERE sectorId=?", (sector_id,))
    if not rows:
        return
    rate = sum(1 for r in rows if r["currentState"] == "OCCUPIED") / len(rows)
    if rate >= 0.90:
        build_recommendation(sector_id)

def build_recommendation(from_sector):
    candidates = []
    for s in SECTORS:
        if s == from_sector:
            continue
        rows = db_read("SELECT currentState FROM spots WHERE sectorId=?", (s,))
        free = sum(1 for r in rows if r["currentState"] == "FREE")
        candidates.append({"sector": s, "free": free})
    candidates.sort(key=lambda x: x["free"], reverse=True)

    best = candidates[0] if candidates else None
    if not best or best["free"] == 0:
        return

    from_rows = db_read("SELECT currentState FROM spots WHERE sectorId=?", (from_sector,))
    from_occ  = sum(1 for r in from_rows if r["currentState"] == "OCCUPIED")
    from_rate = round(from_occ / len(from_rows) * 100) if from_rows else 0
    reason = (f"Setor {from_sector} com {from_rate}% de ocupação; "
              f"Setor {best['sector']} tem {best['free']} vagas livres")

    db_write(
        "INSERT INTO recommendations_log (ts, fromSector, recommendedSector, reason, dataJson) VALUES (?,?,?,?,?)",
        (now_iso(), from_sector, best["sector"], reason, json.dumps(candidates))
    )

    if mqtt_client and mqtt_client.is_connected():
        mqtt_client.publish("campus/parking/recommendations", json.dumps({
            "fromSector": from_sector,
            "recommendedSector": best["sector"],
            "reason": reason,
            "ts": now_iso()
        }))

# ── MQTT ─────────────────────────────────────────────────────
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print(f"[MQTT] Conectado ao broker {MQTT_BROKER}:{MQTT_PORT}")
        client.subscribe("campus/parking/sectors/+/spots/+/events", qos=1)
        client.subscribe("campus/parking/sectors/+/gateway/status", qos=0)
    else:
        print(f"[MQTT] Falha na conexão, código: {rc}")

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        if "/events" in msg.topic:
            handle_spot_event(payload)
    except Exception as e:
        print(f"[MQTT] Payload inválido: {e}")

def connect_mqtt():
    global mqtt_client
    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message
    mqtt_client.reconnect_delay_set(min_delay=1, max_delay=10)
    try:
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
        mqtt_client.loop_start()
    except Exception as e:
        print(f"[MQTT] Erro ao conectar: {e}")

# ── HTTP API ─────────────────────────────────────────────────

# Servir frontend
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)

# GET /api/v1/map
@app.route("/api/v1/map")
def api_map():
    spots = db_read("SELECT * FROM spots ORDER BY sectorId, spotId")
    sectors_map = {s: [sp for sp in spots if sp["sectorId"] == s] for s in SECTORS}
    return jsonify({"sectors": sectors_map, "ts": now_iso()})

# GET /api/v1/sectors
@app.route("/api/v1/sectors")
def api_sectors():
    result = []
    for s in SECTORS:
        rows  = db_read("SELECT currentState FROM spots WHERE sectorId=?", (s,))
        total = len(rows)
        occ   = sum(1 for r in rows if r["currentState"] == "OCCUPIED")
        last  = db_read_one(
            "SELECT lastChangeTs FROM spots WHERE sectorId=? ORDER BY lastChangeTs DESC LIMIT 1", (s,)
        )
        result.append({
            "sectorId": s, "total": total,
            "occupiedCount": occ, "freeCount": total - occ,
            "occupancyRate": occ / total if total else 0,
            "lastUpdateTs": last["lastChangeTs"] if last else None
        })
    return jsonify(result)

# GET /api/v1/sectors/<id>/spots
@app.route("/api/v1/sectors/<sector_id>/spots")
def api_sector_spots(sector_id):
    spots = db_read("SELECT * FROM spots WHERE sectorId=? ORDER BY spotId", (sector_id,))
    return jsonify(spots)

# GET /api/v1/sectors/<id>/free-spots
@app.route("/api/v1/sectors/<sector_id>/free-spots")
def api_free_spots(sector_id):
    limit = int(request.args.get("limit", 10))
    spots = db_read(
        "SELECT * FROM spots WHERE sectorId=? AND currentState='FREE' ORDER BY spotId LIMIT ?",
        (sector_id, limit)
    )
    return jsonify(spots)

# GET /api/v1/recommendation
@app.route("/api/v1/recommendation")
def api_recommendation():
    from_sector = request.args.get("fromSector")
    if not from_sector:
        return jsonify({"error": "fromSector obrigatório"}), 400

    rows = db_read("SELECT currentState FROM spots WHERE sectorId=?", (from_sector,))
    if not rows:
        return jsonify({"error": "Setor não encontrado"}), 404

    candidates = []
    for s in SECTORS:
        if s == from_sector:
            continue
        r    = db_read("SELECT currentState FROM spots WHERE sectorId=?", (s,))
        free = sum(1 for x in r if x["currentState"] == "FREE")
        candidates.append({"sector": s, "free": free})
    candidates.sort(key=lambda x: x["free"], reverse=True)

    best     = candidates[0]
    from_occ = sum(1 for r in rows if r["currentState"] == "OCCUPIED")
    rate     = round(from_occ / len(rows) * 100) if rows else 0
    reason   = (f"Setor {from_sector} com {rate}% de ocupação; "
                f"Setor {best['sector']} tem {best['free']} vagas livres")

    return jsonify({
        "fromSector": from_sector,
        "recommendedSector": best["sector"],
        "reason": reason,
        "ts": now_iso(),
        "candidates": candidates
    })

# GET /api/v1/reports/turnover
@app.route("/api/v1/reports/turnover")
def api_turnover():
    sector_id = request.args.get("sectorId")
    from_ts   = request.args.get("from")
    to_ts     = request.args.get("to")

    sql    = "SELECT sectorId, spotId, COUNT(*) as transitions FROM spot_events WHERE state='OCCUPIED'"
    params = []
    if sector_id: sql += " AND sectorId=?";  params.append(sector_id)
    if from_ts:   sql += " AND ts >= ?";     params.append(from_ts)
    if to_ts:     sql += " AND ts <= ?";     params.append(to_ts)
    sql += " GROUP BY sectorId, spotId ORDER BY transitions DESC"

    rows  = db_read(sql, params)
    total = sum(r["transitions"] for r in rows)
    return jsonify({"total": total, "rows": rows})

# GET /api/v1/incidents
@app.route("/api/v1/incidents")
def api_incidents():
    status = request.args.get("status", "open")
    rows   = db_read("SELECT * FROM incidents WHERE status=? ORDER BY tsOpen DESC LIMIT 50", (status,))
    return jsonify(rows)

# POST /api/v1/incidents/<id>/close
@app.route("/api/v1/incidents/<int:inc_id>/close", methods=["POST"])
def api_close_incident(inc_id):
    db_write("UPDATE incidents SET status='closed', tsClose=? WHERE id=?", (now_iso(), inc_id))
    # Limpar cache
    for k in list(open_incidents.keys()):
        if open_incidents[k] == inc_id:
            del open_incidents[k]
    return jsonify({"ok": True})

# GET /api/v1/recommendations-log
@app.route("/api/v1/recommendations-log")
def api_recs_log():
    rows = db_read("SELECT * FROM recommendations_log ORDER BY ts DESC LIMIT 20")
    return jsonify(rows)

# ── Proxy do Simulador (evita CORS no browser) ───────────────
# O frontend chama /sim/... no backend, que repassa para localhost:3001

import urllib.request
import urllib.error

SIM_URL = os.getenv("SIM_URL", "http://localhost:3001")

def proxy_to_sim(path, body=None):
    url = f"{SIM_URL}/{path}"
    try:
        if body is not None:
            data = json.dumps(body).encode()
            req  = urllib.request.Request(url, data=data,
                                          headers={"Content-Type": "application/json"},
                                          method="POST")
        else:
            req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read()), resp.status
    except urllib.error.HTTPError as e:
        return {"error": e.reason}, e.code
    except Exception as e:
        return {"error": str(e)}, 502

@app.route("/sim/fault", methods=["POST"])
def proxy_fault():
    data, status = proxy_to_sim("sim/fault", request.get_json())
    return jsonify(data), status

@app.route("/sim/clear-faults", methods=["POST"])
def proxy_clear_faults():
    data, status = proxy_to_sim("sim/clear-faults", {})
    return jsonify(data), status

@app.route("/sim/fill-sector", methods=["POST"])
def proxy_fill_sector():
    data, status = proxy_to_sim("sim/fill-sector", request.get_json())
    return jsonify(data), status

@app.route("/sim/status", methods=["GET"])
def proxy_sim_status():
    data, status = proxy_to_sim("sim/status")
    return jsonify(data), status

# ── CORS manual (sem dependência extra) ──────────────────────
@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

@app.route("/api/v1/<path:p>", methods=["OPTIONS"])
def options_handler(p):
    return "", 204

# ── Main ─────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    connect_mqtt()
    threading.Thread(target=check_stuck, daemon=True).start()
    print(f"[HTTP] Servidor rodando em http://localhost:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)