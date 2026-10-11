import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("disables 2D inspector backdrop blur without replacing the native scrim", () => {
  const structureCSS = readFileSync(
    new URL("./structure2d.css", import.meta.url),
    "utf8",
  );
  const backdrop = structureCSS.match(
    /\.inspector\.structure2d-inspector::backdrop\s*\{([^}]+)\}/,
  )?.[1];
  expect(backdrop).toMatch(/backdrop-filter:\s*none\s*;/);
  expect(backdrop).not.toMatch(/background(?:-color)?:/);
  const baseCSS = readFileSync(
    new URL("./styles.css", import.meta.url),
    "utf8",
  );
  expect(baseCSS).toMatch(
    /\.inspector::backdrop\s*\{[^}]*background:\s*rgb\(24 24 27 \/ 35%\)/,
  );
});
