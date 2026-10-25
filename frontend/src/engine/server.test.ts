import { afterEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "../core/templates";
import { ServerEngine } from "./server";

const design = TEMPLATES[0].design;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("ServerEngine", () => {
  it("keeps the API's typed error code and diagnostics", async () => {
    const diagnostic = { code: "capacity", severity: "error", location: [], message: "busy" };
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "busy", error: { code: "capacity", message: "busy", diagnostics: [diagnostic] } }, 429)));
    await expect(new ServerEngine("").solve(design)).rejects.toMatchObject({ code: "capacity", diagnostics: [diagnostic] });
  });

  it("cancels a job that was admitted while its submission was being aborted", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (init.method === "POST") {
        abort.abort();
        return json({ id: "j1", status: "running", result: null, error: null, error_code: null }, 202);
      }
      return json({});
    }));
    await expect(new ServerEngine("").solve(design, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toContain("DELETE /api/jobs/j1");
  });
});
