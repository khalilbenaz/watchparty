// WatchParty relay — Cloudflare Worker + Durable Object
// Une instance de Durable Object par salle. Fan-out via WebSocket Hibernation.
// Sécurité : chaque salle est "mintée" par le Worker avec un token HMAC signé
// par un secret (env.ROOM_SECRET, hors dépôt). Une connexion WS sans token
// valide est refusée → personne ne peut accéder à une salle sans le lien,
// et le token est infalsifiable même en lisant ce code source.

const MAX_PEERS = 8;             // participants max par salle
const MAX_MSG = 64 * 1024;       // 64 Ko : large pour les SDP/ICE, bloque le flood
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
    if (this.state.getWebSockets().length >= MAX_PEERS) {
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
    if (size > MAX_MSG) { try { ws.close(1009, "message too big"); } catch (_) {} return; }
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const webOrigin = /^https?:\/\//i.test(origin);     // une page web → refusée
    const secret = env.ROOM_SECRET || "dev-insecure-secret";

    // Mint d'une salle : renvoie {room, token signé}. Réservé aux extensions.
    if (url.pathname === "/new") {
      if (webOrigin) return new Response("forbidden", { status: 403 });
      const room = randomId();
      const token = await sign(secret, room);
      return new Response(JSON.stringify({ room, token }), {
        headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WatchParty relay ✓ — utilise l'extension pour créer une salle.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (webOrigin) return new Response("forbidden", { status: 403 });

    // Vérifie le token HMAC de la salle avant d'autoriser la connexion.
    const room = url.searchParams.get("room") || "";
    const token = url.searchParams.get("token") || "";
    if (!room || !(await verify(secret, room, token))) {
      return new Response("bad token", { status: 403 });
    }

    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  },
};
