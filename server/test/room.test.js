import { describe, it, expect, afterEach } from "vitest";
import { mint, join, closeAll, isType } from "./helpers.js";

afterEach(closeAll);

async function twoPeers(nameA = "Alice", nameB = "Bob") {
  const { room, token } = await mint();
  const a = await join({ room, token, name: nameA });
  const wa = await a.next(isType("welcome"));
  const b = await join({ room, token, name: nameB });
  const wb = await b.next(isType("welcome"));
  await a.next(m => m.t === "system" && m.event === "join");
  return { room, token, a, b, wa, wb };
}

describe("arrivée dans la salle", () => {
  it("welcome_donneIdentiteServeurEtListeDesPairs", async () => {
    const { wa, wb } = await twoPeers();
    expect(wa.id).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
    expect(wa.name).toBe("Alice");
    expect(wa.peers).toEqual([]);
    expect(wb.peers).toEqual([{ id: wa.id, name: "Alice" }]);
    expect(typeof wb.now).toBe("number");
  });

  it("join_pseudoDejaPris_estSuffixeParLeServeur", async () => {
    const { wb } = await twoPeers("Alice", "alice");
    expect(wb.name).toBe("alice (2)");
  });

  it("join_pseudoAvecCaracteresDeControle_estAssaini", async () => {
    const { room, token } = await mint();
    const a = await join({ room, token, name: "Ad‮min\u0000" });
    expect((await a.next(isType("welcome"))).name).toBe("Admin");
  });

  it("join_salleComplete_est403", async () => {
    const { room, token } = await mint();
    for (let i = 0; i < 8; i++) { const p = await join({ room, token, name: "p" + i }); expect(p.status).toBe(101); }
    expect((await join({ room, token, name: "trop" })).status).toBe(403);
  });
});

describe("chat et messages système", () => {
  it("chat_pseudoVientDuServeur_pasDuMessage", async () => {
    const { a, b, wa } = await twoPeers();
    b.send({ t: "chat", name: "ADMIN", text: "je suis l'admin" }); // clé `name` interdite → rejeté
    b.send({ t: "chat", text: "bonjour" });
    const m = await a.next(isType("chat"));
    expect(m).toEqual({ t: "chat", from: expect.any(String), name: "Bob", text: "bonjour" });
    expect(m.from).not.toBe(wa.id);
  });

  it("system_envoyeParUnClient_n_estJamaisRelaye", async () => {
    const { a, b } = await twoPeers();
    b.send({ t: "system", text: "Alice a quitté. Entre ton mot de passe" });
    b.send({ t: "chat", text: "marqueur" });
    const first = await a.next(m => m.t === "chat" || (m.t === "system"));
    expect(first.t).toBe("chat");
  });

  it("messageHorsSchema_estIgnore_etLaConnexionSurvit", async () => {
    const { a, b } = await twoPeers();
    b.send("pas du json");
    b.send({ t: "sync", action: "seek", time: 99999999, paused: false });
    b.send({ t: "chat", text: "x".repeat(501) });
    b.send({ t: "chat", text: "ok" });
    const m = await a.next(isType("chat"));
    expect(m.text).toBe("ok");
    expect(b.closed).toBeNull();
  });

  it("messageTropGrosEnOctets_fermeLaConnexion1009", async () => {
    const { b } = await twoPeers();
    b.send(JSON.stringify({ t: "chat", text: "é".repeat(20000) })); // 20 000 caractères = 40 000 octets
    expect((await b.waitClosed()).code).toBe(1009);
  });

  it("depart_previentLesAutresAvecLIdentifiant", async () => {
    const { a, b, wb } = await twoPeers();
    b.ws.close(1000, "bye");
    const m = await a.next(m => m.t === "system" && m.event === "leave");
    expect(m.id).toBe(wb.id);
    expect(m.text).toContain("Bob");
  });
});

describe("limite de débit par connexion", () => {
  it("flood_estCoupeEtNEstPasIntegralementDiffuse", async () => {
    const { a, b } = await twoPeers();
    for (let i = 0; i < 400; i++) b.send({ t: "chat", text: "spam " + i });
    expect((await b.waitClosed()).code).toBe(1008);
    let relayed = 0;
    while (a.msgs.length) { const m = a.msgs.shift(); if (m.t === "chat") relayed++; }
    expect(relayed).toBeLessThan(100);
    expect(relayed).toBeGreaterThan(0);
  });

  it("lePingDuClient_recoitUnPongPrive", async () => {
    const { a, b } = await twoPeers();
    b.send({ t: "ping", c: 123 });
    const pong = await b.next(isType("pong"));
    expect(pong.c).toBe(123);
    expect(typeof pong.s).toBe("number");
    b.send({ t: "chat", text: "après" });
    expect((await a.next(isType("chat"))).text).toBe("après"); // aucun ping rediffusé avant
  });
});

describe("synchro côté serveur", () => {
  it("sync_estEstampilleeParLeServeur", async () => {
    const { a, b, wb } = await twoPeers();
    b.send({ t: "sync", action: "play", time: 10, paused: false });
    const m = await a.next(isType("sync"));
    expect(m).toMatchObject({ action: "play", time: 10, paused: false, from: wb.id, v: 1 });
    expect(typeof m.ts).toBe("number");
    b.send({ t: "sync", action: "pause", time: 12, paused: true });
    expect((await a.next(isType("sync"))).v).toBe(2);
  });

  it("nouvelArrivant_recoitLEtatCourant_enPause", async () => {
    const { room, token, b } = await twoPeers();
    b.send({ t: "sync", action: "pause", time: 777, paused: true });
    await new Promise(r => setTimeout(r, 50));
    const c = await join({ room, token, name: "Carol" });
    await c.next(isType("welcome"));
    const st = await c.next(isType("state"));
    expect(st).toMatchObject({ time: 777, paused: true, v: 1 });
  });

  it("nouvelArrivant_enLecture_recoitUnePositionExtrapolee", async () => {
    const { room, token, b } = await twoPeers();
    b.send({ t: "sync", action: "play", time: 100, paused: false });
    await new Promise(r => setTimeout(r, 1200));
    const c = await join({ room, token, name: "Carol" });
    await c.next(isType("welcome"));
    const st = await c.next(isType("state"));
    expect(st.paused).toBe(false);
    expect(st.time).toBeGreaterThanOrEqual(100.9);
    expect(st.time).toBeLessThan(110);
  });

  it("salleSansEtat_nEnvoiePasDeState", async () => {
    const { a } = await twoPeers();
    await new Promise(r => setTimeout(r, 30));
    expect(a.msgs.filter(isType("state"))).toEqual([]);
  });

  it("heartbeatEnSalleEnPause_estIgnore", async () => {
    const { a, b } = await twoPeers();
    b.send({ t: "sync", action: "pause", time: 5, paused: true });
    await a.next(isType("sync"));
    b.send({ t: "sync", action: "heartbeat", time: 6, paused: false });
    b.send({ t: "chat", text: "marqueur" });
    expect((await a.next(m => m.t === "sync" || m.t === "chat")).t).toBe("chat");
  });
});

describe("WebRTC — routage et identité", () => {
  it("rtc_fromEstFixeParLeServeur_etRoutageCible", async () => {
    const { room, token, a, b, wa, wb } = await twoPeers();
    const c = await join({ room, token, name: "Carol" });
    await c.next(isType("welcome"));
    b.send({ t: "rtc", sub: "desc", to: wa.id, sdp: { type: "offer", sdp: "v=0" } });
    const m = await a.next(isType("rtc"));
    expect(m).toEqual({ t: "rtc", sub: "desc", from: wb.id, to: wa.id, sdp: { type: "offer", sdp: "v=0" } });
    c.send({ t: "chat", text: "marqueur" });
    await a.next(isType("chat"));
    expect(c.msgs.filter(isType("rtc"))).toEqual([]);
  });

  it("rtc_fromForgeParLeClient_estRefuse", async () => {
    const { a, b, wa } = await twoPeers();
    b.send({ t: "rtc", sub: "hello", from: wa.id });
    b.send({ t: "chat", text: "marqueur" });
    expect((await a.next(m => m.t === "rtc" || m.t === "chat")).t).toBe("chat");
  });

  it("rtcHello_sansDestinataire_estDiffuse", async () => {
    const { a, b, wb } = await twoPeers();
    b.send({ t: "rtc", sub: "hello" });
    expect(await a.next(isType("rtc"))).toEqual({ t: "rtc", sub: "hello", from: wb.id });
  });
});

describe("accès", () => {
  it("connexionSansOrigin_est403", async () => {
    const { room, token } = await mint();
    expect((await join({ room, token, origin: "" })).status).toBe(403);
  });
  it("connexionOriginWeb_est403", async () => {
    const { room, token } = await mint();
    for (const o of ["https://evil.com", "null"]) expect((await join({ room, token, origin: o })).status, o).toBe(403);
  });
  it("connexionOriginExtensionNonConfiguree_est403", async () => {
    const { room, token } = await mint();
    expect((await join({ room, token, origin: "chrome-extension://" + "z".repeat(32) })).status).toBe(403);
  });
  it("tokenDUneAutreSalle_est403", async () => {
    const x = await mint(), y = await mint();
    expect((await join({ room: x.room, token: y.token })).status).toBe(403);
  });
});
