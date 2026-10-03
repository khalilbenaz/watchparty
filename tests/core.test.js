import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createSync, parseInvite, isPeerId, backoffDelay, sanitizeName, clockSample } = require("../extension/wp-core.js");

const ROOM = "A".repeat(22);
const TOKEN = "b".repeat(43);

describe("parseInvite", () => {
  it("lienComplet_etRoomPointToken_sontAcceptes", () => {
    expect(parseInvite(`https://www.netflix.com/watch/1#wp=${ROOM}.${TOKEN}`)).toEqual({ room: ROOM, token: TOKEN });
    expect(parseInvite(`${ROOM}.${TOKEN}`)).toEqual({ room: ROOM, token: TOKEN });
    expect(parseInvite(`#wp=${encodeURIComponent(ROOM + "." + TOKEN)}&x=1`)).toEqual({ room: ROOM, token: TOKEN });
  });
  it("formatsInvalides_sontRefuses", () => {
    for (const s of ["", "salon407", `${ROOM}`, `${ROOM}.court`, `court.${TOKEN}`, `${ROOM}.${TOKEN}x`,
      `${ROOM}.${"é".repeat(43)}`, `x"].${TOKEN}`, null, undefined, 42]) {
      expect(parseInvite(s), String(s)).toBeNull();
    }
  });
});

describe("isPeerId / sanitizeName", () => {
  it("isPeerId_refuseLesInjectionsDeSelecteur", () => {
    expect(isPeerId("AbCdEf12_-x")).toBe(true);
    for (const s of ['a"]', "x".repeat(33), "court", "a b c d e f g", "", null, 5, '"],body{x:1}', "abcdefgh\n"]) {
      expect(isPeerId(s), String(s)).toBe(false);
    }
  });
  it("sanitizeName_borneEtNettoie", () => {
    expect(sanitizeName("  Lilou ")).toBe("Lilou");
    expect(sanitizeName("a".repeat(99))).toHaveLength(32);
    expect(sanitizeName("")).toBe("Anon");
  });
});

describe("backoffDelay", () => {
  it("croitExponentiellement_etPlafonne", () => {
    const d = n => backoffDelay(n, () => 0.5);   // jitter neutre
    expect(d(0)).toBe(1000);
    expect(d(1)).toBe(2000);
    expect(d(2)).toBe(4000);
    expect(d(20)).toBe(30000);
  });
  it("jitter_resteDansLaPlage", () => {
    expect(backoffDelay(3, () => 0)).toBeGreaterThanOrEqual(8000 * 0.75);
    expect(backoffDelay(3, () => 0.999999)).toBeLessThanOrEqual(8000 * 1.25);
  });
});

describe("clockSample — décalage d'horloge avec le serveur", () => {
  it("garde_l_echantillonAuPlusPetitRtt", () => {
    // client t0=1000, serveur s=5050, retour t1=1100 → rtt 100, offset = 5050-(1000+50) = 4000
    let c = clockSample(null, 1000, 5050, 1100);
    expect(c).toEqual({ offset: 4000, rtt: 100 });
    // un échantillon plus lent n'écrase pas le meilleur
    c = clockSample(c, 2000, 6300, 2500);
    expect(c).toEqual({ offset: 4000, rtt: 100 });
    // un plus rapide le remplace
    c = clockSample(c, 3000, 7020, 3040);
    expect(c.rtt).toBe(40);
    expect(c.offset).toBe(4000);
  });
});

// ---------- SyncController ----------
function make(over = {}) {
  let t = 100_000;
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const sync = createSync({ now: clock.now, ...over });
  return { sync, clock };
}
const play = (time, v, extra = {}) => ({ t: "sync", action: "play", time, paused: false, v, ts: 100_000, ...extra });

describe("SyncController — heartbeat", () => {
  it("heartbeatRecu_neForcePasLaLecture", () => {
    const { sync } = make();
    const cmds = sync.onRemote({ t: "sync", action: "heartbeat", time: 50, paused: false, v: 0, ts: 100_000 }, { time: 50, paused: true });
    expect(cmds).toEqual([]);                                  // on est en pause : le heartbeat n'y change rien
  });
  it("heartbeatRecu_corrigeUneDeriveSansToucherALaLecture", () => {
    const { sync } = make();
    const cmds = sync.onRemote({ t: "sync", action: "heartbeat", time: 60, paused: false, v: 0, ts: 100_000 }, { time: 50, paused: false });
    expect(cmds).toEqual([{ cmd: "seek", time: 60 }]);
  });
  it("heartbeatRecu_deriveSousLeSeuil_nefaitRien", () => {
    const { sync } = make();
    expect(sync.onRemote({ t: "sync", action: "heartbeat", time: 50.5, paused: false, v: 0, ts: 100_000 }, { time: 50, paused: false })).toEqual([]);
  });
  it("heartbeatEmis_seulementEnLecture_etSansPaused", () => {
    const { sync } = make();
    expect(sync.heartbeat({ time: 5, paused: true })).toBeNull();
    expect(sync.heartbeat({ time: 5, paused: false })).toEqual({ t: "sync", action: "heartbeat", time: 5, paused: false });
  });
  it("heartbeatPerime_estIgnore", () => {
    const { sync } = make();
    sync.onRemote(play(10, 5), { time: 10, paused: false });
    expect(sync.onRemote({ t: "sync", action: "heartbeat", time: 99, paused: false, v: 4, ts: 100_000 }, { time: 10, paused: false })).toEqual([]);
  });
});

describe("SyncController — commandes distantes", () => {
  it("play_distantEnPause_donneSeekEtPlay", () => {
    const { sync } = make();
    expect(sync.onRemote(play(30, 1), { time: 0, paused: true })).toEqual([{ cmd: "seek", time: 30 }, { cmd: "play" }]);
  });
  it("play_dejaAligne_neDonneRien", () => {
    const { sync } = make();
    expect(sync.onRemote(play(30, 1), { time: 30.2, paused: false })).toEqual([]);
  });
  it("pause_distanteEnLecture_donneSeekEtPause_sansCompenserLaLatence", () => {
    const { sync } = make();
    const m = { t: "sync", action: "pause", time: 40, paused: true, v: 1, ts: 90_000 };
    expect(sync.onRemote(m, { time: 20, paused: false })).toEqual([{ cmd: "seek", time: 40 }, { cmd: "pause" }]);
  });
  it("seek_distant_neChangePasLEtatLecturePause", () => {
    const { sync } = make();
    const m = { t: "sync", action: "seek", time: 70, paused: false, v: 1, ts: 100_000 };
    expect(sync.onRemote(m, { time: 5, paused: true })).toEqual([{ cmd: "seek", time: 70 }]);
  });
  it("messageAnterieurAuDernierVu_estIgnore", () => {
    const { sync } = make();
    sync.onRemote(play(10, 5), { time: 0, paused: true });
    expect(sync.onRemote({ t: "sync", action: "pause", time: 1, paused: true, v: 4, ts: 100_000 }, { time: 10, paused: false })).toEqual([]);
    expect(sync.onRemote({ t: "sync", action: "pause", time: 1, paused: true, v: 5, ts: 100_000 }, { time: 10, paused: false })).toEqual([]); // doublon
    expect(sync.onRemote({ t: "sync", action: "pause", time: 1, paused: true, v: 6, ts: 100_000 }, { time: 10, paused: false }).length).toBe(2);
  });
});

describe("SyncController — latence", () => {
  it("play_compenseLeTempsDeTransit", () => {
    const { sync } = make();
    sync.setClockOffset(0);
    // le serveur a estampillé il y a 400 ms
    const cmds = sync.onRemote(play(30, 1, { ts: 99_600 }), { time: 0, paused: true });
    expect(cmds[0]).toEqual({ cmd: "seek", time: 30.4 });
  });
  it("latenceAberrante_estPlafonnee", () => {
    const { sync } = make();
    const cmds = sync.onRemote(play(30, 1, { ts: 0 }), { time: 0, paused: true });
    expect(cmds[0].time).toBe(32);                       // plafond 2 s
  });
  it("offsetServeur_estPrisEnCompte", () => {
    const { sync } = make();
    sync.setClockOffset(5000);                           // le serveur a 5 s d'avance
    const cmds = sync.onRemote(play(30, 1, { ts: 105_300 }), { time: 0, paused: true });
    expect(cmds[0].time).toBeCloseTo(30, 5);             // 100000+5000-105300 < 0 → 0
    const cmds2 = sync.onRemote(play(30, 2, { ts: 104_800 }), { time: 0, paused: true });
    expect(cmds2[0].time).toBeCloseTo(30.2, 5);
  });
});

describe("SyncController — état initial", () => {
  it("state_enPause_alignePositionEtPause", () => {
    const { sync } = make();
    expect(sync.onRemote({ t: "state", time: 777, paused: true, v: 3, ts: 100_000 }, { time: 0, paused: false }))
      .toEqual([{ cmd: "seek", time: 777 }, { cmd: "pause" }]);
  });
  it("state_enLecture_rejoue_etLEtatPeutEtreRejoueApresReconnexion", () => {
    const { sync } = make();
    const st = { t: "state", time: 10, paused: false, v: 3, ts: 100_000 };
    expect(sync.onRemote(st, { time: 0, paused: true })).toEqual([{ cmd: "seek", time: 10 }, { cmd: "play" }]);
    // même v (reconnexion sans changement) : un state doit quand même être appliqué
    expect(sync.onRemote(st, { time: 0, paused: true }).length).toBe(2);
  });
});

describe("SyncController — écho (remplace le drapeau suppress)", () => {
  it("evenementsProvoquesParLaCommandeDistante_ne_sontPasRenvoyes", () => {
    const { sync } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    expect(sync.onLocalEvent("seeked", { time: 30.1, paused: true })).toBeNull();
    expect(sync.onLocalEvent("play", { time: 30.1, paused: false })).toBeNull();
  });
  it("evenementTardif_apresPlusDe700ms_resteAvale", () => {
    const { sync, clock } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    clock.advance(2500);                                  // Netflix a mis 2,5 s à chercher
    expect(sync.onLocalEvent("seeked", { time: 30, paused: false })).toBeNull();
  });
  it("actionRealeDeLUtilisateur_pendantLaFenetre_estEnvoyee", () => {
    const { sync, clock } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    clock.advance(200);
    // l'utilisateur met en pause alors qu'on n'attendait qu'un seek + play
    expect(sync.onLocalEvent("pause", { time: 30.2, paused: true })).toEqual({ t: "sync", action: "pause", time: 30.2, paused: true });
  });
  it("seekUtilisateurLoinDeLaCible_estEnvoye", () => {
    const { sync } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    expect(sync.onLocalEvent("seeked", { time: 500, paused: false })).toEqual({ t: "sync", action: "seek", time: 500, paused: false });
  });
  it("attenteExpiree_lEvenementEstEnvoye", () => {
    const { sync, clock } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    clock.advance(10_000);
    expect(sync.onLocalEvent("play", { time: 40, paused: false })).toEqual({ t: "sync", action: "play", time: 40, paused: false });
  });
  it("deuxCommandesRapprochees_neSeLevent_pasMutuellement", () => {
    const { sync, clock } = make();
    sync.onRemote(play(30, 1), { time: 0, paused: true });
    clock.advance(300);
    sync.onRemote({ t: "sync", action: "seek", time: 90, paused: false, v: 2, ts: 100_300 }, { time: 31, paused: false });
    expect(sync.onLocalEvent("seeked", { time: 30, paused: false })).toBeNull();
    expect(sync.onLocalEvent("seeked", { time: 90, paused: false })).toBeNull();
    expect(sync.onLocalEvent("play", { time: 30, paused: false })).toBeNull();
  });
  it("evenementSansCommandeDistante_estEnvoyeTelQuel", () => {
    const { sync } = make();
    expect(sync.onLocalEvent("play", { time: 1, paused: false })).toEqual({ t: "sync", action: "play", time: 1, paused: false });
  });
  it("commandeDejaSatisfaite_neCreePasDAttente", () => {
    const { sync } = make();
    expect(sync.onRemote({ t: "sync", action: "pause", time: 5, paused: true, v: 1, ts: 100_000 }, { time: 5, paused: true })).toEqual([]);
    // l'utilisateur joue juste après : ne doit PAS être avalé
    expect(sync.onLocalEvent("play", { time: 5, paused: false })).not.toBeNull();
  });
});
