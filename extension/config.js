// WatchParty — configuration UNIQUE de l'extension (seul endroit où l'URL du relais apparaît).
// Pour utiliser ton propre relais : change SERVER, et ajoute l'ID de l'extension
// à ALLOWED_ORIGINS dans server/wrangler.toml (voir README).
globalThis.WP_CONFIG = {
  SERVER: "wss://watchparty-relay.khalilbenaz.workers.dev",
};
