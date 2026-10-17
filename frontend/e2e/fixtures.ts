import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

const CDN = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const LOCAL = resolve(import.meta.dirname, "../node_modules/pyodide");
const TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/zip",
};

/** Serve Pyodide from node_modules when the file is cached there; otherwise use the CDN. */
async function routePyodide(page: Page) {
  await page.context().route(`${CDN}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    const file = resolve(LOCAL, name);
    if (!existsSync(file)) return route.continue();
    const type = TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
    await route.fulfill({ body: readFileSync(file), contentType: type, headers: { "Access-Control-Allow-Origin": "*" } });
  });
}

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await routePyodide(page);
    await page.addInitScript(() => {
      // Skip the first-visit guide unless a test asks for it.
      if (!sessionStorage.getItem("keep-tour")) localStorage.setItem("rcwa.tour.v2", "done");
    });
    await use(page);
  },
});

export { expect };

export async function waitForEngine(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: /Engine ready|Local server/ })).toBeVisible({ timeout: 180_000 });
}

export async function waitUpToDate(page: Page, timeout = 180_000) {
  await expect(page.getByRole("status").filter({ hasText: /^Calculated in/ })).toBeVisible({ timeout });
}

export async function readout(page: Page) {
  const text = await page.getByLabel("Values at the inspected wavelength").locator("dl").innerText();
  return text.replace(/\s+/g, " ");
}

/** Turn on Advanced mode before the page loads. */
export async function useAdvanced(page: Page) {
  await page.addInitScript(() => localStorage.setItem("rcwa.settings.v2", JSON.stringify({ advanced: true })));
}
