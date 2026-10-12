import { describe, expect, it } from "vitest";
import { assertNativeModalFocusTrace } from "../scripts/browser-native-dialog-focus.mjs";
const inside = (controlIndex) => ({inside: true, modal: true, hasFocus: true, root: false, controlIndex});
const chrome = () => ({inside: false, modal: true, hasFocus: false, root: true, controlIndex: -1});

describe("native modal keyboard acceptance", () => {
  it("accepts dialog-only cycling and a proven browser chrome boundary in both directions", () => {
    for (const trace of [[inside(0), inside(1), inside(2), inside(0)], [inside(0), inside(1), inside(2), chrome(), inside(0)]])
      expect(() => assertNativeModalFocusTrace(trace, "forward", 3)).not.toThrow();
    expect(() => assertNativeModalFocusTrace([inside(2), inside(1), inside(0), chrome(), inside(2)], "backward", 3)).not.toThrow();
  });
  it("rejects background controls, focused BODY, nonmodal state and a missing return", () => {
    const valid = [inside(0), inside(1), inside(2), chrome(), inside(0)];
    for (const changed of [{root: false, tag: "INPUT"}, {hasFocus: true}, {modal: false}]) {
      const trace = valid.map((state) => ({...state}));
      Object.assign(trace[3], changed);
      expect(() => assertNativeModalFocusTrace(trace, "forward", 3)).toThrow();
    }
    expect(() => assertNativeModalFocusTrace(valid.slice(0, -1), "forward", 3)).toThrow();
  });
  it("rejects arbitrary root allowances, consecutive boundaries and unreachable controls", () => {
    for (const trace of [
      [inside(0), chrome(), inside(1), inside(2)],
      [inside(0), inside(1), inside(2), chrome(), inside(1)],
      [inside(0), inside(1), inside(2), chrome(), chrome(), inside(0)],
      [inside(0), inside(2), chrome(), inside(0)],
    ]) expect(() => assertNativeModalFocusTrace(trace, "forward", 3)).toThrow();
  });
});
