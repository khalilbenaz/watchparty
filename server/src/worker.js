// WatchParty relay — Cloudflare Worker + Durable Object
// Une instance de Durable Object par salle. Fan-out des messages entre les
// participants via l'API WebSocket Hibernation (gratuit, sans coût quand idle).

const MAX_PEERS = 8;             // participants max par salle
const MAX_MSG = 64 * 1024;       // 64 Ko : large pour les SDP/ICE, bloque le flood

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

    // plafond de participants (anti-abus + protège le coût)
    if (this.state.getWebSockets().length >= MAX_PEERS) {
      return new Response("room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation : la DO peut s'endormir, les sockets survivent.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ name });

    // prévient les autres de l'arrivée
    this.broadcast(server, JSON.stringify({ t: "system", text: `${name} a rejoint` }));

    return new Response(null, { status: 101, webSocket: client });
  }

  // relais : on renvoie le message brut à tous les autres sockets de la salle
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

  webSocketError(ws) {
    try { ws.close(); } catch (_) {}
  }

  broadcast(sender, data) {
    for (const peer of this.state.getWebSockets()) {
      if (peer !== sender) {
        try { peer.send(data); } catch (_) {}
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WatchParty relay ✓ — connecte-toi en WebSocket avec ?room=CODE", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Seules les connexions venant d'une extension sont acceptées : une page web
    // a une Origin http(s) → on la refuse. Empêche tout site d'abuser du relais.
    const origin = request.headers.get("Origin") || "";
    if (/^https?:\/\//i.test(origin)) {
      return new Response("forbidden", { status: 403 });
    }

    const room = url.searchParams.get("room") || "lobby";
    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};
