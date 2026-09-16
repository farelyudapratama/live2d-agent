/**
 * speech-channel.test.ts — S1: unit murni untuk SpeechChannel.
 * Checklist: claim bebas, takeover same-priority, refusal lower-priority,
 * onLost sinkron, owner baru = current, token basi tidak bisa release,
 * double release aman, natural completion melepas, outcome completed vs
 * lost, identity producer melekat, reset (teardown) + enforcer.
 */
import { describe, test, expect } from "bun:test";
import {
  createSpeechChannel,
  type SpeechChannel,
  type SpeechToken,
} from "../src/client/speech/channel";

const mk = () => {
  const ch = createSpeechChannel();
  const events: string[] = [];
  let enforcerRuns = 0;
  ch.setEnforcer(() => {
    enforcerRuns++;
    events.push("enforcer");
  });
  return { ch, events, enforcerRuns: () => enforcerRuns };
};

describe("SpeechChannel — ownership dasar", () => {
  test("claim saat free → token pemilik, identity + priority melekat", () => {
    const { ch } = mk();
    const t = ch.claim("brain/chain") as SpeechToken;
    expect(t).toBeTruthy();
    expect(t.producer).toBe("brain/chain");
    expect(t.priority).toBe(0);
    expect(ch.current()).toEqual({ producer: "brain/chain", priority: 0 });
    expect(ch.isOwner(t)).toBe(true);
  });

  test("INV-1/INV-3: takeover same-priority → pemilik lama terima lost, owner baru valid", () => {
    const { ch, events, enforcerRuns } = mk();
    const lostOrder: string[] = [];
    const a = ch.claim("vtuber/audience", {
      onLost: (by) => lostOrder.push("lost:" + by),
    }) as SpeechToken;
    const b = ch.claim("probe/external", {}) as SpeechToken;
    // lost disampaikan SEBELUM claim() return (sinkron, INV-3 urutan 1)
    expect(lostOrder).toEqual(["lost:probe/external"]);
    expect(ch.isOwner(a)).toBe(false);
    expect(ch.isOwner(b)).toBe(true);
    expect(ch.current()?.producer).toBe("probe/external");
    expect(enforcerRuns()).toBe(1); // audio lama dihentikan sekali
    void events;
  });

  test("claim DITOLAK bila pemilik saat ini priority lebih tinggi", () => {
    const { ch, enforcerRuns } = mk();
    const hi = ch.claim("future/high", { priority: 10 });
    const lo = ch.claim("probe/low", { priority: 5 });
    expect(lo).toBeNull();
    expect(ch.isOwner(hi)).toBe(true);
    expect(enforcerRuns()).toBe(0);
  });

  test("INV-2/INV-5: stale token tidak melepas owner; double release aman", () => {
    const { ch } = mk();
    const a = ch.claim("app/direct") as SpeechToken;
    const b = ch.claim("probe/two", {}) as SpeechToken; // a jadi basi
    expect(ch.release(a)).toBe(false); // token basi → no-op
    expect(ch.current()?.producer).toBe("probe/two"); // b utuh
    expect(ch.release(b)).toBe(true);
    expect(ch.release(b)).toBe(false); // double release
    expect(ch.current()).toBeNull();
    expect(ch.release(null)).toBe(false); // aman
    expect(ch.release(undefined)).toBe(false);
  });

  test("INV-4: outcome membedakan completed vs lost", () => {
    const { ch } = mk();
    const a = ch.claim("brain/chain") as SpeechToken;
    expect(ch.outcome(a)).toBe("completed"); // masih kita
    ch.claim("probe/x", {}); // takeover
    expect(ch.outcome(a)).toBe("lost"); // callback lama BUKAN completion
    expect(ch.outcome(null)).toBe("lost"); // tanpa kepemilikan = tak diakui
  });

  test("INV-6: completion natural → release milik sendiri", () => {
    const { ch } = mk();
    const t = ch.claim("harness/actor") as SpeechToken;
    expect(ch.release(t)).toBe(true);
    expect(ch.current()).toBeNull();
  });

  test("INV-7: reset (teardown model) → lost + bersih + enforcer jalan", () => {
    const { ch, enforcerRuns } = mk();
    const lost: Array<string | null> = [];
    const t = ch.claim("probe/owner", { onLost: (by) => lost.push(by ?? null) }) as SpeechToken;
    ch.reset("model-switch");
    expect(lost).toEqual([null]);
    expect(ch.current()).toBeNull();
    expect(ch.isOwner(t)).toBe(false);
    expect(enforcerRuns()).toBe(1); // audio sisa ikut berhenti
    ch.reset(); // reset kedua = no-op aman
    expect(lost.length).toBe(1);
  });

  test("onLost yang melempar tidak memecahkan takeover; enforcer error ditelan", () => {
    const ch = createSpeechChannel();
    ch.setEnforcer(() => {
      throw new Error("enforcer rusak");
    });
    const t = ch.claim("a", {
      onLost: () => {
        throw new Error("korban rusak");
      },
    });
    const t2 = ch.claim("b", {});
    expect(t2).toBeTruthy();
    expect(ch.current()?.producer).toBe("b");
    expect(ch.release(t)).toBe(false);
  });

  test("producerId kosong → identity 'unknown' (tidak ada klaim anonim)", () => {
    const { ch } = mk();
    const t = ch.claim("") as SpeechToken;
    expect(t.producer).toBe("unknown");
  });
});
