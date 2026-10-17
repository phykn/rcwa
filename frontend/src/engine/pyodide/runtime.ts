import type { PyodideAPI } from "pyodide";

export const PYODIDE_VERSION = "0.28.3";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const MEENT_WHEEL = "meent-0.13.2-py3-none-any.whl";
const PACKAGES = ["numpy", "scipy", "pydantic", "micropip"];

export type BridgeOp = "validate" | "solve" | "assemble" | "forward" | "field" | "fit";

export interface BridgeFailure {
  ok: false;
  code: string;
  message: string;
  diagnostics?: unknown[];
}
export type BridgeResponse<T = unknown> = { ok: true; value: T } | BridgeFailure;

export interface PyRuntime {
  call(op: BridgeOp, ...args: (string | number)[]): string;
}

/** Install meent and rcwa_core into a fresh interpreter and import the bridge. */
export async function prepareRuntime(
  py: PyodideAPI,
  wheel: Uint8Array,
  sources: Record<string, string>,
  bridge: string,
  onPhase: (phase: string) => void = () => {},
): Promise<PyRuntime> {
  onPhase("Loading numerical packages");
  const failures: string[] = [];
  await py.loadPackage(PACKAGES, { messageCallback: () => {}, errorCallback: (message) => failures.push(message) });
  if (failures.length) throw new Error(failures.join("; ").slice(0, 400));
  onPhase("Installing the RCWA engine");
  py.FS.mkdirTree("/tmp/wheels");
  py.FS.writeFile(`/tmp/wheels/${MEENT_WHEEL}`, wheel);
  await py.runPythonAsync(
    `import micropip\nawait micropip.install("emfs:/tmp/wheels/${MEENT_WHEEL}", deps=False)`,
  );
  py.FS.mkdirTree("/home/pyodide/rcwa_core");
  for (const [name, text] of Object.entries(sources))
    py.FS.writeFile(`/home/pyodide/rcwa_core/${name}`, text);
  py.FS.writeFile("/home/pyodide/rcwa_bridge.py", bridge);
  py.runPython("import sys\nsys.path.insert(0, '/home/pyodide')\nimport rcwa_bridge");
  const module = py.pyimport("rcwa_bridge");
  return {
    call(op, ...args) {
      const fn = module[op];
      if (!fn) throw new Error(`Unknown engine operation: ${op}`);
      return fn(...args) as string;
    },
  };
}

/** Map `.../rcwa_core/name.py` glob keys to bare file names. */
export function coreSources(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(modules)) {
    const name = path.split("/").pop()!;
    if (name.endsWith(".py")) out[name] = text;
  }
  if (!out["__init__.py"]) out["__init__.py"] = "";
  return out;
}
