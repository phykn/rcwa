import { describe, expect, it } from "vitest";
import { runBrowserScenario } from "../scripts/browser-scenario.mjs";

describe("independent browser scenario reporting", () => {
  it("retains exact failure detail and runs subsequent cases", async () => {
    const report = { groups: [], issues: [] },
      ran = [];
    for (const name of ["typed-to-drag", "canceled-gesture", "fractional-edge"])
      await runBrowserScenario(report, name, async () => {
        ran.push(name);
        if (name === "typed-to-drag") throw new Error("180 !== 180.125");
      });
    expect(ran).toEqual([
      "typed-to-drag",
      "canceled-gesture",
      "fractional-edge",
    ]);
    expect(report.groups.map(({ status }) => status)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toContain("typed-to-drag: Error: 180 !== 180.125");
    expect(report.groups.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
  });
});
