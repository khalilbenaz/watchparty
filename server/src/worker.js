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

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Anon").slice(0, 32);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.state.getWebSockets().length >= LIMITS.MAX_PEERS) {
      return new Response("room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ name });
    this.broadcast(server, JSON.stringify({ t: "system", text: `${name} a rejoint` }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const size = typeof message === "string" ? message.length : (message.byteLength || 0);
    if (size > LIMITS.MAX_MSG_BYTES) { try { ws.close(1009, "message too big"); } catch (_) {} return; }
    this.broadcast(ws, message);
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast(ws, JSON.stringify({ t: "system", text: `${att.name || "Quelqu'un"} est parti` }));
    try { ws.close(); } catch (_) {}
  }

  webSocketError(ws) { try { ws.close(); } catch (_) {} }

  broadcast(sender, data) {
    for (const peer of this.state.getWebSockets()) {
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
