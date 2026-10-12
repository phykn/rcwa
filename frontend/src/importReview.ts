import type { ProjectFile } from "./model";
import { validLayerIndex } from "./model";
import { sameNormalizedProject } from "./workflow";
import type { Workspace } from "./workflow";

/** Stage already-validated 1.2 inputs, without installing or rebinding a result. */
export function reviewImportedDesign(data: ProjectFile, current: Workspace) {
  if (data.project.schema_version !== "1.2" || data.result) return null;
  return {
    unchanged: sameNormalizedProject(current.project, data.project),
    workspace: {
      project: data.project,
      displayedRun: current.displayedRun,
      selectedLayer: validLayerIndex(data.project, current.selectedLayer),
    } satisfies Workspace,
  };
}
