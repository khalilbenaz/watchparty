const $ = id => document.getElementById(id);
const SERVER = "wss://watchparty-relay.khalilbenaz.workers.dev";
let tab;

function randomRoom() {
  // id de salle = secret de ~100 bits → indevinable (impossible d'énumérer les salles)
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // sans caractères ambigus
  const a = new Uint8Array(20);
  crypto.getRandomValues(a);
  return Array.from(a, b => chars[b % chars.length]).join("");
}

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
      <input id="code" placeholder="code d'un ami" />
      <button class="ghost" id="join">Rejoindre</button>
    </div>
    <div id="out"></div>`;
  $("go").addEventListener("click", () => launch(randomRoom()));
  $("join").addEventListener("click", () => {
    const c = $("code").value.trim();
    if (c) launch(c);
  });
}

function sendStart(m) {
  chrome.tabs.sendMessage(tab.id, { cmd: "start", ...m }, () => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }, () => {
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

async function launch(room) {
  const name = $("name").value.trim() || "Anon";
  await chrome.storage.local.set({ name, room, server: SERVER });

  sendStart({ server: SERVER, room, name });

  // On ne génère le lien QUE si une vidéo est détectée/synchronisée sur la page.
  $("out").innerHTML = `<div class="hint" style="margin-top:10px">⏳ Détection de la vidéo en cours…</div>`;
  let tries = 0;
  const poll = async () => {
    const s = await getStatus();
    if (s && s.hasVideo) { showLink(room); return; }
    if (++tries > 14) {
      $("out").innerHTML =
        `<div class="hint" style="margin-top:10px">⚠️ Aucune vidéo détectée sur cette page.<br>Lance la lecture d'une vidéo, puis re-clique « Démarrer ».</div>`;
      return;
    }
    setTimeout(poll, 500);
  };
  poll();
}

function showLink(room) {
  // lien qui pointe DIRECTEMENT vers la vidéo courante + rejoint la salle.
  // Ne contient que l'id de salle — l'URL du serveur reste interne à l'extension.
  const link = tab.url.split("#")[0] + "#wp=" + encodeURIComponent(room);

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
