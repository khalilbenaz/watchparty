# 🎬 WatchParty

Regardez **Netflix** (ou n'importe quelle vidéo HTML5) **en synchro avec vos amis**, avec **chat** texte et **webcam** — sans passer par un store. Extension de navigateur chargée **hors Chrome Web Store** + relais temps réel **gratuit** sur Cloudflare Workers.

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="WatchParty" />
</p>

---

## ✨ Fonctionnalités

- ▶️ **Synchro de lecture** : play / pause / avance répercutés chez tous les participants, en temps réel.
- 💬 **Chat** texte intégré dans une barre latérale.
- 📷 **Webcam** : vidéo-chat WebRTC en mesh (bouton 📷), avec STUN + TURN gratuits pour traverser les NAT.
- 🔗 **Lien d'invitation** : un clic, un lien qui pointe **directement** vers la vidéo ; l'ami l'ouvre → une invite lui demande **confirmation** avant de rejoindre la salle.
- 🔁 **Reconnexion automatique** (backoff exponentiel) et **état initial** : un participant qui arrive (ou revient) reçoit la position et l'état lecture/pause courants.
- 🛡️ **Compatible Netflix** : pilote le lecteur via l'API interne de Netflix → **pas d'erreur M7375**.
- 🌐 Marche **hors réseau** (relais public) sur **Chrome, Edge, Vivaldi, Brave** (Chromium ≥ 116).

---

## ⚠️ Ce que WatchParty fait (et ne fait pas)

- ✅ **Synchronise la lecture** + chat + webcam.
- ❌ **Ne diffuse PAS ton écran/ta vidéo.** Chaque personne lit le flux depuis **son propre compte Netflix**. Tu ne peux pas faire regarder Netflix à quelqu'un qui n'est pas abonné (ce serait du partage d'écran — autre techno, et contraire aux CGU Netflix).

Donc ton ami doit : (1) avoir installé l'extension, (2) posséder un compte Netflix, (3) ouvrir ton lien → il atterrit sur le même titre, synchronisé.

---

## 🏗️ Architecture

```
extension/                Extension Manifest V3 (chargée en "unpacked")
  manifest.json
  config.js               URL du relais (SEULE constante SERVER)
  wp-core.js              Logique pure testée : synchro, invitation, backoff, horloge
  background.js           Service worker : WebSocket, reconnexion, état persisté (storage.session)
  content.js              UI sidebar, hook vidéo, chat, WebRTC, invite d'auto-join #wp=
  netflix-inject.js       Injecté en world:MAIN → pilote le lecteur Netflix via son API interne
  popup.html / popup.js   "Démarrer" → lien généré si une vidéo est détectée
  sidebar.css
  icons/

server/                   Relais temps réel sur Cloudflare
  src/worker.js           Worker + Durable Objects Room (WebSocket Hibernation) et Limiter
  src/protocol.js         Schéma des messages, pseudos, seau à jetons, Origin (logique pure)
  test/                   Vitest + @cloudflare/vitest-pool-workers (vrai runtime workerd)
  wrangler.toml

tests/                    Vitest (Node) sur extension/wp-core.js
scripts/build-zip.sh      Produit dist/watchparty-extension.zip (ignoré par git)
.github/workflows/ci.yml  Lint, tests, `wrangler deploy --dry-run`, zip
launch-*.sh               Lanceurs par navigateur (--load-extension)
```

### Choix techniques notables

- **WebSocket dans le service worker, pas le content script.** La CSP `connect-src` de Netflix bloque toute connexion ouverte depuis la page. Le service worker, lui, vit dans le contexte de l'extension → exempt de cette CSP. Le content script relaie via `chrome.runtime` ; un ping keepalive (20 s) garde la connexion chaude. Le worker MV3 pouvant être arrêté à tout moment, les connexions voulues sont persistées dans `chrome.storage.session` et reprises au réveil.
- **Pilotage Netflix via l'API interne.** Toucher l'élément `<video>` brut (surtout `currentTime`) déclenche l'anti-tamper de Netflix (**erreur M7375-1203**). On contrôle donc le lecteur via `netflix.appContext.state.playerApp.getAPI().videoPlayer` (play/pause/seek), depuis un script injecté en `world: "MAIN"`. Sur les autres sites, on manipule directement l'élément.
- **Relais = Worker + Durable Object** (pas Cloudflare Pages, qui ne sert que du statique). Une instance de Durable Object par salle, fan-out via WebSocket Hibernation. Classe SQLite → **plan gratuit**.
- **Synchro sans dérive de commandes.** Le serveur numérote chaque changement d'état (`v`) et garde le dernier état de lecture ; le heartbeat ne corrige que la position (il ne force jamais play/pause) ; l'anti-écho repose sur des attentes d'événements individuelles et non plus sur une fenêtre fixe de 700 ms (`wp-core.js`).
- **Lien d'invitation.** Il contient `#wp=<room>.<token>` (id de salle 128 bits + jeton HMAC). L'adresse du Worker reste dans `config.js`, pas dans le lien.

---

## 🚀 Installation

### 1. Déployer le relais sur Cloudflare (gratuit, une fois)

```bash
cd server
npm install
npx wrangler login                                   # connecte ton compte Cloudflare
openssl rand -base64 32 | npx wrangler secret put ROOM_SECRET   # secret HMAC (hors dépôt, ≥ 16 car.)
# édite wrangler.toml : ALLOWED_ORIGINS = "chrome-extension://<id de ton extension>"
npx wrangler deploy
```

- **`ROOM_SECRET` est obligatoire** : sans lui (ou trop court), le relais répond `503` sur toutes les routes. Il n'y a plus de secret de repli.
- **`ALLOWED_ORIGINS`** : l'ID de l'extension s'affiche sur `chrome://extensions` (mode développeur) une fois l'extension chargée (étape 2). Vide → `503`.

Tu obtiens une URL `https://watchparty-relay.<compte>.workers.dev`.
Reporte-la en **wss://** dans la **seule** constante de `extension/config.js` :

```js
globalThis.WP_CONFIG = { SERVER: "wss://watchparty-relay.<compte>.workers.dev" };
```

> Test local : `server/.dev.vars` (ignoré par git) avec `ROOM_SECRET=…` et `ALLOWED_ORIGINS=…`, puis `npx wrangler dev` et `SERVER: "ws://localhost:8787"`.

### 2. Charger l'extension (sans store)

1. Ouvre `chrome://extensions` (ou `brave://`, `vivaldi://`, `edge://extensions`).
2. Active **Mode développeur** (coin haut-droit).
3. **Charger l'extension décompressée** → choisis le dossier `extension/`.
4. Épingle l'icône 🎬.

**Sites supportés d'office** : Netflix, YouTube, Prime Video, Disney+ (le script de page y est déclaré). Sur tout autre site, le popup injecte le script **à la demande** quand tu cliques sur l'icône (permission `activeTab`) : l'extension n'a aucune permission d'hôte permanente.

> Les scripts `launch-<navigateur>.sh` lancent le navigateur avec l'extension chargée (`--load-extension`), pratique en dev mais **non persistant** : pour une install permanente, utilise « Charger l'extension décompressée ».

---

## ▶️ Utilisation

1. Ouvre une vidéo Netflix (`netflix.com/watch/...`) et **lance la lecture**.
2. Clique 🎬 → renseigne ton pseudo → **🎉 Démarrer la WatchParty**.
3. Le popup détecte la vidéo puis affiche **📋 Copier le lien à partager**.
4. Envoie le lien à ton ami (WhatsApp, etc.). Il l'ouvre → une invite « Rejoindre une WatchParty ? » apparaît ; il confirme et rejoint la salle.
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
| **Rien ne se connecte** | Vérifie le Worker : `curl https://watchparty-relay.<compte>.workers.dev` doit répondre. Un `503` signifie `ROOM_SECRET` ou `ALLOWED_ORIGINS` non configuré ; un `403` sur `/new` signifie que l'ID de l'extension n'est pas dans `ALLOWED_ORIGINS`. |
| **« Connexion perdue »** | Reconnexion automatique (1 s → 30 s, 10 tentatives). Après abandon, rouvre le lien d'invitation. |
| **429** | Limite de débit par IP (création de salle 6/min, connexions 30/min). Patiente. |

---

## 📦 Distribuer à un ami

- Génère l'archive avec `npm run build:zip` (→ `dist/watchparty-extension.zip`) ou télécharge l'artefact du workflow CI. Elle n'est plus versionnée dans le dépôt.
- L'ami le dézippe → « Charger l'extension décompressée ».
- Stores officiels gratuits alternatifs au Chrome Web Store : **Edge Add-ons** (Chromium, même code) et **Firefox Add-ons** (ajustements MV3). Chrome/Edge bloquent l'installation d'un `.crx` hors store par défaut.

---

## 🔒 Sécurité

Le relais est public ; le modèle de sécurité repose sur des mesures défensives :

- **Salles authentifiées par token HMAC.** Le Worker détient un secret (`ROOM_SECRET`, **hors dépôt**, obligatoire). Il *mint* chaque salle (`GET /new`) avec un id aléatoire 128 bits **et** un token HMAC-SHA256. Toute connexion WebSocket est refusée (`403`) si le token ne correspond pas.
- **Contrôle d'`Origin` — à comprendre honnêtement.** Le relais n'accepte que `chrome-extension://<id>` listé dans `ALLOWED_ORIGINS` (absence d'Origin, `null`, pages web : `403`). **Ce n'est pas une authentification** : un navigateur ne peut pas falsifier `Origin`, mais `curl` ou un script Node le fixent à la valeur de leur choix, et l'ID de l'extension est public. Cela bloque les pages web malveillantes, pas un attaquant qui écrit un client. Les vraies barrières hors navigateur sont le jeton HMAC, les limites de débit et la validation des messages ci-dessous.
- **Limites de débit.** Par IP : création de salle (5 puis 6/min) et connexions WebSocket (20 puis 30/min), via un Durable Object `Limiter` → `429`. Par connexion : seau à jetons (rafale 60, 20 msg/s), coupure `1008` après 20 messages refusés. (L'IP vient de `CF-Connecting-IP` ; derrière un NAT partagé, plusieurs utilisateurs partagent le quota.)
- **Messages validés côté serveur.** Schéma strict par type (`sync`, `chat`, `rtc`, `ping`), clés inconnues refusées, `seek` borné à 0–24 h, texte ≤ 500 caractères, SDP ≤ 20 Ko, trame ≤ 32 Kio (en octets). Le type `system` est réservé au serveur.
- **Identité attribuée par le serveur.** Identifiant de pair aléatoire et pseudo assaini/unique (`Alice (2)` si déjà pris) : un client ne peut ni usurper un pseudo ni forger le `from` d'un message WebRTC, qui n'est routé qu'à son destinataire.
- **Auto-join sur confirmation.** Un lien `#wp=` n'engage jamais la lecture de la page sans clic de l'utilisateur sur l'invite (Shadow DOM fermé, clic de confiance uniquement). Limite : un site hostile peut masquer ou recouvrir son propre DOM ; n'ouvre que des liens de personnes de confiance.
- **Permissions minimales.** `storage`, `activeTab`, `scripting` ; aucune permission d'hôte ; content script déclaré sur quatre sites seulement.
- **Pas d'injection.** Chat et pseudos en `textContent` ; identifiants de pairs validés par regex et jamais interpolés dans un sélecteur CSS.
- **Pilotage Netflix** : `postMessage` ciblé sur l'origine exacte + nonce. Le nonce est lisible par le JS de la page Netflix (il protège des autres frames/origines, pas d'un script de la page elle-même).

⚠️ Limites assumées : le relais reste ouvert à quiconque possède l'ID d'extension configuré et un lien ; la confidentialité d'une salle dépend de la confidentialité de son lien (jeton sans expiration) ; le jeton circule dans l'URL WebSocket (visible dans les journaux d'accès). La webcam transite en P2P (WebRTC), expose ton IP aux participants de la salle et utilise un TURN public tiers (OpenRelay) : n'invite que des personnes de confiance.

## 🧪 Développement

```bash
npm install && (cd server && npm install)
npm run lint          # ESLint
npm test              # logique de l'extension (Vitest, Node)
npm run test:server   # relais : Vitest dans le vrai runtime workerd
cd server && npx wrangler deploy --dry-run
```

Les dépendances de test du Worker (`@cloudflare/vitest-pool-workers`) embarquent un `miniflare` épinglé signalé par `npm audit` ; seules les dépendances de production (`npm audit --omit=dev`) sont vérifiées en CI.

## 📄 Licence

MIT — voir [LICENSE](LICENSE).

> Projet personnel à but éducatif. Respecte les CGU des services de streaming utilisés.
