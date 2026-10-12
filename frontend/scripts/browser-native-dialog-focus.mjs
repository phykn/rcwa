/* global document */
import assert from "node:assert/strict";

// A native modal may traverse browser chrome at the page boundary. It must
// never traverse the inert editor behind it. W3C H102 explicitly distinguishes
// these: https://www.w3.org/WAI/WCAG22/Techniques/html/H102
export function assertNativeModalFocusTrace(trace, direction, controlCount) {
  assert.ok(controlCount >= 2, "The dialog has multiple keyboard controls");
  assert.ok(trace.length >= controlCount + 1, "Record a complete keyboard traversal");
  assert.equal(trace[0].inside, true, "Keyboard traversal starts in the dialog");
  assert.equal(trace.at(-1).inside, true, "Keyboard traversal returns to the dialog without forced focus");
  const visited = new Set();
  for (let index = 0; index < trace.length; index++) {
    const state = trace[index];
    assert.equal(state.modal, true, "The native dialog remains modal throughout traversal");
    if (state.inside) {
      assert.ok(state.controlIndex >= 0 && state.controlIndex < controlCount, "Focus stays on a visible dialog control");
      visited.add(state.controlIndex);
      continue;
    }
    // Do not accept BODY as a blanket exception: prove a one-step chrome
    // boundary, with no page focus, exactly between the modal's end controls.
    assert.equal(state.root, true, "Background editor controls must never receive focus");
    assert.equal(state.hasFocus, false, "Only browser-chrome focus may leave the modal DOM");
    const previous = trace[index - 1], next = trace[index + 1];
    assert.equal(previous?.inside, true, "Chrome boundary immediately follows a dialog control");
    assert.equal(next?.inside, true, "Next Tab returns directly to the dialog");
    assert.equal(previous.controlIndex, direction === "forward" ? controlCount - 1 : 0, "Chrome boundary leaves the correct end control");
    assert.equal(next.controlIndex, direction === "forward" ? 0 : controlCount - 1, "Chrome boundary returns at the opposite end control");
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
  entry.backward.push(await snapshot());
  for (let step = 0; step < 2 * (count + 1); step++) {
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
