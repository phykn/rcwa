import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("disables every inspector backdrop blur without replacing the native scrim", () => {
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
  const baseBackdrop = baseCSS.match(
    /\.inspector::backdrop\s*\{([^}]+)\}/,
  )?.[1];
  expect(baseBackdrop).toMatch(/background:\s*rgb\(24 24 27 \/ 35%\)/);
  expect(baseBackdrop).toMatch(/backdrop-filter:\s*none\s*;/);
});

it("keeps legacy exact dimension numbers at the readable 2D font size", () => {
  const baseCSS = readFileSync(
    new URL("./styles.css", import.meta.url),
    "utf8",
  );
  const structureCSS = readFileSync(
    new URL("./structure2d.css", import.meta.url),
    "utf8",
  );
  const legacy = baseCSS.match(
    /\.inspector \.field input\[id\^="dimension-"\]\s*\{([^}]+)\}/,
  )?.[1];
  const paired = structureCSS.match(
    /\.s2-field input\[type="number"\]\s*\{([^}]+)\}/,
  )?.[1];
  expect(legacy).toMatch(/font-size:\s*28px\s*;/);
  expect(paired).toMatch(/font-size:\s*28px\s*;/);
});
