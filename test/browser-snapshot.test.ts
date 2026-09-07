import { describe, expect, it } from "bun:test";
import {
  BrowserSnapshotStore,
  SnapshotReferenceError,
  formatInspect,
  normalizeAxTree,
  type CdpAxNode,
} from "../src/server/browser/snapshot";

function ids() {
  let id = 0;
  return () => String(++id);
}

const tree: CdpAxNode[] = [
  { role: { value: "heading" }, name: { value: "  Selamat   datang " }, backendDOMNodeId: 1 },
  { role: { value: "textbox" }, name: { value: "Email" }, value: { value: "user@example.com" }, backendDOMNodeId: 2 },
  { role: { value: "textbox" }, name: { value: "Password" }, value: { value: "sangat-rahasia" }, backendDOMNodeId: 3 },
  { role: { value: "textbox" }, name: { value: "Kode" }, value: { value: "1234" }, properties: [{ name: "protected", value: { value: true } }] },
  { role: { value: "button" }, name: { value: "Masuk" }, backendDOMNodeId: 4 },
];

describe("browser snapshot", () => {
  it("menormalisasi AX, memberi ref opaque, membatasi node, dan meredaksi rahasia", () => {
    const snapshot = normalizeAxTree(tree, { url: "https://example.com", title: "Contoh" }, {
      maxNodes: 4, now: () => 10, makeId: ids(),
    });
    expect(snapshot.snapshotId).toBe("bs_5");
    expect(snapshot.nodes).toHaveLength(4);
    expect(snapshot.nodes[0]).toMatchObject({ ref: "br_1", name: "Selamat datang", backendDOMNodeId: 1 });
    expect(snapshot.nodes[1]).toMatchObject({ name: "Email", value: "user@example.com" });
    expect(snapshot.nodes[2]).toMatchObject({ name: "Password", value: "[disembunyikan]", sensitive: true });
    expect(snapshot.nodes[3]).toMatchObject({ value: "[disembunyikan]", sensitive: true });
  });

  it("memformat halaman inspect tanpa melewati maxChars dan punya cursor", () => {
    const snapshot = normalizeAxTree(tree, { url: "https://example.com", title: "Contoh" }, { makeId: ids() });
    const first = formatInspect(snapshot, 0, 70);
    expect(first.text.length).toBeLessThanOrEqual(70);
    expect(first.nextCursor).not.toBeNull();
    const second = formatInspect(snapshot, first.nextCursor ?? 0, 500);
    expect(second.text).toContain("Masuk");
    expect(second.nextCursor).toBeNull();
    const tiny = formatInspect(snapshot, 0, 5);
    expect(tiny.text).toHaveLength(5);
    expect(tiny.nextCursor).toBe(1);
  });

  it("menolak ref expired, stale, dan yang terusir kapasitas", () => {
    let now = 100;
    const store = new BrowserSnapshotStore({ capacity: 1, ttlMs: 20, now: () => now });
    const makeId = ids();
    const a = normalizeAxTree(tree.slice(0, 1), { url: "https://a.test/", title: "A" }, { now: () => now, makeId });
    store.put(a);
    expect(store.resolve(a.nodes[0].ref, { snapshotId: a.snapshotId, url: a.url }).name).toBe("Selamat datang");
    expect(() => store.resolve(a.nodes[0].ref, { url: "https://b.test/" })).toThrow(SnapshotReferenceError);
    const b = normalizeAxTree(tree.slice(4), { url: "https://b.test/", title: "B" }, { now: () => now, makeId });
    store.put(b);
    expect(() => store.resolve(a.nodes[0].ref)).toThrow("tidak dikenal");
    now = 121;
    expect(() => store.get(b.snapshotId)).toThrow("kedaluwarsa");
  });
});
