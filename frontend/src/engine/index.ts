import { BrowserEngine } from "./browser";
import { defaultPoolSize, WorkerPool, type PoolStatus } from "./pyodide/pool";
import { MEENT_WHEEL } from "./pyodide/runtime";
import { ServerEngine } from "./server";
import type { Engine } from "./types";

export interface EngineState {
  browser: PoolStatus;
  serverAvailable: boolean;
  active: "browser" | "server";
}

/** Owns the worker pool and decides which engine handles a calculation. */
export class EngineHub {
  readonly pool: WorkerPool;
  private browser: BrowserEngine;
  private server: ServerEngine | null = null;
  private listeners = new Set<(state: EngineState) => void>();
  private poolStatus: PoolStatus = { phase: "idle", detail: "", workers: 0, busy: 0 };

  constructor(pool: WorkerPool) {
    this.pool = pool;
    this.browser = new BrowserEngine(pool);
    pool.subscribe((status) => {
      this.poolStatus = status;
      this.emit();
    });
  }

  static create() {
    const wheelUrl = new URL(`py/${MEENT_WHEEL}`, document.baseURI).href;
    const pool = new WorkerPool(
      () => new Worker(new URL("./pyodide/worker.ts", import.meta.url), { type: "module", name: "rcwa-engine" }),
      wheelUrl,
      defaultPoolSize(navigator as Navigator & { deviceMemory?: number }),
    );
    return new EngineHub(pool);
  }

  async detectServer(base = import.meta.env.VITE_API_BASE_URL ?? "") {
    this.server = await ServerEngine.probe(base);
    this.emit();
  }

  get engine(): Engine {
    return this.server ?? this.browser;
  }

  /** The browser engine also serves local work (preview, sweeps) when a server exists. */
  get browserEngine() {
    return this.browser;
  }

  get state(): EngineState {
    return { browser: this.poolStatus, serverAvailable: !!this.server, active: this.engine.kind };
  }

  subscribe(listener: (state: EngineState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => void this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }
}
