# Cierra WhatsApp Bridge

Bridge multi-tenant para conectar WhatsApp Multi-Device a [Cierra CRM](https://cierra-crm.vercel.app).

Cada tenant despliega una instancia (Railway / Fly / Docker) y la conecta a Cierra
desde **Ajustes → WhatsApp Bridge**.

---

## Deploy rápido en Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/fierrojuanpablorenovado-commits/cierra-wa-bridge)

1. **Generate Domain** en Railway (Settings → Networking).
2. Configura variables:
   - `BRIDGE_API_KEY` = una cadena random de 32+ caracteres (usa `openssl rand -hex 32`)
   - `PORT` = `3000` (auto)
3. **Agrega un Volume** montado en `/data` (mínimo 1 GB) para persistir la sesión.
4. Copia la URL pública (ej. `https://cierra-wa-bridge-production-xxxx.up.railway.app`).
5. Pega URL + API key en **Cierra → Ajustes → WhatsApp Bridge**.
6. Pulsa **Iniciar sesión**, escanea el QR con WhatsApp y listo.

## Fly.io

```bash
fly launch --no-deploy
fly secrets set BRIDGE_API_KEY=$(openssl rand -hex 32)
fly volumes create wadata --size 1 --region mia
fly deploy
```

## Docker (VPS propio)

```bash
docker build -t cierra-wa-bridge .
docker run -d --name cierra-wa \
  -p 3000:3000 \
  -v wa-data:/data \
  -e BRIDGE_API_KEY=$(openssl rand -hex 32) \
  cierra-wa-bridge
```

---

## API

Todos los endpoints requieren `Authorization: Bearer ${BRIDGE_API_KEY}`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Sin auth — health check |
| GET | `/session/:orgId/status` | Estado actual (idle, qr, open, closed) |
| GET | `/session/:orgId/qr` | QR base64 para vincular (si state=qr) |
| POST | `/session/:orgId/start` | Arranca la sesión |
| POST | `/session/:orgId/logout` | Cierra sesión |
| POST | `/session/:orgId/send` | `{ phone, text }` — manda mensaje |
| GET | `/session/:orgId/conversation?phone=...` | Últimos 50 mensajes con ese contacto |

`orgId` es el ID del tenant en Cierra (la sesión se aísla por carpeta).

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `BRIDGE_API_KEY` | **requerida** | Bearer token compartido con Cierra |
| `PORT` | `3000` | Puerto HTTP |
| `SESSION_DIR` | `./data/sessions` | Dónde guardar las credenciales de cada org |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Multi-Device protocol
- **[Fastify](https://fastify.dev)** — HTTP server
- **Pino** — logging
- **QRCode** — genera el QR base64 para vincular

## Limitaciones

- WhatsApp puede pedir re-vinculación cada ~14 días si el celular no se abre.
- Solo soporta texto en este momento. Media (imágenes, audio) en roadmap.
- Una instancia puede manejar múltiples orgs (carpetas distintas en `SESSION_DIR`),
  pero para uso productivo se recomienda una instancia por tenant para aislar carga.

## Licencia

MIT — Cierra CRM
