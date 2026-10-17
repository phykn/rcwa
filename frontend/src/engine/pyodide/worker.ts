/// <reference lib="webworker" />
import type { PyodideAPI } from "pyodide";
import bridge from "./bridge.py?raw";
import { coreSources, prepareRuntime, PYODIDE_INDEX_URL, type BridgeOp, type PyRuntime } from "./runtime";

const modules = import.meta.glob("../../../../backend/rcwa_core/*.py", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type WorkerRequest =
  | { type: "init"; wheelUrl: string }
  | { type: "call"; id: number; op: BridgeOp; args: (string | number)[] };

export type WorkerMessage =
  | { type: "phase"; phase: string }
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "result"; id: number; response: string; ms: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let runtime: PyRuntime | null = null;
const post = (message: WorkerMessage) => scope.postMessage(message);

async function init(wheelUrl: string) {
  post({ type: "phase", phase: "Downloading Python" });
  const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideAPI>;
  };
  const [py, wheel] = await Promise.all([
    loadPyodide({ indexURL: PYODIDE_INDEX_URL }),
    fetch(wheelUrl).then((r) => {
      if (!r.ok) throw new Error(`Engine package missing (${r.status})`);
      return r.arrayBuffer();
    }),
  ]);
  runtime = await prepareRuntime(py, new Uint8Array(wheel), coreSources(modules), bridge, (phase) =>
    post({ type: "phase", phase }),
  );
  post({ type: "ready" });
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    init(message.wheelUrl).catch((error: unknown) =>
      post({ type: "fatal", message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  const started = performance.now();
  let response: string;
  try {
    if (!runtime) throw new Error("Engine is not ready");
    response = runtime.call(message.op, ...message.args);
  } catch (error) {
    response = JSON.stringify({
      ok: false,
      code: "engine_error",
      message: error instanceof Error ? error.message.slice(-400) : String(error),
    });
  }
  post({ type: "result", id: message.id, response, ms: performance.now() - started });
};
