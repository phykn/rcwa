/** These are contract mutations, not new numerical solution fixtures. */
import { expect, it } from "vitest";
import vectors from "./fixtures/project-2d-conformance.json";
import { normalizeProject2D } from "./project2d";
import { bindResult2D, boundResult2DCompatibilityError } from "./result2d";

for (const vector of vectors.bindings) {
  it(`unchanged Python binder parity: ${vector.name}`, async () => {
    const project = normalizeProject2D(vector.project);
    const binding = bindResult2D(project, vector.result);
    if (vector.local_classification_ambiguous) {
      await expect(binding).rejects.toThrow(
        /ambiguous at a Rayleigh cutoff; import the project without its result/,
      );
      expect(
        boundResult2DCompatibilityError(project, vector.result),
      ).not.toBeNull();
    } else if (vector.accepted) {
      const result = await binding;
      expect(boundResult2DCompatibilityError(project, result)).toBeNull();
      expect(result.metadata.convergence_checked).toBe(false);
    } else {
      await expect(binding).rejects.toThrow();
    }
  });
}
