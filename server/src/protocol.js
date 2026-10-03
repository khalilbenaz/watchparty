// WatchParty relay — logique pure du protocole (sans dépendance au runtime Workers).
// Tout ce qui est ici est testé unitairement : schéma des messages, pseudos,
// limite de débit, extrapolation de l'état de lecture, contrôle d'Origin.

export const LIMITS = {
  MAX_PEERS: 8,                 // participants max par salle
  MAX_MSG_BYTES: 32 * 1024,     // octets (et non caractères), SDP compris
  NAME_MAX: 32,
  CHAT_MAX: 500,
  SDP_MAX: 20000,
  CANDIDATE_MAX: 1024,
  TIME_MAX_S: 86400,            // 24 h : borne haute d'un seek
  // Limite de débit PAR CONNEXION : burst, puis perSec en régime établi.
  // Les candidats ICE arrivent en rafale à l'établissement d'un appel.
  RATE_BURST: 60,
  RATE_PER_SEC: 20,
  STRIKES_MAX: 20,              // messages refusés (invalides / hors débit) avant coupure
  STATE_MAX_AGE_MS: 30_000,     // au-delà, l'état « en lecture » n'est plus extrapolé
};

export const PEER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const SYNC_ACTIONS = new Set(["play", "pause", "seek", "heartbeat"]);

const fail = reason => ({ ok: false, reason });
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOnly = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const isStr = (v, max) => typeof v === "string" && v.length <= max;

// ---------- pseudos ----------
export function sanitizeName(raw) {
  const s = typeof raw === "string"
    // contrôles, séparateurs de ligne, marques bidi (usurpation visuelle)
    ? raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    : "";
  const t = s.trim().slice(0, LIMITS.NAME_MAX).trim();
  return t || "Anon";
}

export function uniqueName(name, takenNames) {
  const taken = new Set([...takenNames].map(n => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const cand = name.slice(0, LIMITS.NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

// ---------- validation des messages entrants ----------
// Renvoie un message RECONSTRUIT (seules les clés connues survivent). Le serveur
// ajoute lui-même `from` / `name` / `v` / `ts` : un client ne peut jamais les fixer.
export function validateClientMessage(raw) {
  if (typeof raw !== "string") return fail("binaire");
  let m;
  try { m = JSON.parse(raw); } catch (_) { return fail("json"); }
  if (!isObj(m)) return fail("format");
  switch (m.t) {
    case "ping": {
      if (!hasOnly(m, ["t", "c"])) return fail("cles");
      if (m.c !== undefined && !(Number.isFinite(m.c) && m.c >= 0)) return fail("ping");
      return { ok: true, msg: m.c === undefined ? { t: "ping" } : { t: "ping", c: m.c } };
    }
    case "chat": {
      if (!hasOnly(m, ["t", "text"])) return fail("cles");
      if (typeof m.text !== "string") return fail("chat");
      const text = m.text.trim();
      if (!text || text.length > LIMITS.CHAT_MAX) return fail("chat");
      return { ok: true, msg: { t: "chat", text } };
    }
    case "sync": {
      if (!hasOnly(m, ["t", "action", "time", "paused"])) return fail("cles");
      if (!SYNC_ACTIONS.has(m.action)) return fail("sync");
      if (typeof m.time !== "number" || !Number.isFinite(m.time) || m.time < 0 || m.time > LIMITS.TIME_MAX_S) return fail("sync");
      if (typeof m.paused !== "boolean") return fail("sync");
      return { ok: true, msg: { t: "sync", action: m.action, time: m.time, paused: m.paused } };
    }
    case "rtc":
      return validateRtc(m);
    default:
      // inclut "system", réservé au serveur
      return fail("type");
  }
}

function validateRtc(m) {
  if (!hasOnly(m, ["t", "sub", "to", "sdp", "candidate"])) return fail("cles");
  if (m.to !== undefined && !(typeof m.to === "string" && PEER_ID_RE.test(m.to))) return fail("rtc");
  if (m.sub === "hello") {
    if (m.sdp !== undefined || m.candidate !== undefined) return fail("rtc");
    const msg = { t: "rtc", sub: "hello" };
    if (m.to) msg.to = m.to;
    return { ok: true, msg };
  }
  if (!m.to) return fail("rtc");
  if (m.sub === "desc") {
    const s = m.sdp;
    if (m.candidate !== undefined || !isObj(s) || !hasOnly(s, ["type", "sdp"])) return fail("rtc");
    if (s.type !== "offer" && s.type !== "answer") return fail("rtc");
    if (!isStr(s.sdp, LIMITS.SDP_MAX)) return fail("rtc");
    return { ok: true, msg: { t: "rtc", sub: "desc", to: m.to, sdp: { type: s.type, sdp: s.sdp } } };
  }
  if (m.sub === "ice") {
    const c = m.candidate;
    if (m.sdp !== undefined) return fail("rtc");
    if (c === null) return { ok: true, msg: { t: "rtc", sub: "ice", to: m.to, candidate: null } };
    if (!isObj(c) || !hasOnly(c, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) return fail("rtc");
    if (!isStr(c.candidate, LIMITS.CANDIDATE_MAX)) return fail("rtc");
    if (c.sdpMid != null && !isStr(c.sdpMid, 64)) return fail("rtc");
    if (c.sdpMLineIndex != null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 256)) return fail("rtc");
    if (c.usernameFragment != null && !isStr(c.usernameFragment, 256)) return fail("rtc");
    return { ok: true, msg: { t: "rtc", sub: "ice", to: m.to, candidate: {
      candidate: c.candidate, sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null,
    } } };
  }
  return fail("rtc");
}

// ---------- limite de débit (seau à jetons) ----------
// Fonction pure : prend l'ancien seau, rend le nouveau. Sérialisable (attachement WS / storage DO).
export function consumeToken(bucket, now, { burst, perSec }) {
  let tokens = burst, ts = now;
  if (bucket && Number.isFinite(bucket.tokens) && Number.isFinite(bucket.ts)) {
    const dt = Math.max(0, now - bucket.ts) / 1000;   // horloge qui recule → pas de pénalité
    tokens = Math.min(burst, bucket.tokens + dt * perSec);
  }
  if (tokens >= 1) return { allowed: true, bucket: { tokens: tokens - 1, ts: now } };
  return { allowed: false, bucket: { tokens, ts: now } };
}

// ---------- état de lecture ----------
// last = { time, paused, at } (at = horloge serveur en ms). Renvoie l'état à
// l'instant `now`, ou null. Un état « en lecture » sans heartbeat récent est
// considéré comme périmé : on ne devine pas une position vieille de plusieurs minutes.
export function extrapolate(last, now) {
  if (!last) return null;
  if (last.paused) return { time: last.time, paused: true };
  const age = Math.max(0, now - last.at);
  if (age > LIMITS.STATE_MAX_AGE_MS) return { time: last.time, paused: true };
  return { time: Math.min(LIMITS.TIME_MAX_S, last.time + age / 1000), paused: false };
}

// ---------- Origin ----------
// ALLOWED_ORIGINS = "chrome-extension://<id>[,chrome-extension://<id2>]". Toute autre
// valeur (https://…, null, vide) est ignorée : liste vide → on refuse tout.
export function parseAllowedOrigins(str) {
  const set = new Set();
  if (typeof str !== "string") return set;
  for (const part of str.split(",")) {
    const o = part.trim();
    if (EXT_ORIGIN_RE.test(o)) set.add(o);
  }
  return set;
}

export function isAllowedOrigin(origin, allowedSet) {
  return typeof origin === "string" && allowedSet.has(origin);
}
