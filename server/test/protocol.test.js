import { describe, it, expect } from "vitest";
import {
  LIMITS, sanitizeName, uniqueName, validateClientMessage, consumeToken,
  extrapolate, parseAllowedOrigins, isAllowedOrigin,
} from "../src/protocol.js";

const ok = m => validateClientMessage(JSON.stringify(m));
const bad = (m, why) => {
  const r = typeof m === "string" ? validateClientMessage(m) : ok(m);
  expect(r.ok, JSON.stringify(m)).toBe(false);
  if (why) expect(r.reason).toBe(why);
};

describe("validateClientMessage — types", () => {
  it("system_envoyeParUnClient_estRefuse", () => {
    bad({ t: "system", text: "Le serveur va redémarrer" }, "type");
  });
  it("typeInconnu_estRefuse", () => {
    bad({ t: "admin" }, "type");
    bad({ text: "pas de type" }, "type");
    bad({ t: 42 }, "type");
  });
  it("nonJsonOuNonObjet_estRefuse", () => {
    bad("pas du json", "json");
    bad("[1,2]", "format");
    bad("null", "format");
    bad("42", "format");
  });
  it("binaire_estRefuse", () => {
    expect(validateClientMessage(new ArrayBuffer(4)).ok).toBe(false);
  });
  it("cleInconnue_estRefusee", () => {
    bad({ t: "chat", text: "salut", name: "ADMIN" }, "cles");
    bad({ t: "sync", action: "play", time: 1, paused: false, from: "x" }, "cles");
  });
});

describe("validateClientMessage — chat", () => {
  it("chatValide_estNormalise", () => {
    expect(ok({ t: "chat", text: "  salut  " })).toEqual({ ok: true, msg: { t: "chat", text: "salut" } });
  });
  it("chatVideOuTropLongOuNonTexte_estRefuse", () => {
    bad({ t: "chat", text: "   " });
    bad({ t: "chat", text: "x".repeat(LIMITS.CHAT_MAX + 1) });
    bad({ t: "chat", text: 5 });
    bad({ t: "chat" });
  });
});

describe("validateClientMessage — sync", () => {
  it("syncValide_estAccepte", () => {
    for (const action of ["play", "pause", "seek", "heartbeat"]) {
      expect(ok({ t: "sync", action, time: 12.5, paused: action === "pause" }).ok).toBe(true);
    }
  });
  it("seekHorsBornes_estRefuse", () => {
    bad({ t: "sync", action: "seek", time: 99999999, paused: false });
    bad({ t: "sync", action: "seek", time: -1, paused: false });
    bad({ t: "sync", action: "seek", time: NaN, paused: false });
    bad({ t: "sync", action: "seek", time: "10", paused: false });
    bad({ t: "sync", action: "seek", time: null, paused: false });
  });
  it("actionOuPausedInvalide_estRefuse", () => {
    bad({ t: "sync", action: "delete", time: 1, paused: false });
    bad({ t: "sync", action: "play", time: 1, paused: "non" });
    bad({ t: "sync", action: "play", time: 1 });
  });
});

describe("validateClientMessage — ping et rtc", () => {
  it("ping_accepteAvecHorlogeClient", () => {
    expect(ok({ t: "ping" }).ok).toBe(true);
    expect(ok({ t: "ping", c: 1700000000000 }).ok).toBe(true);
    bad({ t: "ping", c: "x" });
  });
  const id = "AbCdEf12";
  it("rtcHello_avecOuSansDestinataire", () => {
    expect(ok({ t: "rtc", sub: "hello" }).ok).toBe(true);
    expect(ok({ t: "rtc", sub: "hello", to: id }).ok).toBe(true);
  });
  it("rtcDestinataireMalForme_estRefuse", () => {
    bad({ t: "rtc", sub: "hello", to: 'x"] , body{' });
    bad({ t: "rtc", sub: "hello", to: "a" });
    bad({ t: "rtc", sub: "inconnu" });
  });
  it("rtcDesc_exigeDestinataireEtSdpBorne", () => {
    expect(ok({ t: "rtc", sub: "desc", to: id, sdp: { type: "offer", sdp: "v=0\r\n" } }).ok).toBe(true);
    bad({ t: "rtc", sub: "desc", sdp: { type: "offer", sdp: "v=0" } });
    bad({ t: "rtc", sub: "desc", to: id, sdp: { type: "rollback", sdp: "" } });
    bad({ t: "rtc", sub: "desc", to: id, sdp: { type: "offer", sdp: "x".repeat(LIMITS.SDP_MAX + 1) } });
    bad({ t: "rtc", sub: "desc", to: id });
  });
  it("rtcIce_candidatBorneOuNull", () => {
    const c = { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ab" };
    expect(ok({ t: "rtc", sub: "ice", to: id, candidate: c }).ok).toBe(true);
    expect(ok({ t: "rtc", sub: "ice", to: id, candidate: null }).ok).toBe(true);
    bad({ t: "rtc", sub: "ice", to: id, candidate: { candidate: "x".repeat(5000) } });
    bad({ t: "rtc", sub: "ice", to: id, candidate: { candidate: "a", extra: 1 } });
  });
});

describe("pseudo", () => {
  it("sanitizeName_nettoieEtBorne", () => {
    expect(sanitizeName("  Lilou  ")).toBe("Lilou");
    expect(sanitizeName("a\u0000b‮c\n")).toBe("abc");
    expect(sanitizeName("x".repeat(100))).toHaveLength(LIMITS.NAME_MAX);
    expect(sanitizeName("")).toBe("Anon");
    expect(sanitizeName(null)).toBe("Anon");
  });
  it("uniqueName_suffixeLesDoublons", () => {
    expect(uniqueName("Lilou", new Set())).toBe("Lilou");
    expect(uniqueName("Lilou", new Set(["Lilou"]))).toBe("Lilou (2)");
    expect(uniqueName("Lilou", new Set(["Lilou", "Lilou (2)"]))).toBe("Lilou (3)");
    expect(uniqueName("lilou", new Set(["Lilou"]))).toBe("lilou (2)"); // insensible à la casse
    expect(uniqueName("x".repeat(32), new Set(["x".repeat(32)])).length).toBeLessThanOrEqual(LIMITS.NAME_MAX);
  });
});

describe("consumeToken — limite de débit", () => {
  const cfg = { burst: 3, perSec: 1 };
  it("rafaleAuDelaDuSeuil_estRefusee", () => {
    let b = null, allowed = [];
    for (let i = 0; i < 5; i++) { const r = consumeToken(b, 1000, cfg); b = r.bucket; allowed.push(r.allowed); }
    expect(allowed).toEqual([true, true, true, false, false]);
  });
  it("lesJetonsSeRecreditentAvecLeTemps", () => {
    let b = null;
    for (let i = 0; i < 3; i++) b = consumeToken(b, 1000, cfg).bucket;
    expect(consumeToken(b, 1000, cfg).allowed).toBe(false);
    expect(consumeToken(b, 3100, cfg).allowed).toBe(true);
  });
  it("neDepassePasLaCapacite", () => {
    const r = consumeToken({ tokens: 3, ts: 0 }, 10_000_000, cfg);
    expect(r.bucket.tokens).toBeLessThanOrEqual(cfg.burst);
  });
  it("horlogeQuiRecule_nePenalisePas", () => {
    const r = consumeToken({ tokens: 1, ts: 5000 }, 1000, cfg);
    expect(r.allowed).toBe(true);
  });
});

describe("extrapolate — état initial", () => {
  it("lecture_avanceAvecLeTemps", () => {
    expect(extrapolate({ time: 100, paused: false, at: 1000 }, 6000)).toEqual({ time: 105, paused: false });
  });
  it("pause_neBougePas", () => {
    expect(extrapolate({ time: 100, paused: true, at: 1000 }, 99_000)).toEqual({ time: 100, paused: true });
  });
  it("lectureTropAncienne_repasseEnPauseSansExtrapoler", () => {
    expect(extrapolate({ time: 100, paused: false, at: 0 }, LIMITS.STATE_MAX_AGE_MS + 1)).toEqual({ time: 100, paused: true });
  });
  it("aucunEtat_donneNull", () => {
    expect(extrapolate(null, 1)).toBeNull();
  });
});

describe("Origin", () => {
  const allowed = parseAllowedOrigins(" chrome-extension://abcdefghijklmnopabcdefghijklmnop , chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba ,https://evil.com, chrome-extension://court,");
  it("parseAllowedOrigins_neGardeQueLesExtensionsBienFormees", () => {
    expect([...allowed].sort()).toEqual([
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
    ]);
    expect(parseAllowedOrigins(undefined).size).toBe(0);
    expect(parseAllowedOrigins("").size).toBe(0);
  });
  it("isAllowedOrigin_neAccepteQueLaListeExacte", () => {
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop", allowed)).toBe(true);
    for (const o of ["", null, "null", "https://evil.com", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/", "http://localhost"]) {
      expect(isAllowedOrigin(o, allowed), String(o)).toBe(false);
    }
  });
});
