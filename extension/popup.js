const $ = id => document.getElementById(id);
const SERVER = WP_CONFIG.SERVER;            // défini une seule fois dans config.js
const HTTP = SERVER.replace(/^ws/, "http"); // wss→https
let tab;

// crée une salle signée côté serveur (token HMAC)
async function mintRoom() {
  const r = await fetch(HTTP + "/new");
  if (!r.ok) throw new Error("mint " + r.status);
  return r.json(); // { room, token }
}

const parseInvite = WPCore.parseInvite; // lien complet (…#wp=room.token) ou "room.token"

async function init() {
  const v = await chrome.storage.local.get(["name"]);
  if (v.name) $("name").value = v.name;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  const onPage = /^https?:/.test(url);

  if (!onPage) {
    $("main").innerHTML =
      `<div class="hint">▶️ Ouvre d'abord une vidéo (Netflix, YouTube, Prime…) dans cet onglet, lance la lecture, puis rouvre WatchParty pour partager le lien.</div>`;
    return;
  }
  renderStart();
}

function renderStart() {
  $("main").innerHTML = `
    <button class="primary big" id="go">🎉 Démarrer la WatchParty</button>
    <div class="sep">— ou rejoindre —</div>
    <div class="row">
      <input id="code" placeholder="lien reçu d'un ami" />
      <button class="ghost" id="join">Rejoindre</button>
    </div>
    <div id="out"></div>`;
  $("go").addEventListener("click", createParty);
  $("join").addEventListener("click", () => {
    const inv = parseInvite($("code").value.trim());
    if (inv) launch(inv.room, inv.token);
    else { $("out").textContent = "Lien invalide."; $("out").className = "hint"; }
  });
}

async function createParty() {
  $("out").textContent = "⏳ Création de la salle…"; $("out").className = "hint";
  let info;
  try { info = await mintRoom(); }
  catch (_) { $("out").textContent = "❌ Serveur injoignable."; return; }
  launch(info.room, info.token);
}

function sendStart(m) {
  // m = { room, token, name } — l'URL du relais reste dans config.js
  chrome.tabs.sendMessage(tab.id, { cmd: "start", ...m }, () => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["wp-core.js", "content.js"] }, () => {
        chrome.tabs.sendMessage(tab.id, { cmd: "start", ...m });
      });
    }
  });
}

function getStatus() {
  return new Promise(res => {
    chrome.tabs.sendMessage(tab.id, { cmd: "status" }, r => {
      res(chrome.runtime.lastError ? null : r);
    });
  });
}

async function launch(room, token) {
  const name = $("name").value.trim() || "Anon";
  await chrome.storage.local.set({ name });

  sendStart({ room, token, name });

  // On ne génère le lien QUE si une vidéo est détectée/synchronisée sur la page.
  $("out").textContent = "⏳ Détection de la vidéo en cours…"; $("out").className = "hint";
  let tries = 0;
  const poll = async () => {
    const s = await getStatus();
    if (s && s.hasVideo) { showLink(room, token); return; }
    if (++tries > 14) {
      $("out").textContent = "⚠️ Aucune vidéo détectée. Lance la lecture d'une vidéo, puis re-clique « Démarrer ».";
      return;
    }
    setTimeout(poll, 500);
  };
  poll();
}

function showLink(room, token) {
  $("out").className = "";
  // lien qui pointe DIRECTEMENT vers la vidéo courante + rejoint la salle.
  // Contient l'id + token signé — l'URL du serveur reste interne à l'extension.
  const link = tab.url.split("#")[0] + "#wp=" + encodeURIComponent(room + "." + token);

  // Construction DOM (pas d'innerHTML interpolé) → aucune injection possible
  // depuis l'URL de la page ou un code de salle piégé.
  const out = $("out");
  out.textContent = "";

  const ok = document.createElement("div");
  ok.className = "ok"; ok.style.marginTop = "10px";
  ok.textContent = "✓ Vidéo synchronisée";

  const btn = document.createElement("button");
  btn.className = "primary"; btn.style.cssText = "width:100%;margin-top:8px";
  btn.textContent = "📋 Copier le lien à partager";

  const lk = document.createElement("div");
  lk.className = "hint"; lk.style.marginTop = "6px";
  lk.textContent = link;

  out.append(ok, btn, lk);
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(link)
      .then(() => { btn.textContent = "✓ Lien copié — envoie-le à tes amis !"; })
      .catch(() => { btn.textContent = "Copie manuelle ci-dessous ⬇"; });
  });
}

init();
