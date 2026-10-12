import { describe, expect, it } from "vitest";
import {
  INPUT_DRAFT_FORMAT,
  INPUT_DRAFT_MAX_BYTES,
  inputDraftKey,
  readInputDraft,
  writeInputDraft,
} from "./inputDraft";
import type { DraftStorage } from "./inputDraft";
import {
  defaultProject,
  parseProjectFile,
  serializeProjectFile,
} from "./model";
import {
  canonicalProject2D,
  normalizeProject2D,
  stringify2DEnvelope,
} from "./project2d";
import circular from "./fixtures/default-project-circular.json";
import rectangular from "./fixtures/default-project-2d.json";

function storage(initial?: string) {
  let value: string | null = initial ?? null;
  const store: DraftStorage = {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
  return store;
}
const key = inputDraftKey(null);

describe("validated tab input recovery", () => {
  it("scopes explicit example profiles without storing arbitrary URL data", () => {
    expect(inputDraftKey("2d")).toBe(key);
    expect(inputDraftKey("unrelated-private-text")).toBe(key);
    expect(inputDraftKey("rectangle")).toBe(inputDraftKey("rectangular"));
    expect(inputDraftKey("rectangle")).not.toBe(key);
    expect(inputDraftKey("1d")).not.toBe(key);
  });
  it.each([circular, rectangular])(
    "restores exact normalized 1.2 inputs with signed zeros and no result",
    (fixture) => {
      const project = normalizeProject2D(fixture);
      project.illumination.angle_deg = -0;
      const store = storage();
      expect(writeInputDraft(store, key, project)).toBe("saved");
      const raw = JSON.parse(store.getItem(key)!);
      expect(Object.keys(raw).sort()).toEqual(["format", "project"]);
      expect(raw.format).toBe(INPUT_DRAFT_FORMAT);
      const restored = readInputDraft(store, key);
      expect(restored.status).toBe("restored");
      expect(canonicalProject2D(restored.project)).toBe(
        canonicalProject2D(project),
      );
      expect(Object.is(restored.project!.illumination.angle_deg, -0)).toBe(
        true,
      );
      expect(
        parseProjectFile(serializeProjectFile(restored.project!, null, null))
          .project,
      ).toEqual(project);
    },
  );
  it.each(["1.0", "1.1"] as const)(
    "keeps legacy %s inputs in their original schema",
    (version) => {
      const project = {
        ...structuredClone(defaultProject),
        schema_version: version,
      };
      const store = storage();
      expect(writeInputDraft(store, key, project)).toBe("saved");
      const restored = readInputDraft(store, key);
      expect(restored.status).toBe("restored");
      expect(restored.project?.schema_version).toBe(version);
      expect(restored.project?.period_nm).toBe(project.period_nm);
      expect(restored.project?.layers).toEqual(project.layers);
    },
  );
  it("never persists unrelated legacy metadata or result/provenance envelopes", () => {
    const project = structuredClone(defaultProject);
    Object.assign(project, { api_key: "must-not-be-stored" });
    const store = storage();
    expect(writeInputDraft(store, key, project)).toBe("invalid");
    expect(store.getItem(key)).toBeNull();
    for (const extra of ["result", "result_project", "job", "source_job_id"]) {
      const malicious = storage(
        JSON.stringify({
          format: INPUT_DRAFT_FORMAT,
          project: defaultProject,
          [extra]: {},
        }),
      );
      expect(readInputDraft(malicious, key)).toEqual({
        project: null,
        status: "invalid",
      });
    }
    Object.assign(project.ambient, { password: "must-not-be-stored" });
    delete (project as unknown as Record<string, unknown>).api_key;
    expect(writeInputDraft(store, key, project)).toBe("invalid");
  });
  it("safely ignores corrupt, unsupported, invalid and oversized drafts", () => {
    const invalidProject = { ...circular, period_nm: -1 };
    const values = [
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({ format: "rcwa-input-draft/99", project: circular }),
      JSON.stringify({ format: INPUT_DRAFT_FORMAT, project: invalidProject }),
      " ".repeat(INPUT_DRAFT_MAX_BYTES + 1),
    ];
    for (const raw of values)
      expect(readInputDraft(storage(raw), key)).toEqual({
        project: null,
        status: "invalid",
      });
    const duplicate = stringify2DEnvelope({
      format: INPUT_DRAFT_FORMAT,
      project: normalizeProject2D(circular),
    }).replace('"harmonics_x":5', '"harmonics_x":5.0');
    expect(readInputDraft(storage(duplicate), key).status).toBe("invalid");
  });
  it("does not overwrite the last valid draft with invalid edits", () => {
    const store = storage();
    expect(writeInputDraft(store, key, normalizeProject2D(circular))).toBe(
      "saved",
    );
    const before = store.getItem(key);
    const invalid = normalizeProject2D(circular);
    invalid.period_nm = -1;
    expect(writeInputDraft(store, key, invalid)).toBe("invalid");
    expect(store.getItem(key)).toBe(before);
  });
  it("invalidates an older saved draft when quota prevents saving newer inputs", () => {
    const store = storage();
    expect(writeInputDraft(store, key, defaultProject)).toBe("saved");
    store.setItem = () => {
      throw new Error("quota");
    };
    const edited = { ...defaultProject, name: "New unsaved edit" };
    expect(writeInputDraft(store, key, edited)).toBe("unavailable");
    expect(readInputDraft(store, key)).toEqual({
      project: null,
      status: "empty",
    });
  });
  it("invalidates an older draft for valid inputs larger than 512 KiB, without blocking export", () => {
    const store = storage();
    expect(writeInputDraft(store, key, defaultProject)).toBe("saved");
    const project = normalizeProject2D(circular);
    const table = {
      name: "Large valid table",
      kind: "tabulated" as const,
      n: 1,
      k: 0,
      wavelengths_nm: Array.from({ length: 2000 }, (_, i) => 200 + i),
      n_values: Array(2000).fill(1.123456789123456),
      k_values: Array(2000).fill(0.1234567891234567),
      source: "Synthetic recovery boundary fixture",
    };
    project.layers = Array.from({ length: 8 }, () => ({
      ...structuredClone(project.layers[0]),
      material: structuredClone(table),
      background: structuredClone(table),
    }));
    const exported = serializeProjectFile(project, null, null);
    expect(new TextEncoder().encode(exported).length).toBeGreaterThan(
      INPUT_DRAFT_MAX_BYTES,
    );
    expect(parseProjectFile(exported).project).toEqual(project);
    expect(writeInputDraft(store, key, project)).toBe("too-large");
    expect(readInputDraft(store, key)).toEqual({
      project: null,
      status: "empty",
    });
  });
  it("handles blocked reads, blocked writes and quota failures without throwing", () => {
    const blocked: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readInputDraft(blocked, key)).toEqual({
      project: null,
      status: "unavailable",
    });
    expect(writeInputDraft(blocked, key, defaultProject)).toBe("unavailable");
    expect(readInputDraft(null, key).status).toBe("unavailable");
    expect(writeInputDraft(null, key, defaultProject)).toBe("unavailable");
  });
});
