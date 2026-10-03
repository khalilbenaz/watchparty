import { exports } from "cloudflare:workers";

export const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
let ipSeq = 0;
// Chaque appel simule une IP distincte pour ne pas déclencher la limite de /new.
export const freshIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

export async function mint(ip = freshIp()) {
  const r = await exports.default.fetch("https://relay.test/new", { headers: { Origin: ORIGIN, "CF-Connecting-IP": ip } });
  if (r.status !== 200) throw new Error("mint " + r.status);
  return r.json();
}

const open_ = [];
export function closeAll() { while (open_.length) { try { open_.pop().ws.close(); } catch (_) {} } }

// Ouvre une WebSocket sur la salle et collecte tout ce qui arrive.
export async function join({ room, token, name = "Alice", origin = ORIGIN, ip = freshIp() }) {
  const q = new URLSearchParams({ room, token, name });
  const res = await exports.default.fetch("https://relay.test/?" + q, {
    headers: { Upgrade: "websocket", Origin: origin, "CF-Connecting-IP": ip },
  });
  if (res.status !== 101) return { status: res.status, res };
  const ws = res.webSocket;
  ws.accept();
  const msgs = [];
  const waiters = [];
  let closed = null;
  ws.addEventListener("message", e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { m = { raw: e.data }; }
    msgs.push(m);
    for (const w of [...waiters]) w();
  });
  ws.addEventListener("close", e => { closed = { code: e.code }; for (const w of [...waiters]) w(); });
  const peer = {
    status: 101, ws, msgs,
    get closed() { return closed; },
    send: o => ws.send(typeof o === "string" ? o : JSON.stringify(o)),
    // attend le premier message (non encore consommé) vérifiant pred
    next(pred = () => true, ms = 2000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error("timeout, reçus: " + JSON.stringify(msgs))); }, ms);
        const check = () => {
          const i = msgs.findIndex(pred);
          if (i >= 0) { cleanup(); resolve(msgs.splice(i, 1)[0]); }
        };
        const cleanup = () => { clearTimeout(t); const k = waiters.indexOf(check); if (k >= 0) waiters.splice(k, 1); };
        waiters.push(check); check();
      });
    },
    waitClosed(ms = 2000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("pas fermée")), ms);
        const check = () => { if (closed) { clearTimeout(t); resolve(closed); } };
        waiters.push(check); check();
      });
    },
  };
  open_.push(peer);
  return peer;
}
export const isType = t => m => m.t === t;
