// WatchParty — service worker
// Détient la WebSocket (contexte extension → exempt de la CSP de la page, donc
// fonctionne sur Netflix & co). Relaie les messages avec le content script via
// chrome.runtime. Une connexion par onglet.

const conns = {}; // tabId -> { ws, server, room, name }

function notify(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function closeConn(tabId) {
  const c = conns[tabId];
  if (c) { try { c.ws.close(); } catch (_) {} delete conns[tabId]; }
}

function connect(tabId, { server, room, name }) {
  closeConn(tabId);
  const url = `${server}?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
  let ws;
  try { ws = new WebSocket(url); }
  catch (_) { notify(tabId, { cmd: "wsstatus", open: false, error: "url" }); return; }

  conns[tabId] = { ws, server, room, name };
  ws.onopen = () => notify(tabId, { cmd: "wsstatus", open: true });
  ws.onclose = () => notify(tabId, { cmd: "wsstatus", open: false });
  ws.onerror = () => notify(tabId, { cmd: "wsstatus", open: false, error: "err" });
  ws.onmessage = ev => notify(tabId, { cmd: "ws", data: ev.data });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  if (msg.cmd === "connect") connect(tabId, msg);
  else if (msg.cmd === "send") {
    const c = conns[tabId];
    if (c && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(msg.payload)); } catch (_) {} }
  } else if (msg.cmd === "disconnect") closeConn(tabId);
});

chrome.tabs.onRemoved.addListener(closeConn);

// Keepalive : ping applicatif toutes les 20 s. Garde la WebSocket chaude ET
// empêche le service worker MV3 d'être tué (l'activité WS réarme le timer 30 s).
setInterval(() => {
  for (const id in conns) {
    const c = conns[id];
    if (c.ws.readyState === 1) { try { c.ws.send(JSON.stringify({ t: "ping" })); } catch (_) {} }
  }
}, 20000);
