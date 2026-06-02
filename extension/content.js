// WatchParty — content script
// Ne tient PLUS la WebSocket (bloquée par la CSP de Netflix). Elle vit dans le
// service worker ; on échange via chrome.runtime. Hooke la vidéo, le chat, la webcam.

(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;

  const SERVER = "wss://watchparty-relay.khalilbenaz.workers.dev"; // figé, jamais exposé dans l'UI
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);
  let connected = false;
  let video = null;
  let suppress = false;       // ignore les events vidéo qu'on déclenche nous-mêmes
  let cfg = { server: SERVER, room: "", token: "", name: "Anon" };
  let ui = null;
  let watching = false;       // watchForVideo déjà lancé ?

  // WebRTC (webcam)
  const ICE = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // TURN public gratuit (OpenRelay / metered.ca) — pour traverser les NAT symétriques
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ] };
  const myId = Math.random().toString(36).slice(2, 10);
  const peers = {};          // remoteId -> { pc, polite, makingOffer }
  let localStream = null;
  let dead = false;          // contexte d'extension invalidé (après reload) ?
  const intervals = [];

  // ---------- transport (via service worker) ----------
  // chrome.runtime.* lève une erreur SYNCHRONE quand l'extension a été rechargée
  // ("Extension context invalidated") → on garde + on s'auto-désactive proprement.
  function alive() {
    try { return !dead && !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function teardown() {
    if (dead) return;
    dead = true; connected = false;
    try { if (video) ["play", "pause", "seeked"].forEach(ev => video.removeEventListener(ev, onLocalEvent)); } catch (_) {}
    intervals.forEach(id => { try { clearInterval(id); } catch (_) {} });
    try { if (ui) ui.remove(); } catch (_) {}
  }

  function rt(msg, cb) {
    if (!alive()) { teardown(); return; }
    try { chrome.runtime.sendMessage(msg, cb || (() => void chrome.runtime.lastError)); }
    catch (_) { teardown(); }
  }

  function send(obj) {
    if (!connected) return;
    rt({ cmd: "send", payload: obj });
  }

  function handleData(raw) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.t === "ping") return;
    if (m.t === "sync") applyRemote(m);
    else if (m.t === "chat") addChat(m.name, m.text, false);
    else if (m.t === "system") sys(m.text);
    else if (m.t === "rtc") onRtc(m);
  }

  // ---------- VIDEO ----------
  function findVideo() {
    const vids = [...document.querySelectorAll("video")].filter(v => v.readyState > 0 || v.src || v.currentSrc);
    if (!vids.length) return null;
    return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  function bindVideo(v) {
    if (!v || v === video) return;
    video = v;
    ["play", "pause", "seeked"].forEach(ev => v.addEventListener(ev, onLocalEvent));
    sys("Vidéo détectée et synchronisée.");
  }

  function onLocalEvent(e) {
    if (suppress || !connected || !video) return;
    send({ t: "sync", action: e.type, time: video.currentTime, paused: video.paused });
  }

  // Pilotage : sur Netflix via l'API interne (anti-M7375), ailleurs via l'élément.
  // nonce partagé avec le script MAIN via un data-attribut + postMessage ciblé sur
  // l'origine exacte → rejette les messages forgés depuis une autre frame/origine.
  const WP_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
  if (isNetflix) { try { document.documentElement.dataset.wpn = WP_NONCE; } catch (_) {} }
  function nfx(action, timeMs) { window.postMessage({ __wp: "cmd", n: WP_NONCE, action, timeMs }, location.origin); }
  function ctrlPlay()  { if (isNetflix) nfx("play");  else if (video) video.play().catch(() => {}); }
  function ctrlPause() { if (isNetflix) nfx("pause"); else if (video) video.pause(); }
  function ctrlSeek(t) {
    if (video && Math.abs(video.currentTime - t) < 0.8) return; // déjà aligné
    if (isNetflix) nfx("seek", Math.round(t * 1000));
    else if (video) video.currentTime = t;
  }

  function applyRemote(m) {
    if (!video) { bindVideo(findVideo()); if (!video) return; }
    suppress = true;
    try {
      if (typeof m.time === "number") ctrlSeek(m.time);
      if (m.action === "pause" || m.paused === true) ctrlPause();
      else if (m.action === "play" || m.paused === false) ctrlPlay();
    } catch (_) {}
    setTimeout(() => { suppress = false; }, 700);
  }

  function watchForVideo() {
    if (watching) return;
    watching = true;
    bindVideo(findVideo());
    const obs = new MutationObserver(() => { if (!video) bindVideo(findVideo()); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // filet : retente quelques secondes (lecteurs lazy comme Netflix)
    let tries = 0;
    const iv = setInterval(() => {
      if (video || ++tries > 40) return clearInterval(iv);
      bindVideo(findVideo());
    }, 500);
    intervals.push(iv);
    // resync léger anti-drift
    intervals.push(setInterval(() => {
      if (video && !video.paused && connected) {
        send({ t: "sync", action: "heartbeat", time: video.currentTime, paused: video.paused });
      }
    }, 5000));
  }

  function connect() {
    sys(`Connexion à la salle « ${cfg.room} »…`);
    rt({ cmd: "connect", server: cfg.server || SERVER, room: cfg.room, token: cfg.token, name: cfg.name });
  }

  function start(config) {
    cfg = { ...cfg, ...config };
    if (!ui) buildUI();
    ui.style.display = "flex";
    ui.querySelector("#wp-room").textContent = "salle " + cfg.room.slice(0, 6) + "…";
    connect();
    watchForVideo();
  }

  // ---------- UI (chat sidebar) ----------
  function buildUI() {
    ui = document.createElement("div");
    ui.id = "wp-root";
    ui.innerHTML = `
      <div id="wp-header">
        <span id="wp-dot"></span>
        <span id="wp-title">WatchParty</span>
        <span id="wp-room"></span>
        <button id="wp-share" title="Copier le lien d'invitation">🔗</button>
        <button id="wp-cam" title="Activer la webcam">📷</button>
        <button id="wp-min" title="Réduire">—</button>
      </div>
      <div id="wp-cams" class="wp-empty"></div>
      <div id="wp-messages"></div>
      <form id="wp-form">
        <input id="wp-input" autocomplete="off" placeholder="Message…" />
        <button type="submit">↑</button>
      </form>`;
    document.body.appendChild(ui);
    ui.querySelector("#wp-room").textContent = "salle " + cfg.room.slice(0, 6) + "…";
    ui.querySelector("#wp-form").addEventListener("submit", e => {
      e.preventDefault();
      const inp = ui.querySelector("#wp-input");
      const text = inp.value.trim();
      if (!text) return;
      addChat(cfg.name, text, true);
      send({ t: "chat", name: cfg.name, text });
      inp.value = "";
    });
    ui.querySelector("#wp-min").addEventListener("click", () => ui.classList.toggle("wp-collapsed"));
    ui.querySelector("#wp-cam").addEventListener("click", toggleCam);
    ui.querySelector("#wp-share").addEventListener("click", shareLink);
  }

  function shareLink() {
    if (!video && !findVideo()) { sys("⚠️ Aucune vidéo synchronisée — lance la lecture d'abord."); return; }
    const base = location.href.split("#")[0];
    const link = /^https?:/.test(base) ? `${base}#wp=${encodeURIComponent(cfg.room)}` : "";
    const text = link || cfg.room;
    navigator.clipboard.writeText(text)
      .then(() => sys(link ? "🔗 Lien d'invitation copié — colle-le dans l'autre navigateur." : `Code copié : ${cfg.room}`))
      .catch(() => sys((link ? "Lien : " : "Code : ") + text));
  }

  function addChat(name, text, mine) {
    if (!ui) return;
    const box = ui.querySelector("#wp-messages");
    const el = document.createElement("div");
    el.className = "wp-msg" + (mine ? " wp-mine" : "");
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector("b").textContent = name;
    el.querySelector("span").textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function sys(text) {
    if (!ui) return;
    const box = ui.querySelector("#wp-messages");
    const el = document.createElement("div");
    el.className = "wp-sys";
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function setStatus(ok) {
    if (ui) ui.querySelector("#wp-dot").className = ok ? "wp-on" : "wp-off";
  }

  // ---------- WEBRTC (webcam, mesh + perfect negotiation) ----------
  function ensurePeer(id) {
    if (peers[id]) return peers[id];
    const pc = new RTCPeerConnection(ICE);
    const p = { pc, polite: myId < id, makingOffer: false };
    peers[id] = p;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ t: "rtc", sub: "ice", from: myId, to: id, candidate });
    };
    pc.ontrack = ({ streams }) => showCam(id, streams[0], false);
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) removeCam(id);
    };
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: "rtc", sub: "desc", from: myId, to: id, sdp: pc.localDescription });
      } catch (_) {} finally { p.makingOffer = false; }
    };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    return p;
  }

  async function onRtc(m) {
    if (m.from === myId) return;
    if (m.to && m.to !== myId) return;
    if (m.sub === "hello") {
      ensurePeer(m.from);
      if (!m.to) send({ t: "rtc", sub: "hello", from: myId, to: m.from });
      return;
    }
    const p = ensurePeer(m.from), pc = p.pc;
    try {
      if (m.sub === "desc") {
        const collision = m.sdp.type === "offer" && (p.makingOffer || pc.signalingState !== "stable");
        if (!p.polite && collision) return;
        await pc.setRemoteDescription(m.sdp);
        if (m.sdp.type === "offer") {
          await pc.setLocalDescription();
          send({ t: "rtc", sub: "desc", from: myId, to: m.from, sdp: pc.localDescription });
        }
      } else if (m.sub === "ice") {
        try { await pc.addIceCandidate(m.candidate); } catch (_) {}
      }
    } catch (_) {}
  }

  async function toggleCam() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      removeCam(myId);
      for (const id in peers) peers[id].pc.getSenders().forEach(s => { try { peers[id].pc.removeTrack(s); } catch (_) {} });
      camBtn().classList.remove("wp-active");
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (_) { sys("Accès caméra/micro refusé."); return; }
    showCam(myId, localStream, true);
    camBtn().classList.add("wp-active");
    for (const id in peers) localStream.getTracks().forEach(t => peers[id].pc.addTrack(t, localStream));
    send({ t: "rtc", sub: "hello", from: myId });
  }

  function camBtn() { return ui && ui.querySelector("#wp-cam"); }

  function showCam(id, stream, mine) {
    if (!ui) return;
    const grid = ui.querySelector("#wp-cams");
    let tile = grid.querySelector(`[data-id="${id}"]`);
    if (!tile) {
      tile = document.createElement("video");
      tile.dataset.id = id;
      tile.autoplay = true; tile.playsInline = true;
      if (mine) tile.muted = true;
      grid.appendChild(tile);
    }
    tile.srcObject = stream;
    grid.classList.remove("wp-empty");
  }

  function removeCam(id) {
    if (peers[id]) { try { peers[id].pc.close(); } catch (_) {} delete peers[id]; }
    if (!ui) return;
    const tile = ui.querySelector(`#wp-cams [data-id="${id}"]`);
    if (tile) tile.remove();
    const grid = ui.querySelector("#wp-cams");
    if (grid && !grid.children.length) grid.classList.add("wp-empty");
  }

  // ---------- messages (popup + service worker) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.cmd === "start") { start(msg); reply && reply({ ok: true }); }
    else if (msg.cmd === "ws") handleData(msg.data);
    else if (msg.cmd === "wsstatus") {
      connected = !!msg.open;
      setStatus(connected);
      if (connected) {
        sys("Connecté ✓ — en attente d'un autre participant…");
        send({ t: "rtc", sub: "hello", from: myId }); // découverte webcam
      } else if (msg.error) {
        sys("Connexion au serveur impossible.");
      }
    } else if (msg.cmd === "status") {
      reply && reply({ connected, room: cfg.room, hasVideo: !!(video || findVideo()) });
    }
    return true;
  });

  // ---------- AUTO-JOIN via lien d'invitation (#wp=...) ----------
  (function tryAutoJoin() {
    const m = location.hash.match(/[#&]wp=([^&]+)/);
    if (!m) return;
    let v = m[1];
    try { v = decodeURIComponent(v); } catch (_) {}
    const i = v.indexOf(".");
    if (i < 0) return;                       // format attendu : room.token
    const room = v.slice(0, i), token = v.slice(i + 1);
    if (!room || !token || !alive()) return;
    try {
      chrome.storage.local.get(["name"], info => {
        if (chrome.runtime.lastError) return;
        const name = (info && info.name) || "Invité" + Math.floor(Math.random() * 100);
        start({ server: SERVER, room, token, name });
      });
    } catch (_) {}
  })();
})();
