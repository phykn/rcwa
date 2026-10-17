import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, waitUpToDate } from "./fixtures";

// Needs a Python with backend/requirements*.txt installed: RCWA_E2E_PYTHON=/path/to/python
const python = process.env.RCWA_E2E_PYTHON;
let server: ChildProcess | undefined;

test.skip(!python, "Set RCWA_E2E_PYTHON to run the local-server checks.");

test.beforeAll(async () => {
  server = spawn(python!, ["-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "8000"], {
    cwd: resolve(import.meta.dirname, "../../backend"),
    env: { ...process.env, PYTHONPATH: ".", CORS_ORIGINS: "http://127.0.0.1:4173", DATABASE_URL: "sqlite:///:memory:" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch("http://127.0.0.1:8000/api/health")).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The local RCWA server did not start");
});

test.afterAll(() => {
  server?.kill();
});

test("uses a running local server for full calculations", async ({ app: page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Local server" })).toBeVisible({ timeout: 30_000 });
  const diameter = page.getByRole("textbox", { name: "Hole diameter", exact: true });
  await diameter.fill("100");
  await diameter.press("Enter");
  await waitUpToDate(page);
  await expect(page.getByRole("status").filter({ hasText: /on the local server/ })).toBeVisible();
});

test("fits on the local server when it is in use", async ({ app: page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Local server" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Fit" }).click();
  const rows = Array.from({ length: 5 }, (_, i) => `${450 + 100 * i}, ${(0.04 + 0.002 * i).toFixed(3)}`).join("\n");
  await page.getByRole("textbox", { name: /Measured spectrum/ }).fill(rows);
  await page.getByRole("checkbox", { name: /Layer 1 thickness/ }).check();
  const submitted = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST" && r.postDataJSON()?.kind === "fit");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await submitted;
  await expect(page.getByText(/RMS residual/)).toBeVisible({ timeout: 120_000 });
});
