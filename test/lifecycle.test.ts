import { describe, expect, it } from "bun:test";
import { createLifecycle } from "../src/client/lifecycle";
import { bootThenPoll } from "../src/client/agent/panel/api";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("client lifecycle", () => {
  it("destroy idempotent dan cleanup LIFO sekali", () => {
    const lifecycle = createLifecycle();
    const calls: number[] = [];
    lifecycle.add(() => calls.push(1));
    lifecycle.add(() => calls.push(2));
    lifecycle.destroy();
    lifecycle.destroy();
    expect(calls).toEqual([2, 1]);
    expect(lifecycle.alive).toBe(false);
  });

  it("abort request pending saat teardown", () => {
    const lifecycle = createLifecycle();
    const controller = lifecycle.controller();
    lifecycle.destroy();
    expect(controller.signal.aborted).toBe(true);
  });

  it("teardown selama boot tidak memasang atau menjalankan poll", async () => {
    const lifecycle = createLifecycle();
    let release!: () => void;
    let polls = 0;
    const pending = bootThenPoll(
      lifecycle,
      () => new Promise<void>((resolve) => { release = resolve; }),
      [{ run: () => { polls++; }, ms: 2 }],
    );
    lifecycle.destroy();
    release();
    await pending;
    await tick();
    expect(polls).toBe(0);
  });
});
