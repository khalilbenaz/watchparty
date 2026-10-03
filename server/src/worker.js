import { DurableObject } from "cloudflare:workers";
import {
  LIMITS, PEER_ID_RE, sanitizeName, uniqueName, validateClientMessage, consumeToken,
  extrapolate, parseAllowedOrigins, isAllowedOrigin,
} from "./protocol.js";

// WatchParty relay — Cloudflare Worker + Durable Object
// Une instance de Durable Object par salle. Fan-out via WebSocket Hibernation.
// Sécurité : chaque salle est "mintée" par le Worker avec un token HMAC signé
// par un secret (env.ROOM_SECRET, hors dépôt). Une connexion WS sans token
// valide est refusée → personne ne peut accéder à une salle sans le lien,
// et le token est infalsifiable même en lisant ce code source.
// L'en-tête Origin doit être `chrome-extension://<id>` configuré (ALLOWED_ORIGINS).
// ATTENTION : Origin n'est PAS une authentification. Un navigateur ne peut pas le
// falsifier, mais curl / un script Node le fixent librement. Les vraies barrières
// contre l'abus hors navigateur sont : le jeton HMAC, la limite de débit par IP
// (/new et connexions) et la limite de débit + validation par connexion.

const NEW_RATE = { burst: 5, perSec: 0.1 };   // /new : 5 d'un coup puis 6 / minute / IP
const WS_RATE = { burst: 20, perSec: 0.5 };   // connexions WS : 20 d'un coup puis 30 / minute / IP
const MIN_SECRET_LEN = 16;       // longueur minimale de ROOM_SECRET
const enc = new TextEncoder();

function b64url(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}
async function sign(secret, msg) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(msg));
  return b64url(mac);
}
async function verify(secret, msg, tokenB64) {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), fromB64url(tokenB64), enc.encode(msg));
  } catch (_) { return false; }
}
function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64url(a);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.last = null; // dernier état de lecture { time, paused, at, v } — `at` = horloge serveur
    // Le DO peut être évincé (hibernation) : on recharge l'état avant tout traitement.
    ctx.blockConcurrencyWhile(async () => { this.last = (await ctx.storage.get("last")) || null; });
  }

  openSockets() {
    return this.ctx.getWebSockets().filter(w => w.readyState === 1);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const peers = this.openSockets();
    if (peers.length >= LIMITS.MAX_PEERS) {
      return new Response("room full", { status: 403 });
    }

    // Identité attribuée PAR LE SERVEUR : id aléatoire, pseudo assaini et unique.
    const taken = peers.map(w => (w.deserializeAttachment() || {}).name).filter(Boolean);
    const name = uniqueName(sanitizeName(url.searchParams.get("name")), taken);
    const id = randomId().slice(0, 11);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, bucket: null, strikes: 0 });

    const now = Date.now();
    server.send(JSON.stringify({
      t: "welcome", id, name, now,
      peers: peers.map(w => { const a = w.deserializeAttachment() || {}; return { id: a.id, name: a.name }; }),
    }));
    const st = extrapolate(this.last, now);
    if (st) server.send(JSON.stringify({ t: "state", time: st.time, paused: st.paused, v: this.last.v, ts: now }));
    this.broadcast(server, { t: "system", event: "join", id, name, text: `${name} a rejoint` });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    const size = typeof message === "string" ? enc.encode(message).length : (message.byteLength || 0);
    if (size > LIMITS.MAX_MSG_BYTES) { try { ws.close(1009, "message too big"); } catch (_) {} return; }

    const now = Date.now();
    const rl = consumeToken(att.bucket, now, { burst: LIMITS.RATE_BURST, perSec: LIMITS.RATE_PER_SEC });
    att.bucket = rl.bucket;
    const v = rl.allowed ? validateClientMessage(message) : null;
    if (!rl.allowed || !v.ok) {
      att.strikes = (att.strikes || 0) + 1;
      ws.serializeAttachment(att);
      if (att.strikes >= LIMITS.STRIKES_MAX) { try { ws.close(1008, "abus"); } catch (_) {} }
      return;
    }
    ws.serializeAttachment(att);

    const m = v.msg;
    switch (m.t) {
      case "ping":
        ws.send(JSON.stringify({ t: "pong", c: m.c ?? null, s: now }));
        break;
      case "chat":
        this.broadcast(ws, { t: "chat", from: att.id, name: att.name, text: m.text });
        break;
      case "sync":
        await this.onSync(ws, att, m, now);
        break;
      case "rtc": {
        const out = { t: "rtc", sub: m.sub, from: att.id };
        if (m.to) out.to = m.to;
        if (m.sdp) out.sdp = m.sdp;
        if (m.candidate !== undefined) out.candidate = m.candidate;
        if (m.to) this.sendTo(m.to, out);
        else this.broadcast(ws, out);
        break;
      }
    }
  }

  async onSync(ws, att, m, now) {
    const last = this.last;
    if (m.action === "heartbeat") {
      // Un heartbeat ne change JAMAIS l'état lecture/pause : il ne fait que rafraîchir la
      // position d'une salle en lecture. Il est ignoré si la salle est (ou doit être) en pause.
      if (m.paused || (last && last.paused)) return;
      this.last = { time: m.time, paused: false, at: now, v: last ? last.v : 0 };
    } else {
      this.last = { time: m.time, paused: m.paused, at: now, v: (last ? last.v : 0) + 1 };
      await this.ctx.storage.put("last", this.last);
    }
    this.broadcast(ws, { t: "sync", action: m.action, time: m.time, paused: m.paused, from: att.id, v: this.last.v, ts: now });
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast(ws, { t: "system", event: "leave", id: att.id, name: att.name, text: `${att.name || "Quelqu'un"} est parti` });
    try { ws.close(); } catch (_) {}
  }

  webSocketError(ws) { try { ws.close(); } catch (_) {} }

  sendTo(id, obj) {
    const data = JSON.stringify(obj);
    for (const peer of this.openSockets()) {
      const a = peer.deserializeAttachment() || {};
      if (a.id === id) { try { peer.send(data); } catch (_) {} }
    }
  }

  broadcast(sender, obj) {
    const data = JSON.stringify(obj);
    for (const peer of this.openSockets()) {
      if (peer !== sender) { try { peer.send(data); } catch (_) {} }
    }
  }
}

// ---------- Limiteur de débit par clé (IP), un Durable Object par clé ----------
export class Limiter extends DurableObject {
  async hit({ burst, perSec }) {
    const stored = await this.ctx.storage.get("bucket");
    const { allowed, bucket } = consumeToken(stored, Date.now(), { burst, perSec });
    await this.ctx.storage.put("bucket", bucket);
    await this.ctx.storage.setAlarm(Date.now() + 3600_000); // purge après 1 h d'inactivité
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / perSec));
    return { allowed, retryAfter };
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

async function rateLimited(env, key, cfg) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const r = await stub.hit(cfg);
  return r.allowed ? null : new Response("trop de requêtes", { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Pas de secret → on ne sert RIEN (jamais de repli : un secret connu rendrait
    // tous les jetons forgeables par quiconque lit le dépôt).
    const secret = typeof env.ROOM_SECRET === "string" ? env.ROOM_SECRET.trim() : "";
    if (secret.length < MIN_SECRET_LEN) {
      return new Response("relais mal configuré : ROOM_SECRET manquant ou trop court", { status: 503 });
    }
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    if (allowedOrigins.size === 0) {
      return new Response("relais mal configuré : ALLOWED_ORIGINS (chrome-extension://<id>) manquant", { status: 503 });
    }
    const isWs = request.headers.get("Upgrade") === "websocket";
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // Mint d'une salle : renvoie {room, token signé}. Réservé à l'extension configurée.
    if (url.pathname === "/new") {
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin, allowedOrigins)) return new Response("forbidden", { status: 403 });
      const limited = await rateLimited(env, "new:" + ip, NEW_RATE);
      if (limited) return limited;
      const room = randomId();
      const token = await sign(secret, room);
      return new Response(JSON.stringify({ room, token }), {
        headers: { "content-type": "application/json", "Access-Control-Allow-Origin": origin, "Vary": "Origin" },
      });
    }

    if (!isWs) {
      return new Response("WatchParty relay ✓ — utilise l'extension pour créer une salle.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (!isAllowedOrigin(request.headers.get("Origin"), allowedOrigins)) return new Response("forbidden", { status: 403 });

    // Vérifie le token HMAC de la salle avant d'autoriser la connexion.
    const room = url.searchParams.get("room") || "";
    const token = url.searchParams.get("token") || "";
    if (!room || !(await verify(secret, room, token))) {
      return new Response("bad token", { status: 403 });
    }
    const limited = await rateLimited(env, "ws:" + ip, WS_RATE);
    if (limited) return limited;

    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  },
};
