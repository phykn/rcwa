import { describe, expect, it } from "vitest";
import { assertNativeModalFocusTrace } from "../scripts/browser-native-dialog-focus.mjs";
import recorded from "./fixtures/native-modal-focus-036dca8.json";
const inside = (controlIndex) => ({inside: true, modal: true, hasFocus: true, root: false, controlIndex});
const chrome = () => ({tag: "BODY", inside: false, modal: true, hasFocus: false, root: true, self: false, controlIndex: -1});
const self = () => ({tag: "DIALOG", inside: true, modal: true, hasFocus: true, root: false, self: true, controlIndex: -1});

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


describe("complete native modal boundary variants", () => {
  it.each([[], ["chrome"], ["self"], ["chrome", "self"]])("accepts the ordered forward boundary %j and its reverse", (...boundary) => {
    const states = boundary.flat().map((kind) => kind === "chrome" ? chrome() : self());
    expect(() => assertNativeModalFocusTrace([inside(0), inside(1), inside(2), ...states, inside(0)], "forward", 3)).not.toThrow();
    expect(() => assertNativeModalFocusTrace([inside(2), inside(1), inside(0), ...states.toReversed(), inside(2)], "backward", 3)).not.toThrow();
  });
  it("replays real CI focus paths and requires completion of their partial endpoints", () => {
    // The original trace predates the exact-node self flag. Its sole DIALOG
    // was independently identified as the modal; preserve the original fields.
    const forward = recorded.forward.map((state) => ({...state, self: state.tag === "DIALOG"}));
    const backward = recorded.backward.map((state) => ({...state, self: state.tag === "DIALOG"}));
    expect(() => assertNativeModalFocusTrace(forward.slice(0, 9), "forward", 6)).not.toThrow();
    expect(() => assertNativeModalFocusTrace(backward.slice(2), "backward", 6)).not.toThrow();
    expect(() => assertNativeModalFocusTrace(forward, "forward", 6)).toThrow();
    expect(() => assertNativeModalFocusTrace(backward, "backward", 6)).toThrow();
    // Model the one additional real Tab required by the revised collector;
    // this appended control is a unit case, not claimed as captured CI evidence.
    expect(() => assertNativeModalFocusTrace([...forward, {...forward[7]}], "forward", 6)).not.toThrow();
  });
  it("rejects arbitrary inside nodes, counterfeit self flags and unordered boundaries", () => {
    const invalid = [
      [inside(0), self(), inside(1), inside(2), inside(0)],
      [inside(0), inside(1), inside(2), self(), chrome(), inside(0)],
      [inside(0), inside(1), inside(2), self(), self(), inside(0)],
      [inside(0), inside(1), inside(2), {...self(), self: false}, inside(0)],
      [inside(0), inside(1), inside(2), {...self(), tag: "DIV"}, inside(0)],
      [inside(0), inside(1), inside(2), {...self(), hasFocus: false}, inside(0)],
      [inside(0), inside(1), inside(2), {...self(), inside: false}, inside(0)],
      [inside(0), inside(1), inside(2), {...chrome(), tag: "INPUT"}, inside(0)],
      [inside(0), inside(0), inside(1), inside(2), inside(0)],
    ];
    for (const trace of invalid) expect(() => assertNativeModalFocusTrace(trace, "forward", 3)).toThrow();
  });
});
