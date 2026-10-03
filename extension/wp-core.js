// WatchParty — logique pure partagée (aucun accès à chrome.* ni au DOM).
// Chargée par le content script, le service worker (importScripts) et le popup,
// et testée sous Node (tests/core.test.js). Expose `WPCore` (ou module.exports).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WPCore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;     // 128 bits en base64url
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;    // HMAC-SHA256 en base64url
  const PEER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
  const NAME_MAX = 32;

  // Accepte un lien complet (…#wp=room.token) ou directement "room.token".
  function parseInvite(s) {
    if (typeof s !== "string") return null;
    const m = s.match(/#wp=([^&]+)/);
    let v = m ? m[1] : s.trim();
    try { v = decodeURIComponent(v); } catch (_) { return null; }
    const i = v.indexOf(".");
    if (i < 0) return null;
    const room = v.slice(0, i), token = v.slice(i + 1);
    return ROOM_RE.test(room) && TOKEN_RE.test(token) ? { room, token } : null;
  }

  function isPeerId(s) { return typeof s === "string" && PEER_ID_RE.test(s); }

  function sanitizeName(raw) {
    // eslint-disable-next-line no-control-regex -- on retire VOLONTAIREMENT les caractères de contrôle
    const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "") : "";
    return s.trim().slice(0, NAME_MAX).trim() || "Anon";
  }

  // Reconnexion : 1 s, 2 s, 4 s… plafonné à 30 s, avec ±25 % de gigue.
  function backoffDelay(attempt, rand = Math.random) {
    const base = Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)));
    return Math.round(base * (0.75 + 0.5 * rand()));
  }

  // Décalage d'horloge client/serveur (méthode NTP simplifiée) : on garde
  // l'échantillon au plus petit RTT, c'est le moins biaisé.
  function clockSample(prev, c, s, t1) {
    const rtt = t1 - c;
    if (!(rtt >= 0)) return prev;
    const offset = s - (c + rtt / 2);
    return !prev || rtt <= prev.rtt ? { offset, rtt } : prev;
  }

  // ---------- Contrôleur de synchro ----------
  // Remplace l'ancien drapeau `suppress` (fenêtre fixe de 700 ms, globale) :
  //  - ordre des messages par numéro de version `v` attribué par le serveur ;
  //  - anti-écho par ATTENTES individuelles : chaque commande appliquée à la vidéo
  //    n'attend que l'événement qu'elle provoque (type + cible), avec une
  //    péremption de 3 s. Un geste réel de l'utilisateur d'un autre type, ou un
  //    seek loin de la cible, n'est jamais avalé.
  //  - le heartbeat ne corrige que la dérive, il ne force jamais play/pause.
  function createSync(opts = {}) {
    const now = opts.now || Date.now;
    const TOL = opts.tolerance ?? 0.8;          // écart toléré avant un seek (s)
    const DRIFT = opts.drift ?? 1.0;            // écart de heartbeat avant correction (s)
    const TTL = opts.ttl ?? 3000;               // durée de vie d'une attente d'événement (ms)
    const MAX_LATENCY = 2000;                   // plafond de compensation (ms)
    let lastV = 0;
    let offset = 0;                             // horloge serveur − horloge locale (ms)
    let expected = [];                          // { type, target?, until }

    const transitMs = ts => (typeof ts === "number" ? Math.min(MAX_LATENCY, Math.max(0, now() + offset - ts)) : 0);

    function expect(type, target) { expected.push({ type, target, until: now() + TTL }); }

    return {
      setClockOffset(ms) { offset = ms; },

      // Message distant (`sync` ou `state`) + instantané local {time, paused}.
      // Renvoie les commandes à appliquer à la vidéo ; enregistre les événements attendus.
      onRemote(m, local) {
        const isState = m.t === "state";
        const isBeat = m.action === "heartbeat";
        const v = typeof m.v === "number" ? m.v : null;
        if (v !== null) {
          if (isBeat || isState ? v < lastV : v <= lastV) return [];
          if (!isBeat) lastV = Math.max(lastV, v);
        }
        const target = m.time + (m.paused ? 0 : transitMs(m.ts) / 1000);
        const far = Math.abs(local.time - target) > (isBeat ? DRIFT : TOL);
        const cmds = [];
        const seek = () => { cmds.push({ cmd: "seek", time: target }); expect("seeked", target); };
        if (isBeat) {
          if (!local.paused && far) seek();         // jamais de play/pause sur un heartbeat
          return cmds;
        }
        if (m.action === "seek") { if (far) seek(); return cmds; }
        if (far) seek();
        if (m.paused && !local.paused) { cmds.push({ cmd: "pause" }); expect("pause"); }
        else if (!m.paused && local.paused) { cmds.push({ cmd: "play" }); expect("play"); }
        return cmds;
      },

      // Événement natif de la <video> (play | pause | seeked). Renvoie le message à
      // émettre, ou null si l'événement est l'écho d'une commande distante.
      onLocalEvent(type, local) {
        const t = now();
        expected = expected.filter(e => e.until > t);
        const i = expected.findIndex(e => e.type === type && (e.target === undefined || Math.abs(local.time - e.target) <= 2));
        if (i >= 0) { expected.splice(i, 1); return null; }
        return { t: "sync", action: type === "seeked" ? "seek" : type, time: local.time, paused: local.paused };
      },

      heartbeat(local) {
        return local.paused ? null : { t: "sync", action: "heartbeat", time: local.time, paused: false };
      },
    };
  }

  return { parseInvite, isPeerId, sanitizeName, backoffDelay, clockSample, createSync, PEER_ID_RE };
});
