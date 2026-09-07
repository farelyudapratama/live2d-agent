import { randomBytes } from "crypto";
import type { BrowserAxNode, BrowserInspectResult, BrowserSnapshot } from "./types";

export type CdpAxValue = { type?: string; value?: unknown };
export type CdpAxProperty = { name?: string; value?: CdpAxValue };
export type CdpAxNode = {
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  value?: CdpAxValue;
  description?: CdpAxValue;
  backendDOMNodeId?: number;
  properties?: CdpAxProperty[];
};

export type SnapshotStoreOptions = {
  capacity?: number;
  ttlMs?: number;
  maxNodes?: number;
  now?: () => number;
  makeId?: () => string;
};

const SENSITIVE_NAME = /\b(password|passcode|pin|otp|secret|token|api[ _-]?key|kata sandi|sandi)\b/i;
const REDACTED = "[disembunyikan]";

function text(value?: CdpAxValue): string {
  const raw = value?.value;
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
    ? String(raw).replace(/\s+/g, " ").trim()
    : "";
}

function isSensitive(node: CdpAxNode): boolean {
  const label = `${text(node.name)} ${text(node.description)}`;
  if (SENSITIVE_NAME.test(label)) return true;
  return (node.properties ?? []).some((property) => {
    const name = String(property.name ?? "").toLowerCase();
    return (name === "protected" || name === "password") && property.value?.value === true;
  });
}

function opaqueId(): string {
  return randomBytes(12).toString("base64url");
}

/** Normalisasi AX dibatasi agar halaman besar tidak membanjiri memori/prompt. */
export function normalizeAxTree(
  rawNodes: readonly CdpAxNode[],
  meta: { url: string; title: string },
  options: Pick<SnapshotStoreOptions, "maxNodes" | "now" | "makeId"> = {},
): BrowserSnapshot {
  const maxNodes = Math.max(1, options.maxNodes ?? 500);
  const makeId = options.makeId ?? opaqueId;
  const nodes: BrowserAxNode[] = [];
  for (const raw of rawNodes) {
    if (nodes.length >= maxNodes || raw.ignored) continue;
    const role = text(raw.role) || "unknown";
    const name = text(raw.name);
    const value = text(raw.value);
    const description = text(raw.description);
    if (!name && !value && !description && role === "generic") continue;
    const sensitive = isSensitive(raw);
    nodes.push({
      ref: "br_" + makeId(),
      role,
      name,
      ...(value ? { value: sensitive ? REDACTED : value } : {}),
      ...(description ? { description } : {}),
      ...(typeof raw.backendDOMNodeId === "number" ? { backendDOMNodeId: raw.backendDOMNodeId } : {}),
      ...(sensitive ? { sensitive: true } : {}),
    });
  }
  return {
    snapshotId: "bs_" + makeId(),
    url: meta.url,
    title: meta.title,
    createdAt: (options.now ?? Date.now)(),
    nodes,
  };
}

export class SnapshotReferenceError extends Error {
  constructor(public readonly code: "unknown" | "expired" | "stale", message: string) {
    super(message);
    this.name = "SnapshotReferenceError";
  }
}

export class BrowserSnapshotStore {
  private readonly snapshots = new Map<string, BrowserSnapshot>();
  private readonly refs = new Map<string, string>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 8);
    this.ttlMs = Math.max(1, options.ttlMs ?? 120_000);
    this.now = options.now ?? Date.now;
  }

  put(snapshot: BrowserSnapshot): BrowserSnapshot {
    this.prune();
    this.snapshots.set(snapshot.snapshotId, snapshot);
    for (const node of snapshot.nodes) this.refs.set(node.ref, snapshot.snapshotId);
    while (this.snapshots.size > this.capacity) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest) this.remove(oldest);
    }
    return snapshot;
  }

  get(snapshotId: string): BrowserSnapshot {
    this.prune();
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new SnapshotReferenceError("expired", "snapshot sudah kedaluwarsa");
    return snapshot;
  }

  resolve(ref: string, expected: { snapshotId?: string; url?: string } = {}): BrowserAxNode {
    this.prune();
    const snapshotId = this.refs.get(ref);
    if (!snapshotId) throw new SnapshotReferenceError("unknown", "ref browser tidak dikenal atau kedaluwarsa");
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new SnapshotReferenceError("expired", "snapshot ref sudah kedaluwarsa");
    if ((expected.snapshotId && expected.snapshotId !== snapshotId) ||
        (expected.url && expected.url !== snapshot.url)) {
      throw new SnapshotReferenceError("stale", "ref browser sudah stale setelah navigasi/inspect baru");
    }
    const node = snapshot.nodes.find((item) => item.ref === ref);
    if (!node) throw new SnapshotReferenceError("unknown", "ref browser tidak dikenal");
    return node;
  }

  clear(): void {
    this.snapshots.clear();
    this.refs.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.createdAt <= cutoff) this.remove(id);
    }
  }

  private remove(id: string): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot) for (const node of snapshot.nodes) this.refs.delete(node.ref);
    this.snapshots.delete(id);
  }
}

export function formatInspect(snapshot: BrowserSnapshot, cursor = 0, maxChars = 12_000): BrowserInspectResult {
  const limit = Math.max(0, maxChars);
  const start = Math.max(0, Math.min(Math.trunc(cursor), snapshot.nodes.length));
  let body = "";
  let index = start;
  while (index < snapshot.nodes.length) {
    const node = snapshot.nodes[index];
    const fields = [`[${node.ref}]`, node.role, node.name];
    if (node.value) fields.push(`value=${node.value}`);
    if (node.description) fields.push(`desc=${node.description}`);
    const line = fields.filter(Boolean).join(" | ") + "\n";
    if (body.length + line.length > limit) {
      // Cursor harus selalu maju, termasuk ketika satu baris lebih panjang dari limit.
      if (!body && limit > 0) {
        body = line.slice(0, limit);
        index++;
      }
      break;
    }
    body += line;
    index++;
  }
  return {
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    title: snapshot.title,
    text: body,
    nextCursor: index < snapshot.nodes.length ? index : null,
    count: snapshot.nodes.length,
  };
}
