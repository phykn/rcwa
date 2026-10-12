import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../scripts/browser-2d-controls.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, {recursive: true, force: true}))); });

async function fakePage(first, fallback) {
  const output = await mkdtemp(join(tmpdir(), "rcwa-capture-"));
  directories.push(output);
  const calls = {playwright: 0, cdp: 0, detached: 0};
  const page = {
    viewportSize: () => ({width: 1, height: 1}),
    screenshot: async ({path}) => { calls.playwright++; if (first === "fail") throw new Error("Original screenshot preparation timeout"); await writeFile(path, first === "invalid" ? Buffer.from("not PNG") : png); },
    context: () => ({newCDPSession: async () => ({
      send: async (method) => {
        if (method === "Page.getLayoutMetrics") return {cssContentSize: {x: 0, y: 0, width: 1, height: 1}};
        calls.cdp++; if (fallback === "fail") throw new Error("Final CDP capture failure");
        return {data: (fallback === "invalid" ? Buffer.from("not PNG") : png).toString("base64")};
      },
      detach: async () => { calls.detached++; },
    })}),
  };
  return {page, output, calls, report: {captures: [], screenshots: []}};
}
const options = {top: false, full: false, filenameFor: () => "stable-existing-name.png"};

describe("bounded screenshot evidence capture", () => {
  it("retains the original failure and verifies one same-page fallback PNG", async () => {
    const {page, output, calls, report} = await fakePage("fail", "pass");
    await capture(page, report, output, "ignored", options);
    expect(calls).toEqual({playwright: 1, cdp: 1, detached: 1});
    expect(report.captures[0].attempts.map((a) => [a.method, a.status])).toEqual([["playwright", "failed"], ["cdp", "passed"]]);
    expect(report.captures[0].attempts[0].error).toContain("Original screenshot preparation timeout");
    expect(report.captures[0].attempts[1]).toMatchObject({width: 1, height: 1});
    expect(report.screenshots).toEqual(["stable-existing-name.png"]);
  });
  it.each(["fail", "invalid"])("fails after two attempts when the fallback is %s; no missing image is accepted", async (fallback) => {
    const {page, output, calls, report} = await fakePage("fail", fallback);
    await expect(capture(page, report, output, "ignored", options)).rejects.toThrow("Every required screenshot");
    expect(calls).toEqual({playwright: 1, cdp: 1, detached: 1});
    expect(report.captures[0].attempts).toHaveLength(2);
    expect(report.captures[0].attempts.every((a) => a.status === "failed")).toBe(true);
    expect(report.screenshots).toEqual([]);
  });
});
