import { describe, it, expect } from "vitest";
import { exports } from "cloudflare:workers";

describe("relais — comportement de base", () => {
  it("fetch_sansUpgradeWebSocket_repondUneBanniere", async () => {
    const r = await exports.default.fetch("https://relay.test/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("WatchParty relay");
  });

  it("webSocket_tokenInvalide_est403", async () => {
    const r = await exports.default.fetch("https://relay.test/?room=abc&token=nimportequoi", {
      headers: { Upgrade: "websocket" },
    });
    expect(r.status).toBe(403);
  });
});
