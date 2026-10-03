import { describe, it, expect } from "vitest";
import { env, exports } from "cloudflare:workers";
import worker from "../src/worker.js";
import { ORIGIN, freshIp } from "./helpers.js";

const req = (origin, ip = freshIp(), path = "/new") =>
  exports.default.fetch("https://relay.test" + path, { headers: { ...(origin === undefined ? {} : { Origin: origin }), "CF-Connecting-IP": ip } });

describe("/new — Origin", () => {
  it("new_sansOrigin_est403", async () => { expect((await req(undefined)).status).toBe(403); });
  it("new_originNull_est403", async () => { expect((await req("null")).status).toBe(403); });
  it("new_originWeb_est403", async () => { expect((await req("https://evil.com")).status).toBe(403); });
  it("new_extensionNonConfiguree_est403", async () => {
    expect((await req("chrome-extension://" + "p".repeat(32))).status).toBe(403);
  });
  it("new_extensionConfiguree_donneSalleEtJeton_etCorsRestreint", async () => {
    const r = await req(ORIGIN);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const j = await r.json();
    expect(j.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(j.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("new_allowedOriginsAbsent_refuseDeServirEn503", async () => {
    for (const v of [undefined, "", "https://evil.com"]) {
      const r = await worker.fetch(new Request("https://relay.test/new", { headers: { Origin: ORIGIN } }), { ...env, ALLOWED_ORIGINS: v });
      expect(r.status, String(v)).toBe(503);
    }
  });
});

describe("/new — limite de débit par IP", () => {
  it("new_rafaleDepuisUneMemeIp_finitEn429", async () => {
    const ip = freshIp();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await req(ORIGIN, ip)).status);
    expect(codes.slice(0, 5).every(c => c === 200)).toBe(true);
    expect(codes).toContain(429);
    const last = await req(ORIGIN, ip);
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("new_uneAutreIp_n_estPasAffectee", async () => {
    const ip = freshIp();
    for (let i = 0; i < 12; i++) await req(ORIGIN, ip);
    expect((await req(ORIGIN, freshIp())).status).toBe(200);
  });
});
