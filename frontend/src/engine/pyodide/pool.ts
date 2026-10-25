import type { BridgeOp, BridgeResponse } from "./runtime";
import type { WorkerMessage, WorkerRequest } from "./worker";

/** preview > interactive > background; within a level, `front` jumps the queue. */
export type Priority = "preview" | "interactive" | "background";

export interface PoolStatus {
  phase: "idle" | "loading" | "ready" | "failed";
  detail: string;
  workers: number;
  busy: number;
}

interface Task {
  id: number;
  op: BridgeOp;
  args: (string | number)[];
  resolve: (value: BridgeResponse<unknown>) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface Slot {
  worker: WorkerLike;
  ready: boolean;
  task: Task | null;
}

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export class AbortedError extends Error {
  constructor() {
    super("Calculation superseded");
    this.name = "AbortError";
  }
}

export function defaultPoolSize(nav: { hardwareConcurrency?: number; deviceMemory?: number } = navigator) {
  const cores = Math.max(1, Math.min(4, (nav.hardwareConcurrency ?? 2) - 1));
  return nav.deviceMemory !== undefined && nav.deviceMemory <= 4 ? Math.min(cores, 2) : cores;
}

/** Python interpreters in Web Workers; one task per worker at a time. */
export class WorkerPool {
  private slots: Slot[] = [];
  private queues: Record<Priority, Task[]> = { preview: [], interactive: [], background: [] };
  private listeners = new Set<(status: PoolStatus) => void>();
  private nextId = 1;
  private status: PoolStatus = { phase: "idle", detail: "", workers: 0, busy: 0 };
  /** Replacements for workers that died after starting, since the last one came up. */
  private restarts = 0;

  constructor(
    private createWorker: () => WorkerLike,
    private wheelUrl: string,
    private maxSize: number,
  ) {}

  subscribe(listener: (status: PoolStatus) => void) {
    this.listeners.add(listener);
    listener(this.status);
    return () => void this.listeners.delete(listener);
  }

  start() {
    if (!this.slots.length) this.spawn();
  }

  run<T>(
    op: BridgeOp,
    args: (string | number)[],
    priority: Priority = "interactive",
    signal?: AbortSignal,
    front = false,
  ) {
    return new Promise<BridgeResponse<T>>((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortedError());
      if (this.status.phase === "failed") return reject(new Error(this.status.detail));
      const task: Task = {
        id: this.nextId++,
        op,
        args,
        resolve: resolve as Task["resolve"],
        reject,
        settled: false,
      };
      signal?.addEventListener("abort", () => {
        const queue = this.queues[priority];
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        this.settle(task, () => reject(new AbortedError()));
      });
      if (front) this.queues[priority].unshift(task);
      else this.queues[priority].push(task);
      this.start();
      this.pump();
    });
  }

  terminate() {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    for (const task of this.waiting()) this.settle(task, () => task.reject(new AbortedError()));
    this.queues = { preview: [], interactive: [], background: [] };
  }

  private settle(task: Task, finish: () => void) {
    if (task.settled) return;
    task.settled = true;
    finish();
  }

  private spawn() {
    const slot: Slot = { worker: this.createWorker(), ready: false, task: null };
    this.slots.push(slot);
    if (!this.slots.some((s) => s.ready)) this.publish({ phase: "loading", detail: "Starting the engine" });
    slot.worker.onmessage = (event) => this.receive(slot, event.data);
    slot.worker.onerror = (event) => this.fail(slot, event.message || "Engine worker crashed");
    slot.worker.postMessage({ type: "init", wheelUrl: this.wheelUrl });
  }

  private receive(slot: Slot, message: WorkerMessage) {
    if (message.type === "phase") {
      if (!this.slots.some((s) => s.ready)) this.publish({ phase: "loading", detail: message.phase });
    } else if (message.type === "ready") {
      slot.ready = true;
      this.restarts = 0;
      this.publish({ phase: "ready", detail: "" });
      this.pump();
    } else if (message.type === "fatal") {
      this.fail(slot, message.message);
    } else {
      const task = slot.task;
      slot.task = null;
      if (task) this.settle(task, () => task.resolve(JSON.parse(message.response) as BridgeResponse<unknown>));
      this.pump();
    }
  }

  private fail(slot: Slot, detail: string) {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    if (slot.task) {
      const task = slot.task;
      this.settle(task, () => task.reject(new Error(detail)));
    }
    if (this.slots.some((s) => s.ready)) return this.pump();
    if (this.slots.length) return;
    // A worker that had started and then died (for example out of memory on one
    // task) is replaced; only an engine that cannot start at all is a failure.
    if (slot.ready && this.restarts < 2) {
      this.restarts++;
      this.spawn();
      return this.pump();
    }
    this.publish({ phase: "failed", detail: `The calculation engine could not start: ${detail}` });
    for (const task of this.waiting()) this.settle(task, () => task.reject(new Error(detail)));
    this.queues = { preview: [], interactive: [], background: [] };
  }

  private pump() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.task) continue;
      const task = this.queues.preview.shift() ?? this.queues.interactive.shift() ?? this.queues.background.shift();
      if (!task) break;
      slot.task = task;
      slot.worker.postMessage({ type: "call", id: task.id, op: task.op, args: task.args });
    }
    const waiting = this.waiting().length;
    const starting = this.slots.filter((s) => !s.ready).length;
    // Grow only after one interpreter proved it can start, and only while work waits.
    if (waiting > starting && this.slots.some((s) => s.ready) && this.slots.length < this.maxSize) this.spawn();
    this.publish({});
  }

  private waiting() {
    return [...this.queues.preview, ...this.queues.interactive, ...this.queues.background];
  }

  private publish(change: Partial<PoolStatus>) {
    this.status = {
      ...this.status,
      ...change,
      workers: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.task).length,
    };
    for (const listener of this.listeners) listener(this.status);
  }
}
