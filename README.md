# 🎬 WatchParty

Regardez **Netflix** (ou n'importe quelle vidéo HTML5) **en synchro avec vos amis**, avec **chat** texte et **webcam** — façon Teleparty / Scener. Extension de navigateur chargée **hors Chrome Web Store** + relais temps réel **gratuit** sur Cloudflare Workers.

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="WatchParty" />
</p>

---

## ✨ Fonctionnalités

- ▶️ **Synchro de lecture** : play / pause / avance répercutés chez tous les participants, en temps réel.
- 💬 **Chat** texte intégré dans une barre latérale.
- 📷 **Webcam** : vidéo-chat WebRTC en mesh (bouton 📷), avec STUN + TURN gratuits pour traverser les NAT.
- 🔗 **Lien d'invitation Teleparty-like** : un clic, un lien qui pointe **directement** vers la vidéo ; l'ami l'ouvre → il rejoint la salle automatiquement.
- 🛡️ **Compatible Netflix** : pilote le lecteur via l'API interne de Netflix → **pas d'erreur M7375**.
- 🌐 Marche **hors réseau** (relais public) sur **Chrome, Edge, Vivaldi, Brave** (Chromium ≥ 111).

---

## ⚠️ Ce que WatchParty fait (et ne fait pas)

- ✅ **Synchronise la lecture** + chat + webcam.
- ❌ **Ne diffuse PAS ton écran/ta vidéo.** Comme Teleparty, chaque personne lit le flux depuis **son propre compte Netflix**. Tu ne peux pas faire regarder Netflix à quelqu'un qui n'est pas abonné (ce serait du partage d'écran — autre techno, et contraire aux CGU Netflix).

Donc ton ami doit : (1) avoir installé l'extension, (2) posséder un compte Netflix, (3) ouvrir ton lien → il atterrit sur le même titre, synchronisé.

---

## 🏗️ Architecture

```
extension/                Extension Manifest V3 (chargée en "unpacked")
  manifest.json
  background.js           Service worker : détient la WebSocket (exempt de la CSP des pages)
  content.js              UI sidebar, hook vidéo, chat, WebRTC, auto-join #wp=
  netflix-inject.js       Injecté en world:MAIN → pilote le lecteur Netflix via son API interne
  popup.html / popup.js   Flow Teleparty : "Démarrer" → lien généré si une vidéo est détectée
  sidebar.css
  icons/

server/                   Relais temps réel sur Cloudflare
  src/worker.js           Worker + Durable Object "Room" (WebSocket Hibernation)
  wrangler.toml
  package.json

launch-*.sh               Lanceurs par navigateur (--load-extension)
watchparty-extension.zip  Build prêt à partager
```

### Choix techniques notables

- **WebSocket dans le service worker, pas le content script.** La CSP `connect-src` de Netflix bloque toute connexion ouverte depuis la page. Le service worker, lui, vit dans le contexte de l'extension → exempt de cette CSP. Le content script relaie via `chrome.runtime` ; un ping keepalive (20 s) garde le worker vivant.
- **Pilotage Netflix via l'API interne.** Toucher l'élément `<video>` brut (surtout `currentTime`) déclenche l'anti-tamper de Netflix (**erreur M7375-1203**). On contrôle donc le lecteur via `netflix.appContext.state.playerApp.getAPI().videoPlayer` (play/pause/seek), depuis un script injecté en `world: "MAIN"`. Sur les autres sites, on manipule directement l'élément.
- **Relais = Worker + Durable Object** (pas Cloudflare Pages, qui ne sert que du statique). Une instance de Durable Object par salle, fan-out via WebSocket Hibernation. Classe SQLite → **plan gratuit**.
- **URL du serveur jamais exposée.** Le lien d'invitation ne contient que le **code de salle** (`…/watch/12345#wp=salon407`) ; l'adresse du Worker est une constante interne.

---

## 🚀 Installation

### 1. Déployer le relais sur Cloudflare (gratuit, une fois)

```bash
cd server
npm install
npx wrangler login                                   # connecte ton compte Cloudflare
openssl rand -base64 32 | npx wrangler secret put ROOM_SECRET   # secret HMAC (hors dépôt)
npx wrangler deploy
```

Tu obtiens une URL `https://watchparty-relay.<compte>.workers.dev`.
Reporte-la en **wss://** dans la constante `SERVER` de `extension/content.js` **et** `extension/popup.js` :

```js
const SERVER = "wss://watchparty-relay.<compte>.workers.dev";
```

> Test local : `npx wrangler dev` puis `SERVER = "ws://localhost:8787"`.

### 2. Charger l'extension (sans store)

1. Ouvre `chrome://extensions` (ou `brave://`, `vivaldi://`, `edge://extensions`).
2. Active **Mode développeur** (coin haut-droit).
3. **Charger l'extension décompressée** → choisis le dossier `extension/`.
4. Épingle l'icône 🎬.

> Les scripts `launch-<navigateur>.sh` lancent le navigateur avec l'extension chargée (`--load-extension`), pratique en dev mais **non persistant** : pour une install permanente, utilise « Charger l'extension décompressée ».

---

## ▶️ Utilisation

1. Ouvre une vidéo Netflix (`netflix.com/watch/...`) et **lance la lecture**.
2. Clique 🎬 → renseigne ton pseudo → **🎉 Démarrer la WatchParty**.
3. Le popup détecte la vidéo puis affiche **📋 Copier le lien à partager**.
4. Envoie le lien à ton ami (WhatsApp, etc.). Il l'ouvre → il rejoint la salle automatiquement.
5. Bouton **📷** dans la barre latérale pour activer la webcam, **🔗** pour re-copier le lien.

Le point 🟢 dans la barre = connecté. Un message « … a rejoint » confirme l'arrivée d'un participant.

---

## 🩺 Dépannage

| Problème | Cause / Solution |
|---|---|
| **Erreur Netflix M7375-1203** | Anti-tamper Netflix. Recharge l'extension **puis fais F5** sur l'onglet Netflix pour que `netflix-inject.js` (world MAIN) s'injecte au chargement. |
| **« Extension context invalidated »** | L'ancien content script tourne encore après un reload. **Rafraîchis l'onglet (F5)** après chaque rechargement de l'extension. |
| **Pas de bouton « Copier le lien »** | Le lien n'est généré que si une vidéo est détectée. Lance la lecture puis re-clique « Démarrer ». |
| **Play/pause non synchronisé** | Les deux navigateurs doivent être dans la **même salle**. Ne clique pas « Créer » des deux côtés : ouvre le lien d'invitation, ou « Rejoindre » avec le même code. |
| **Webcam KO derrière un NAT strict** | STUN/TURN OpenRelay public inclus. Pour un cas vraiment fermé, ajoute ton propre TURN dans `ICE.iceServers` (`content.js`). |
| **Rien ne se connecte** | Vérifie le Worker : `curl https://watchparty-relay.<compte>.workers.dev` doit répondre. |

---

## 📦 Distribuer à un ami

- Zippe le dossier `extension/` (ou utilise `watchparty-extension.zip`).
- L'ami le dézippe → « Charger l'extension décompressée ».
- Stores officiels gratuits alternatifs au Chrome Web Store : **Edge Add-ons** (Chromium, même code) et **Firefox Add-ons** (ajustements MV3). Chrome/Edge bloquent l'installation d'un `.crx` hors store par défaut.

---

## 🔒 Sécurité

Le relais est public ; le modèle de sécurité repose sur des mesures défensives :

- **Salles authentifiées par token HMAC.** Le Worker détient un secret (`ROOM_SECRET`, **hors dépôt**, posé via `wrangler secret put`). Il *mint* chaque salle (`GET /new`) avec un id aléatoire 128 bits **et** un token signé HMAC-SHA256. Toute connexion WebSocket est refusée (`403`) si le token ne correspond pas — **infalsifiable même en lisant ce code** (vérifié en test). Le lien d'invitation porte `room.token`.
- **Relais réservé aux extensions.** Le Worker refuse (`403`) toute connexion dont l'`Origin` est `http(s)://` → aucun site web ne peut abuser du relais (vérifié en test).
- **Plafonds anti-abus.** Max 8 participants/salle, messages ≤ 64 Ko, pseudo ≤ 32 caractères.
- **Pas d'injection.** Le popup construit son DOM via `textContent` (jamais d'`innerHTML` interpolé avec l'URL de la page ou un code saisi). Le chat affiche les messages en `textContent`.
- **URL du serveur masquée** dans l'UI et les liens (constante interne).
- **Pilotage Netflix isolé** : `postMessage` ciblé sur l'origine exacte + nonce partagé.

⚠️ Limites assumées : le relais reste ouvert à toute extension (pas d'authentification de compte) ; la confidentialité d'une salle dépend de la confidentialité de son lien. La webcam transite en P2P (WebRTC) et expose ton IP aux participants de la salle — n'invite que des personnes de confiance.

## 📄 Licence

MIT — voir [LICENSE](LICENSE).

> Projet personnel à but éducatif. Respecte les CGU des services de streaming utilisés.
