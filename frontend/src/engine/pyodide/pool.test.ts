import { describe, expect, it } from "vitest";
import { defaultPoolSize, WorkerPool, type WorkerLike } from "./pool";
import type { WorkerMessage, WorkerRequest } from "./worker";

class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  calls: Extract<WorkerRequest, { type: "call" }>[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: WorkerRequest) {
    if (message.type === "call") this.calls.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(message: WorkerMessage) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>);
  }
  finish(value: unknown = "done") {
    const call = this.calls.shift()!;
    this.emit({ type: "result", id: call.id, response: JSON.stringify({ ok: true, value }), ms: 1 });
    return call;
  }
}

function pool(size = 1) {
  FakeWorker.all = [];
  return new WorkerPool(() => new FakeWorker(), "wheel.whl", size);
}

describe("WorkerPool", () => {
  it("serves preview before interactive before background, and front jumps its level", async () => {
    const p = pool();
    const order: string[] = [];
    const track = (label: string, promise: Promise<unknown>) => promise.then(() => order.push(label));
    const done = [
      track("background", p.run("solve", ["b"], "background")),
      track("interactive", p.run("solve", ["i"], "interactive")),
      track("preview", p.run("solve", ["p"], "preview")),
      track("front", p.run("assemble", ["f"], "interactive", undefined, true)),
    ];
    const worker = FakeWorker.all[0];
    worker.emit({ type: "ready" });
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      worker.finish();
    }
    await Promise.all(done);
    expect(order).toEqual(["preview", "front", "interactive", "background"]);
  });

  it("drops aborted queued work without sending it to a worker", async () => {
    const p = pool();
    const abort = new AbortController();
    const first = p.run("solve", ["a"]);
    const second = p.run("solve", ["b"], "interactive", abort.signal);
    abort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const worker = FakeWorker.all[0];
    worker.emit({ type: "ready" });
    expect(worker.calls.map((c) => c.args)).toEqual([["a"]]);
    worker.finish();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(worker.calls).toHaveLength(0);
  });

  it("grows only after one interpreter is ready, up to its size", () => {
    const p = pool(3);
    for (let i = 0; i < 5; i++) void p.run("solve", [String(i)]);
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0].emit({ type: "ready" });
    expect(FakeWorker.all.length).toBeGreaterThan(1);
    expect(FakeWorker.all.length).toBeLessThanOrEqual(3);
  });

  it("fails every waiting task when no interpreter can start", async () => {
    const p = pool();
    const statuses: string[] = [];
    p.subscribe((s) => statuses.push(s.phase));
    const task = p.run("solve", []);
    FakeWorker.all[0].emit({ type: "fatal", message: "offline" });
    await expect(task).rejects.toThrow("offline");
    expect(statuses.at(-1)).toBe("failed");
    await expect(p.run("solve", [])).rejects.toThrow(/could not start/);
  });

  it("sizes the pool from cores and memory", () => {
    expect(defaultPoolSize({ hardwareConcurrency: 16 })).toBe(4);
    expect(defaultPoolSize({ hardwareConcurrency: 2 })).toBe(1);
    expect(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(2);
  });
});
