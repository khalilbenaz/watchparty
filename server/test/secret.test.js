import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/worker.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("ROOM_SECRET obligatoire", () => {
  for (const secret of [undefined, "", "   ", "trop-court"]) {
    it(`fetch_secretAbsent(${JSON.stringify(secret)})_refuseDeServirEn503`, async () => {
      const e = { ...env, ROOM_SECRET: secret };
      for (const path of ["/new", "/", "/?room=a&token=b"]) {
        const r = await worker.fetch(new Request("https://relay.test" + path, { headers: { Origin: ORIGIN } }), e);
        expect(r.status, path).toBe(503);
        expect(await r.text()).not.toContain("dev-insecure-secret");
      }
    });
  }

  it("fetch_secretAbsent_neFabriquePasDeJetonForgeable", async () => {
    const r = await worker.fetch(new Request("https://relay.test/new", { headers: { Origin: ORIGIN } }), { ...env, ROOM_SECRET: undefined });
    expect(r.headers.get("content-type") || "").not.toContain("json");
  });
});
