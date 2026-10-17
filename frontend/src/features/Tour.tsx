import { useLayoutEffect, useState } from "react";

const STEPS = [
  { target: "stack", title: "Build the stack", text: "Layers run from the incident medium at the top to the substrate below. Select one to edit it." },
  { target: "inspector", title: "Change a dimension", text: "Drag a slider or type a value. A quick preview follows your hand; the full calculation runs when you pause." },
  { target: "results", title: "Read the result", text: "Reflection, transmission and absorption against wavelength. Click the chart to inspect one wavelength and its color." },
  { target: "tabs", title: "Go deeper", text: "Sweep a dimension, view the field inside the structure, check convergence, or fit a measured spectrum." },
];

export const TOUR_KEY = "rcwa.tour.v2";

/** Four anchored hints; the anchor is the element with the matching data-tour. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const current = STEPS[step];
  useLayoutEffect(() => {
    const el = document.querySelector(`[data-tour="${current.target}"]`);
    el?.scrollIntoView({ block: "nearest" });
    const measure = () => setRect(el?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [current.target]);
  const finish = () => {
    try {
      localStorage.setItem(TOUR_KEY, "done");
    } catch {
      // The guide simply shows again next time.
    }
    onClose();
  };
  const width = Math.min(320, window.innerWidth - 32);
  const left = rect ? Math.min(Math.max(16, rect.left + 16), window.innerWidth - width - 16) : 16;
  const top = rect ? Math.min(rect.top + 16, window.innerHeight - 200) : 80;
  return (
    <div className="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      {rect && (
        <div className="tour-ring" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden />
      )}
      <div className="tour-card" style={{ left, top, width }}>
        <p className="tour-step">
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 id="tour-title">{current.title}</h2>
        <p>{current.text}</p>
        <div className="tour-actions">
          <button type="button" className="btn btn-quiet" onClick={finish}>
            Skip
          </button>
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button type="button" className="btn btn-primary" autoFocus onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}>
            {step === STEPS.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
