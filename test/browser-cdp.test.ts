import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { CdpClient, type CdpSocket } from "../src/server/browser/cdp";

class FakeSocket extends EventEmitter implements CdpSocket {
  readyState = 0;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    callback();
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", JSON.stringify(value));
  }
}

describe("CdpClient", () => {
  it("mengorelasikan response berdasar id walau urutannya terbalik", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient("ws://fake", () => socket);
    socket.open();
    const first = client.send<{ value: number }>("Page.first");
    const second = client.send<{ value: number }>("Page.second");
    await Bun.sleep(0);
    socket.message({ id: socket.sent[1].id, result: { value: 2 } });
    socket.message({ id: socket.sent[0].id, result: { value: 1 } });
    expect(await first).toEqual({ value: 1 });
    expect(await second).toEqual({ value: 2 });
    client.close();
  });

  it("meneruskan event dan unsubscribe menghentikannya", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient("ws://fake", () => socket);
    socket.open();
    const seen: unknown[] = [];
    const off = client.on("Page.frameNavigated", (params) => seen.push(params));
    socket.message({ method: "Page.frameNavigated", params: { url: "https://example.com" } });
    off();
    socket.message({ method: "Page.frameNavigated", params: { url: "https://ignored.test" } });
    expect(seen).toEqual([{ url: "https://example.com" }]);
    client.close();
  });

  it("menolak command yang timeout", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient("ws://fake", () => socket);
    socket.open();
    await expect(client.send("Page.slow", {}, 5)).rejects.toThrow("CDP timeout: Page.slow");
    client.close();
  });

  it("menolak pending command dan command baru setelah koneksi tutup", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient("ws://fake", () => socket);
    socket.open();
    const pending = client.send("Page.pending");
    await Bun.sleep(0);
    socket.emit("close");
    await expect(pending).rejects.toThrow("CDP terputus");
    await expect(client.send("Page.afterClose")).rejects.toThrow("CDP sudah ditutup");
  });
});
