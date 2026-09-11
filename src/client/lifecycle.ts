/** Lifecycle kecil untuk resource UI yang wajib dibongkar secara idempotent. */
export type Cleanup = () => void;

export type Lifecycle = {
  readonly alive: boolean;
  add(cleanup: Cleanup): Cleanup;
  listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): Cleanup;
  interval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  controller(): AbortController;
  destroy(): void;
};

export function createLifecycle(): Lifecycle {
  let alive = true;
  const cleanups = new Set<Cleanup>();

  const api: Lifecycle = {
    get alive() { return alive; },
    add(cleanup) {
      if (!alive) {
        cleanup();
        return cleanup;
      }
      cleanups.add(cleanup);
      return cleanup;
    },
    listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      return api.add(() => target.removeEventListener(type, listener, options));
    },
    interval(callback, ms) {
      const id = setInterval(() => { if (alive) callback(); }, ms);
      api.add(() => clearInterval(id));
      return id;
    },
    timeout(callback, ms) {
      const id = setTimeout(() => {
        cleanups.delete(cancel);
        if (alive) callback();
      }, ms);
      const cancel = () => clearTimeout(id);
      api.add(cancel);
      return id;
    },
    controller() {
      const controller = new AbortController();
      api.add(() => controller.abort());
      return controller;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      for (const cleanup of Array.from(cleanups).reverse()) {
        try { cleanup(); } catch {}
      }
      cleanups.clear();
    },
  };
  return api;
}
