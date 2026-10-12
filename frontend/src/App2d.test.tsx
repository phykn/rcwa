import { afterEach, describe, expect, it, vi } from "vitest";
import circular from "./fixtures/default-project-circular.json";
import { INPUT_DRAFT_FORMAT, inputDraftKey } from "./inputDraft";
import { normalizeProject2D, stringify2DEnvelope } from "./project2d";

// App's environment is resolved by Vite before the SSR import. Exercise each
// build mode through the ordinary and VITE_STATIC_PREVIEW=true test commands.
const mode =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_STATIC_PREVIEW === "true"
    ? "static"
    : "local";

async function renderExample(search: string, draft?: string) {
  vi.resetModules();
  vi.stubEnv("VITE_STATIC_PREVIEW", mode === "static" ? "true" : "false");
  vi.stubGlobal("window", {
    location: { search },
    sessionStorage: {
      getItem: (key: string) =>
        key === inputDraftKey(new URLSearchParams(search).get("example"))
          ? (draft ?? null)
          : null,
    },
  });
  const [{ createElement }, { renderToStaticMarkup }, { default: App }] =
    await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("./App"),
    ]);
  return renderToStaticMarkup(createElement(App));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe(`${mode} production default versus explicit legacy fixture`, () => {
  it.each(["?example=rectangle", "?example=rectangular"])(
    "retains historical rectangular inputs explicitly at %s",
    async (search) => {
      const html = await renderExample(search);
      expect(html).toContain(
        'value="Synthetic subwavelength 2D dielectric stack"',
      );
      expect(html.match(/class="stack-row(?: |")/g)).toHaveLength(3);
      expect(html).toContain(
        'aria-label="Edit Layer 1 width: X 70 nanometers, Y 60 nanometers"',
      );
      expect(html).toContain(
        'aria-label="Edit shared pitch: X 150 nanometers, Y 140 nanometers"',
      );
      expect(html).toContain('class="s2-scene"');
      expect(html).not.toContain('class="three-canvas');
      expect(html).toContain(
        "Synthetic width fitting is not supported for schema 1.2",
      );
    },
  );
  it.each(["", "?example=2d", "?unrelated=1d"])(
    `uses the genuine circular-hole default and ${mode} primary action at %s`,
    async (search) => {
      const html = await renderExample(search);
      expect(html).toContain(`value="${circular.name}"`);
      expect(html.match(/class="stack-row(?: |")/g)).toHaveLength(
        circular.layers.length,
      );
      expect(html).toContain(
        `aria-label="Edit Layer 1 diameter: ${circular.layers[0].diameter_nm} nanometers"`,
      );
      expect(html).not.toContain('aria-label="Edit Layer 1 width:');
      expect(html).toContain('class="s2-scene"');
      if (mode === "static") {
        expect(html).toContain(
          'class="preview-result-button" href="#spectrum"',
        );
        // SSR has not loaded the bundled reference yet; its initial action
        // remains the spectrum link rather than a local computation button.
        expect(html).toContain("View spectrum");
        expect(html).toContain("Static preview");
        expect(html).toContain(
          "Preview only. Edits won&#x27;t calculate a new spectrum.",
        );
        expect(html).not.toContain('class="run-button"');
        expect(html).not.toContain("Run simulation");
      } else {
        expect(html).toContain('class="run-button"');
        expect(html).toContain("Run simulation");
        expect(html).not.toContain('class="preview-result-button"');
        expect(html).not.toContain("Preview only.");
      }
      expect(html).not.toContain('class="three-canvas');
    },
  );
  it("scopes the WebGL-safe inspector class to every 2D project", async () => {
    for (const search of ["", "?example=rectangle"]) {
      const html = await renderExample(search);
      expect(html).toContain('class="inspector structure2d-inspector"');
    }
    const legacy = await renderExample("?example=1d");
    expect(legacy).not.toContain("structure2d-inspector");
  });
  it("restores valid edited inputs without restoring any example spectrum or provenance", async () => {
    const project = normalizeProject2D(circular);
    project.name = "Recovered design";
    Object.assign(project.layers[0], { diameter_nm: 70 });
    const html = await renderExample(
      "",
      stringify2DEnvelope({ format: INPUT_DRAFT_FORMAT, project }),
    );
    expect(html).toContain('value="Recovered design"');
    expect(html).toContain('aria-label="Edit Layer 1 diameter: 70 nanometers"');
    expect(html).toContain("No result yet");
    expect(html).toContain("No result or undo history was restored.");
    expect(html).not.toContain("Precomputed example");
    if (mode === "static") {
      expect(html).toContain("Use this design locally");
      expect(html).not.toContain('href="#spectrum"');
    }
  });
  it("keeps corrupt storage recoverable without breaking the example", async () => {
    const html = await renderExample("", "{corrupt");
    expect(html).toContain(`value="${circular.name}"`);
    expect(html).toContain("Saved tab inputs could not be restored.");
    expect(html).toContain("Export inputs");
  });
  it("keeps the original 1D fixture explicit without changing ordinary URLs", async () => {
    const html = await renderExample("?example=1d");
    expect(html).toContain('value="One-layer grating"');
    expect(html.match(/class="stack-row(?: |")/g)).toHaveLength(1);
    expect(html).not.toContain('class="s2-scene"');
    expect(html).toContain("Shared pitch");
  });
});
