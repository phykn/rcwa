import { describe, expect, it } from "vitest";
import raw from "../../../backend/tests/fixtures/dimension-proposals-2d.json?raw";
import { normalizeDesign } from "./design";
import { reviewProposal } from "./proposal";

import { parseJSONWith2DNumberGate } from "./project2d";

type Case = { name: string; proposal: { base_project: unknown; candidate_project: unknown } };
// Parse keeps signed zeros; JSON.stringify would turn -0 into 0, so re-encode them.
const cases = parseJSONWith2DNumberGate(raw) as Case[];
const text = (value: unknown) =>
  JSON.stringify(value, (_, v) => (Object.is(v, -0) ? "__NEG0__" : v)).replace(/"__NEG0__"/g, "-0.0");

describe("change proposals", () => {
  for (const c of cases) {
    it(`rebuilds the server's candidate for ${c.name}`, () => {
      const base = normalizeDesign(c.proposal.base_project);
      const review = reviewProposal(text(c.proposal), base);
      expect(review.candidate).toEqual(normalizeDesign(c.proposal.candidate_project));
      if (c.name === "noop") expect(review.diff).toEqual([]);
      else expect(review.diff.length).toBeGreaterThan(0);
    });
  }

  it("ignores a forged candidate and rejects stale or widened proposals", () => {
    const c = cases[0];
    const base = normalizeDesign(c.proposal.base_project);
    const forged = { ...c.proposal, candidate_project: { ...base, name: "forged", period_nm: 4000 } };
    expect(reviewProposal(text(forged), base).candidate).toEqual(normalizeDesign(c.proposal.candidate_project));
    expect(() => reviewProposal(text(c.proposal), { ...base, period_nm: base.period_nm + 1 })).toThrow(/different design/);
    const widened = { ...c.proposal, changes: { ambient: { n: 2 } } };
    expect(() => reviewProposal(text(widened), base)).toThrow(/not a dimension/);
  });
});
