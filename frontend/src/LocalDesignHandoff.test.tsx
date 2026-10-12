import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LocalDesignHandoff,
  POSIX_LOCAL_SETUP,
  WINDOWS_LOCAL_SETUP,
  FRONTEND_LOCAL_SETUP,
} from "./LocalDesignHandoff";
import { normalizeProject2D } from "./project2d";
import circle from "./fixtures/default-project-circular.json";

describe("input-only local design handoff", () => {
  it("gives one export action and the exact local import/run path in a named native dialog", () => {
    const project = normalizeProject2D(circle);
    Object.assign(project.layers[0], { diameter_nm: 70 });
    const html = renderToStaticMarkup(
      createElement(LocalDesignHandoff, { project, onClose: () => {} }),
    );
    expect(html).toContain(
      '<dialog class="local-handoff" aria-labelledby="local-handoff-title" aria-describedby="local-handoff-description"',
    );
    expect(html).toContain("Diameter 70 nm");
    expect(html).toContain("Export current inputs</button>");
    expect(html).toContain("No example spectrum is included.");
    expect(html).toContain("Project → Import JSON");
    expect(html).toContain("Run simulation");
    expect(html).toContain("Keep the API on 127.0.0.1.");
    expect(POSIX_LOCAL_SETUP).toContain(
      "git clone https://github.com/phykn/rcwa.git\ncd rcwa\npython3 -m venv .venv",
    );
    expect(POSIX_LOCAL_SETUP).toContain(
      "--app-dir backend --host 127.0.0.1 --port 8000",
    );
    expect(WINDOWS_LOCAL_SETUP).toContain(
      ".\\.venv\\Scripts\\python.exe -m uvicorn",
    );
    expect(FRONTEND_LOCAL_SETUP).toBe("cd frontend\nnpm ci\nnpm run dev");
  });
  it("does not export invalid input as a runnable design", () => {
    const project = normalizeProject2D(circle);
    project.period_nm = 0;
    const html = renderToStaticMarkup(
      createElement(LocalDesignHandoff, { project, onClose: () => {} }),
    );
    expect(html).toContain('disabled="">Export current inputs</button>');
    expect(html).toContain("Fix the input errors before exporting.");
  });
});
