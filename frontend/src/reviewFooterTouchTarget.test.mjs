import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level guard only; CI browser tests verify real rendered bounds and hits.
describe("review footer touch targets", () => {
  it("sets both minimum axes on footer buttons without enlarging every text button", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.workflow-actions\s*>\s*button\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/min-inline-size:\s*44px\s*;/);
    expect(rule).toMatch(/min-block-size:\s*44px\s*;/);
  });
});
