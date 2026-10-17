import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./app/App";
import { DEFAULT_TEMPLATE } from "./core/templates";
import { normalizeDesign } from "./core/design";
import { decodeShare } from "./core/share";
import { mergeResults } from "./engine/chunks";
import { EngineHub } from "./engine";
import type { Design, PublicForwardResult2D } from "./engine/types";
import { connectCalculation } from "./state/calc";
import { ServicesContext } from "./state/context";
import { useStore } from "./state/store";
import { TOUR_KEY } from "./features/Tour";

const DRAFT_KEY = "rcwa.draft.v2";

async function initialDesign(): Promise<{ design: Design; source: "link" | "draft" | "example" }> {
  try {
    const shared = await decodeShare(location.hash);
    if (shared) return { design: shared, source: "link" };
  } catch {
    useStore.getState().notify("The shared link is damaged; opened the example instead.", "error");
  }
  try {
    const draft = sessionStorage.getItem(DRAFT_KEY);
    if (draft) return { design: normalizeDesign(JSON.parse(draft)), source: "draft" };
  } catch {
    // A stale or blocked draft falls back to the example.
  }
  return { design: DEFAULT_TEMPLATE.design, source: "example" };
}

async function exampleResult() {
  try {
    const response = await fetch(new URL("reference-circular.json", document.baseURI));
    const body = (await response.json()) as { result: PublicForwardResult2D };
    return mergeResults([body.result], "browser", body.result.metadata.elapsed_seconds as number);
  } catch {
    return null;
  }
}

async function main() {
  const hub = EngineHub.create();
  hub.pool.start();
  void hub.detectServer();
  const { design, source } = await initialDesign();
  const result = source === "example" ? await exampleResult() : null;
  useStore.getState().replace(design, result);
  useStore.setState({ past: [], cursor: design.illumination.wavelengths_nm[0] });
  const calc = connectCalculation(hub);

  let draftTimer = 0;
  useStore.subscribe((state, previous) => {
    if (state.key === previous.key) return;
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.design));
      } catch {
        // Drafts are a convenience; storage may be full or blocked.
      }
    }, 400);
  });

  let firstVisit: boolean;
  try {
    firstVisit = !localStorage.getItem(TOUR_KEY);
  } catch {
    firstVisit = false;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ServicesContext.Provider value={{ hub, calc }}>
        <App firstVisit={firstVisit} />
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

void main();
