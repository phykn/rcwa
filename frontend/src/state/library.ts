import type { Design, SpectrumResult } from "../engine/types";

export interface SavedDesign {
  id: string;
  name: string;
  design: Design;
  result: SpectrumResult | null;
  savedAt: number;
}

const DB = "rcwa-workbench";
const STORE = "designs";
let memory: SavedDesign[] = [];

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Designs saved in this browser; falls back to memory when storage is blocked. */
export async function listSaved(): Promise<SavedDesign[]> {
  const items = (await run("readonly", (s) => s.getAll() as IDBRequest<SavedDesign[]>)) ?? memory;
  return [...items].sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveDesign(design: Design, result: SpectrumResult | null): Promise<SavedDesign> {
  const item: SavedDesign = {
    id: crypto.randomUUID(),
    name: design.name,
    design,
    result,
    savedAt: Date.now(),
  };
  if ((await run("readwrite", (s) => s.put(item))) === null) memory = [...memory, item];
  return item;
}

export async function deleteSaved(id: string) {
  if ((await run("readwrite", (s) => s.delete(id))) === null) memory = memory.filter((m) => m.id !== id);
}
