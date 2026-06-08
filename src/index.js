/**
 * Cierra WhatsApp Bridge
 *
 * Multi-tenant WhatsApp Multi-Device bridge usando Baileys.
 * Cada org (orgId) tiene su propia sesión persistente.
 *
 * Endpoints (todos requieren Authorization: Bearer ${BRIDGE_API_KEY}):
 *   GET   /health
 *   GET   /session/:orgId/status                  → { state, phone }
 *   GET   /session/:orgId/qr                      → { qr: 'data:image/png;...' }
 *   POST  /session/:orgId/start                   → arranca sesión
 *   POST  /session/:orgId/logout                  → cierra sesión
 *   POST  /session/:orgId/send  { phone, text }   → manda mensaje
 *   GET   /session/:orgId/conversation?phone=...  → últimos N mensajes
 */

import Fastify from 'fastify';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.BRIDGE_API_KEY;
const SESSION_DIR = process.env.SESSION_DIR || './data/sessions';

if (!API_KEY || API_KEY.length < 16) {
  console.error('[bridge] BRIDGE_API_KEY missing or too short (mín 16 chars)');
  process.exit(1);
}

mkdirSync(SESSION_DIR, { recursive: true });

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

// In-memory store of active sessions
/** @type {Map<string, { sock: any, qr: string | null, state: string, phone: string | null, history: Map<string, any[]> }>} */
const sessions = new Map();

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    reply.code(401).send({ error: 'Missing Bearer token' });
    return reply;
  }
  const token = auth.slice(7).trim();
  if (token !== API_KEY) {
    reply.code(401).send({ error: 'Invalid token' });
    return reply;
  }
});

// ─── Session core ─────────────────────────────────────────────────────────────

async function getOrCreateSession(orgId) {
  if (sessions.has(orgId)) return sessions.get(orgId);

  const dir = join(SESSION_DIR, orgId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: log,
    printQRInTerminal: false,
    browser: ['Cierra CRM', 'Chrome', '1.0']
  });

  const entry = {
    sock,
    qr: null,
    state: 'connecting',
    phone: sock?.user?.id?.split(':')[0] || null,
    history: new Map()  // phone -> messages[]
  };
  sessions.set(orgId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      entry.qr = await QRCode.toDataURL(qr);
      entry.state = 'qr';
    }
    if (connection === 'open') {
      entry.qr = null;
      entry.state = 'open';
      entry.phone = sock?.user?.id?.split(':')[0] || null;
      log.info({ orgId, phone: entry.phone }, 'session connected');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      entry.state = 'closed';
      if (code !== DisconnectReason.loggedOut) {
        // try reconnect
        sessions.delete(orgId);
        setTimeout(() => getOrCreateSession(orgId).catch(() => {}), 2000);
      } else {
        log.info({ orgId }, 'logged out, requires re-pairing');
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      const remote = m.key.remoteJid?.replace(/@.+/, '');
      if (!remote) continue;
      const list = entry.history.get(remote) || [];
      list.push({
        id: m.key.id,
        fromMe: m.key.fromMe,
        timestamp: Number(m.messageTimestamp) * 1000,
        text: m.message?.conversation || m.message?.extendedTextMessage?.text || ''
      });
      if (list.length > 50) list.splice(0, list.length - 50);
      entry.history.set(remote, list);
    }
  });

  return entry;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, sessions: sessions.size }));

app.get('/session/:orgId/status', async (req) => {
  const orgId = req.params.orgId;
  const s = sessions.get(orgId);
  if (!s) return { state: 'idle', phone: null };
  return { state: s.state, phone: s.phone };
});

app.get('/session/:orgId/qr', async (req) => {
  const orgId = req.params.orgId;
  const s = await getOrCreateSession(orgId);
  return { qr: s.qr, state: s.state };
});

app.post('/session/:orgId/start', async (req) => {
  const orgId = req.params.orgId;
  const s = await getOrCreateSession(orgId);
  return { state: s.state, phone: s.phone };
});

app.post('/session/:orgId/logout', async (req, reply) => {
  const orgId = req.params.orgId;
  const s = sessions.get(orgId);
  if (!s) return { ok: true, message: 'no active session' };
  try {
    await s.sock.logout();
  } catch (e) {
    log.warn({ orgId, err: e?.message }, 'logout error');
  }
  sessions.delete(orgId);
  return { ok: true };
});

app.post('/session/:orgId/send', async (req, reply) => {
  const orgId = req.params.orgId;
  const { phone, text } = req.body || {};
  if (!phone || !text) {
    reply.code(400);
    return { error: 'phone and text are required' };
  }
  const s = sessions.get(orgId);
  if (!s || s.state !== 'open') {
    reply.code(409);
    return { error: 'session not open', state: s?.state || 'idle' };
  }
  const jid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  await s.sock.sendMessage(jid, { text });
  return { ok: true };
});

app.get('/session/:orgId/conversation', async (req) => {
  const orgId = req.params.orgId;
  const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
  const s = sessions.get(orgId);
  if (!s) return { messages: [] };
  return { messages: s.history.get(phone) || [] };
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  log.info(`Cierra WA Bridge listening on :${PORT}, session dir = ${SESSION_DIR}`);
});

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down…');
  for (const [orgId, s] of sessions) {
    try { s.sock?.end?.(); } catch {}
  }
  await app.close();
  process.exit(0);
});
