// WatchParty — service worker
// Détient la WebSocket (contexte extension → exempt de la CSP de la page, donc
// fonctionne sur Netflix & co). Relaie les messages avec le content script via
// chrome.runtime. Une connexion par onglet.
//
// MV3 : ce worker peut être arrêté à tout moment. Les connexions voulues
// (salle, jeton, pseudo) sont donc persistées dans chrome.storage.session
// (mémoire, vidée à la fermeture du navigateur) et restaurées au réveil. La
// reconnexion automatique (backoff exponentiel) repart de cet état.

importScripts("config.js", "wp-core.js"); // SERVER vient de config.js, jamais d'un message

const KEY = "wp_conns";
const MAX_ATTEMPTS = 10;     // ~ 5 minutes de tentatives avant d'abandonner
const conns = {};            // tabId -> { room, token, name, ws, attempts, timer, gaveUp }

function notify(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function persist() {
  const out = {};
  for (const id in conns) out[id] = { room: conns[id].room, token: conns[id].token, name: conns[id].name };
  return chrome.storage.session.set({ [KEY]: out }).catch(() => {});
}

function closeConn(tabId) {
  const c = conns[tabId];
  if (!c) return;
  clearTimeout(c.timer);
  delete conns[tabId];                       // d'abord : onclose ne doit pas reprogrammer
  try { c.ws && c.ws.close(); } catch (_) {}
  persist();
}

function openSocket(tabId) {
  const c = conns[tabId];
  if (!c) return;
  clearTimeout(c.timer);
  c.timer = null;
  const url = `${WP_CONFIG.SERVER}?room=${encodeURIComponent(c.room)}&token=${encodeURIComponent(c.token)}&name=${encodeURIComponent(c.name)}`;
  let ws;
  try { ws = new WebSocket(url); }
  catch (_) { notify(tabId, { cmd: "wsstatus", open: false, error: "url", final: true }); return; }
  c.ws = ws;
  ws.onopen = () => { c.attempts = 0; notify(tabId, { cmd: "wsstatus", open: true }); };
  ws.onerror = () => notify(tabId, { cmd: "wsstatus", open: false, error: "err" });
  ws.onclose = () => {
    if (conns[tabId] !== c || c.ws !== ws) return;   // connexion remplacée ou fermée volontairement
    c.ws = null;
    scheduleReconnect(tabId);
  };
  ws.onmessage = ev => notify(tabId, { cmd: "ws", data: ev.data });
}

function scheduleReconnect(tabId) {
  const c = conns[tabId];
  if (!c) return;
  if (c.attempts >= MAX_ATTEMPTS) {
    c.gaveUp = true;
    notify(tabId, { cmd: "wsstatus", open: false, final: true });
    return;
  }
  const delay = WPCore.backoffDelay(c.attempts++);
  notify(tabId, { cmd: "wsstatus", open: false, retryIn: delay });
  c.timer = setTimeout(() => openSocket(tabId), delay);
}

function connect(tabId, { room, token, name }) {
  // le content script n'est pas digne de confiance pour le format : on revalide
  const inv = WPCore.parseInvite(`${room}.${token}`);
  if (!inv) { notify(tabId, { cmd: "wsstatus", open: false, error: "invite", final: true }); return; }
  closeConn(tabId);
  conns[tabId] = { room: inv.room, token: inv.token, name: WPCore.sanitizeName(name), ws: null, attempts: 0, timer: null, gaveUp: false };
  persist();
  openSocket(tabId);
}

// Restauration après un réveil du service worker.
const loaded = chrome.storage.session.get(KEY).then(r => {
  const saved = (r && r[KEY]) || {};
  for (const id in saved) {
    if (conns[id]) continue;
    conns[id] = { ...saved[id], ws: null, attempts: 0, timer: null, gaveUp: false };
    openSocket(Number(id));
  }
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  loaded.then(() => {
    const c = conns[tabId];
    if (msg.cmd === "connect") connect(tabId, msg);
    else if (msg.cmd === "send") {
      if (c && c.ws && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(msg.payload)); } catch (_) {} }
      return reply({ ok: !!(c && c.ws && c.ws.readyState === 1) });
    } else if (msg.cmd === "disconnect") closeConn(tabId);
    else if (msg.cmd === "keepalive") {
      // Le content script nous réveille toutes les 20 s : si une reconnexion était
      // en attente (timer perdu avec le worker), on la relance.
      if (c && !c.ws && !c.gaveUp && !c.timer) scheduleReconnect(tabId);
      return reply({ active: !!c, open: !!(c && c.ws && c.ws.readyState === 1) });
    } else if (msg.cmd === "resume") {
      // Page rechargée dans un onglet qui avait une salle : on rend la config pour reprendre.
      return reply(c ? { active: true, room: c.room, token: c.token, name: c.name } : { active: false });
    }
    reply({ ok: true });
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => loaded.then(() => closeConn(tabId)));

// Keepalive : ping applicatif toutes les 20 s (le serveur répond par un pong privé,
// qui sert aussi à mesurer le décalage d'horloge). L'activité WS réarme le timer
// d'inactivité du service worker (Chrome ≥ 116).
setInterval(() => {
  for (const id in conns) {
    const c = conns[id];
    if (c.ws && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify({ t: "ping", c: Date.now() })); } catch (_) {} }
  }
}, 20000);
