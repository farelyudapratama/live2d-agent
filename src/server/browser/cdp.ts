import { WebSocket } from "ws";

export type CdpParams = Record<string, unknown>;
export type CdpEvent = { method: string; params?: CdpParams; sessionId?: string };
export type CdpEventHandler = (params: CdpParams) => void;

export interface CdpSocket {
  readonly readyState: number;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "open", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  send(data: string, callback: (error?: Error) => void): void;
  close(): void;
}

export type CdpSocketFactory = (url: string) => CdpSocket;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: CdpParams;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

const defaultSocketFactory: CdpSocketFactory = (url) =>
  new WebSocket(url, { maxPayload: 16 * 1024 * 1024 }) as unknown as CdpSocket;

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : fallback);
}

/** Transport CDP internal; daftar method yang boleh dipanggil tetap milik manager. */
export class CdpClient {
  private readonly ws: CdpSocket;
  private readonly opened: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();
  private dead = false;
  private openPending = true;
  private rejectOpen: ((error: Error) => void) | null = null;
  private openError: Error | null = null;

  constructor(url: string, wsFactory: CdpSocketFactory = defaultSocketFactory) {
    this.ws = wsFactory(url);
    this.opened = new Promise((resolve, reject) => {
      this.rejectOpen = reject;
      const onOpen = (): void => {
        cleanup();
        this.openPending = false;
        this.rejectOpen = null;
        resolve();
      };
      const onError = (value: Error): void => {
        cleanup();
        this.openPending = false;
        this.rejectOpen = null;
        const error = asError(value, "CDP gagal terhubung");
        this.openError = error;
        this.failAll(error);
        reject(error);
      };
      const cleanup = (): void => {
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
      };
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
    });
    this.ws.on("message", (raw) => this.handle(raw));
    this.ws.on("close", () => {
      const error = new Error("CDP terputus");
      if (this.openPending) {
        this.openPending = false;
        this.openError = error;
        this.rejectOpen?.(error);
        this.rejectOpen = null;
      }
      this.failAll(error);
    });
    this.ws.on("error", (value) => {
      if (this.ws.readyState !== WebSocket.CONNECTING) {
        this.failAll(asError(value, "CDP WebSocket gagal"));
      }
    });
  }

  private handle(raw: unknown): void {
    let message: CdpMessage;
    try {
      const text = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error("CDP " + (message.error.message || JSON.stringify(message.error))));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}); } catch {}
    }
  }

  async send<T = unknown>(method: string, params: CdpParams = {}, timeoutMs = 10_000): Promise<T> {
    if (this.dead) throw this.openError ?? new Error("CDP sudah ditutup");
    await this.opened;
    if (this.dead) throw new Error("CDP sudah ditutup");
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), (value) => {
          if (!value) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(asError(value, "CDP gagal mengirim perintah"));
        });
      } catch (value) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(asError(value, "CDP gagal mengirim perintah"));
      }
    });
  }

  on(method: string, listener: CdpEventHandler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(method);
    };
  }

  private failAll(error: Error): void {
    if (this.dead && this.pending.size === 0) return;
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get closed(): boolean {
    return this.dead;
  }

  close(): void {
    this.failAll(new Error("CDP ditutup"));
    this.listeners.clear();
    try { this.ws.close(); } catch {}
  }
}
