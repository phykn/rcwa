/* global document */
import assert from "node:assert/strict";

// A native modal may traverse browser chrome at the page boundary. It must
// never traverse the inert editor behind it. W3C H102 explicitly distinguishes
// these: https://www.w3.org/WAI/WCAG22/Techniques/html/H102
export function assertNativeModalFocusTrace(trace, direction, controlCount) {
  assert.ok(["forward", "backward"].includes(direction), "Known keyboard direction");
  assert.ok(controlCount >= 2, "The dialog has multiple keyboard controls");
  assert.ok(trace.length >= controlCount + 1, "Record a complete keyboard traversal");
  const visited = new Set();
  const kinds = trace.map((state) => {
    assert.equal(state.modal, true, "The native dialog remains modal throughout traversal");
    if (state.self) {
      assert.ok(state.tag === "DIALOG" && state.inside && state.hasFocus && !state.root && state.controlIndex === -1,
        "Only the exact focused modal container can be a native dialog stop");
      return "self";
    }
    if (state.inside) {
      assert.ok(state.hasFocus && !state.root && Number.isInteger(state.controlIndex) && state.controlIndex >= 0 && state.controlIndex < controlCount,
        "Focus stays on a visible dialog control");
      visited.add(state.controlIndex);
      return state.controlIndex;
    }
    assert.ok(state.root && !state.hasFocus && ["BODY", "HTML"].includes(state.tag) && state.controlIndex === -1,
      "Only browser chrome can leave the modal; background editor controls must never receive focus");
    return "chrome";
  });
  assert.equal(typeof kinds[0], "number", "Keyboard traversal starts on a dialog control");
  assert.equal(typeof kinds.at(-1), "number", "Keyboard traversal returns to a dialog control without forced focus");
  for (let index = 1; index < kinds.length; index++) {
    const previous = kinds[index - 1], current = kinds[index];
    const allowed = direction === "forward"
      ? previous === "chrome" ? ["self", 0]
        : previous === "self" ? [0]
          : previous === controlCount - 1 ? ["chrome", "self", 0] : [previous + 1]
      : previous === "chrome" ? [controlCount - 1]
        : previous === "self" ? ["chrome", controlCount - 1]
          : previous === 0 ? ["self", "chrome", controlCount - 1] : [previous - 1];
    assert.ok(allowed.includes(current), `Invalid ${direction} native focus transition: ${previous} -> ${current}`);
  }
  assert.equal(visited.size, controlCount, "Every visible dialog control is keyboard reachable");
}

export async function recordNativeModalKeyboard(page, dialog, report, width) {
  const snapshot = () => dialog.evaluate((node) => {
    const controls = [...node.querySelectorAll("button, a[href], summary")].filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
    const active = document.activeElement;
    return {
      tag: active?.tagName || null,
      id: active?.id || null,
      role: active?.getAttribute("role") || null,
      text: (active?.getAttribute("aria-label") || active?.textContent || "").trim().slice(0, 120),
      hasFocus: document.hasFocus(),
      modal: node.matches(":modal"),
      inside: !!active && node.contains(active),
      self: active === node,
      root: active === document.body || active === document.documentElement,
      controlIndex: controls.indexOf(active),
      controlCount: controls.length,
    };
  });
  const entry = {width, forward: [await snapshot()], backward: []};
  report.keyboard.push(entry);
  const count = entry.forward[0].controlCount;
  // Collect both directions before asserting so a failed run retains the full
  // native sequence, including previous/next states and document focus state.
  for (let step = 0; step < 2 * (count + 1); step++) {
    await page.keyboard.press("Tab");
    entry.forward.push(await snapshot());
  }
  for (let step = 0; step < 2 && entry.forward.at(-1).controlIndex < 0; step++) {
    await page.keyboard.press("Tab");
    entry.forward.push(await snapshot());
  }
  entry.backward.push(await snapshot());
  for (let step = 0; step < 2 * (count + 1); step++) {
    await page.keyboard.press("Shift+Tab");
    entry.backward.push(await snapshot());
  }
  for (let step = 0; step < 2 && entry.backward.at(-1).controlIndex < 0; step++) {
    await page.keyboard.press("Shift+Tab");
    entry.backward.push(await snapshot());
  }
  assertNativeModalFocusTrace(entry.forward, "forward", count);
  assertNativeModalFocusTrace(entry.backward, "backward", count);
  const backgroundFocusBlocked = await dialog.evaluate((node) => {
    const before = document.activeElement;
    document.querySelector("#project-name")?.focus();
    return node.matches(":modal") && document.activeElement === before && node.contains(before);
  });
  entry.backgroundFocusBlocked = backgroundFocusBlocked;
  assert.equal(backgroundFocusBlocked, true, "The modal prevents programmatic focus on the background editor");
}
