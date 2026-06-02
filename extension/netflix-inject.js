// WatchParty — script injecté dans le MONDE PRINCIPAL de Netflix.
// Pilote le lecteur via l'API interne de Netflix (pas l'élément <video> brut),
// ce qui évite l'erreur anti-tamper M7375-1203.

(() => {
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds() || [];
      // privilégie la session de visionnage (pas une bande-annonce)
      const id = ids.find(x => x.includes("watch")) || ids[ids.length - 1];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (_) { return null; }
  }

  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== location.origin) return;
    if (!e.data || e.data.__wp !== "cmd") return;
    // le nonce doit correspondre à celui posé par notre content script
    if (e.data.n !== document.documentElement.dataset.wpn) return;
    const p = player();
    if (!p) return;
    try {
      if (e.data.action === "play") p.play();
      else if (e.data.action === "pause") p.pause();
      else if (e.data.action === "seek") p.seek(e.data.timeMs);
    } catch (_) {}
  });
})();
