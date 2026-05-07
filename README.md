# SmartPark — MVP de Estacionamento Inteligente

Sistema de monitoramento de estacionamento com **MQTT**, **REST API**, **SQLite** e **Dashboard Web**.

---

## Estrutura de arquivos

```
parking-mvp/
├── backend/
│   ├── server.js        ← Servidor HTTP + ingestão MQTT + banco
│   ├── package.json
│   └── Dockerfile
├── simulator/
│   ├── simulator.js     ← 90 sensores simulados + controle de falhas
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── index.html       ← Dashboard principal
│   ├── style.css        ← Estilo painel industrial
│   └── app.js           ← Lógica de polling e interação
├── mosquitto.conf        ← Config do broker MQTT
├── docker-compose.yml    ← Sobe tudo de uma vez
└── README.md
```

---

## Como rodar

### Opção 1 — Docker Compose (recomendado)

```bash
docker-compose up --build
```

Acesse: **http://localhost:3000**

---

### Opção 2 — Manual (sem Docker)

#### 1. Instalar Mosquitto

```bash
# Ubuntu/Debian
sudo apt install mosquitto mosquitto-clients

# macOS
brew install mosquitto

# Rodar
mosquitto -c mosquitto.conf
```

#### 2. Instalar dependências e rodar o Backend

```bash
cd backend
npm install
node server.js
# Rodando em: http://localhost:3000
```

#### 3. Instalar dependências e rodar o Simulador

```bash
cd simulator
npm install
node simulator.js
# Rodando em: http://localhost:3001
```

#### 4. Abrir o Frontend

```bash
# Abrir o arquivo diretamente no navegador:
open frontend/index.html

# OU acessar via backend (que serve a pasta frontend):
# http://localhost:3000
```

---

## 📡 API REST — Endpoints

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/v1/map` | Mapa completo de todas as vagas |
| GET | `/api/v1/sectors` | Resumo de ocupação por setor |
| GET | `/api/v1/sectors/:id/spots` | Vagas de um setor |
| GET | `/api/v1/sectors/:id/free-spots?limit=10` | Vagas livres |
| GET | `/api/v1/recommendation?fromSector=A` | Sugestão de setor alternativo |
| GET | `/api/v1/incidents?status=open` | Incidentes abertos |
| POST | `/api/v1/incidents/:id/close` | Fechar um incidente |
| GET | `/api/v1/reports/turnover?sectorId=A` | Relatório de rotatividade |
| GET | `/api/v1/recommendations-log` | Histórico de recomendações |

---

## Controle do Simulador (HTTP)

| Método | Endpoint | Body | Descrição |
|--------|----------|------|-----------|
| POST | `http://localhost:3001/sim/fault` | `{ spotId, fault }` | Injeta falha em uma vaga |
| POST | `http://localhost:3001/sim/clear-faults` | — | Remove todas as falhas |
| POST | `http://localhost:3001/sim/fill-sector` | `{ sectorId }` | Lota setor em 93% |
| GET  | `http://localhost:3001/sim/status` | — | Estado atual do simulador |

### Tipos de falha disponíveis
- `stuck_occupied` — sensor sempre reporta OCUPADO
- `stuck_free` — sensor sempre reporta LIVRE
- `flapping` — sensor alterna rapidamente (a cada 2 ticks)

### Exemplo via curl
```bash
# Injetar flapping na vaga A-07
curl -X POST http://localhost:3001/sim/fault \
  -H "Content-Type: application/json" \
  -d '{"spotId":"A-07","fault":"flapping"}'

# Lotar setor B
curl -X POST http://localhost:3001/sim/fill-sector \
  -H "Content-Type: application/json" \
  -d '{"sectorId":"B"}'

# Ver recomendação para quem está no setor B
curl http://localhost:3000/api/v1/recommendation?fromSector=B
```

---

## Tempo simulado

- **1 segundo real = 1 minuto simulado**
- Horários de pico: 07h–09h e 17h–19h (taxa de chegada 15%)
- Fora do pico: taxa de chegada 4%
- Permanência: 30 a 360 minutos simulados

---

## Tópicos MQTT

| Tópico | Direção | Descrição |
|--------|---------|-----------|
| `campus/parking/sectors/<id>/spots/<spotId>/events` | Sim→Backend | Evento de mudança de estado |
| `campus/parking/sectors/<id>/gateway/status` | Sim→Backend | Heartbeat do gateway |
| `campus/parking/recommendations` | Backend→All | Recomendações de setor |

---

## Banco de dados (SQLite)

Arquivo: `backend/parking.db`

Tabelas:
- `spots` — estado atual de cada vaga
- `spot_events` — histórico completo de eventos
- `sector_snapshots` — snapshots de ocupação por setor
- `incidents` — incidentes detectados
- `recommendations_log` — histórico de recomendações

---

## Checklist de demonstração

- [x] Subir Mosquitto + backend + simulador
- [x] `/api/v1/sectors` e `/api/v1/map` atualizando em tempo real
- [x] Injetar falha (`/sim/fault`) → incidente aparece em `/api/v1/incidents`
- [x] Lotar setor (`/sim/fill-sector`) → recomendação em `/api/v1/recommendation`
- [x] Dashboard visual mostrando tudo em tempo real

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `MQTT_BROKER` | `mqtt://localhost:1883` | Endereço do broker |
| `PORT` | `3000` | Porta do backend |
| `SIM_PORT` | `3001` | Porta do simulador |
