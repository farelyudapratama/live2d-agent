/** Tipe kanonik browser agent — backend CDP & UI memakai bentuk yang sama. */

export type BrowserState = {
  available: boolean;
  running: boolean;
  connected: boolean;
  engine: "edge" | "chrome" | null;
  url: string;
  title: string;
  canBack: boolean;
  canForward: boolean;
  originGranted: boolean;
  error?: string;
};

export type BrowserAxNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  sensitive?: boolean;
};

export type BrowserSnapshot = {
  snapshotId: string;
  url: string;
  title: string;
  createdAt: number;
  nodes: BrowserAxNode[];
};

export type BrowserInspectResult = {
  snapshotId: string;
  url: string;
  title: string;
  text: string;
  nextCursor: number | null;
  count: number;
};

export type BrowserScreenshot = {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  ts: number;
};
