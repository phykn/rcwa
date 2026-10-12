import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assertSameSavedExport } from "../scripts/saved-recovery-browser-cases.mjs";
import { serializeProjectFile } from "./model";

const reference = JSON.parse(
  readFileSync(
    new URL("../public/reference-example.json", import.meta.url),
    "utf8",
  ),
);
const firstTimestamp = "2026-10-12T11:33:16.094Z";
const secondTimestamp = "2026-10-12T11:33:17.991Z";
const exported = (timestamp = firstTimestamp) =>
  JSON.parse(
    serializeProjectFile(
      reference.project,
      reference.result,
      reference.project,
      timestamp,
    ),
  );

describe("saved recovery exact-export assertions", () => {
  it("accepts separately generated exports of the complete same workspace without mutating either", () => {
    const expected = exported();
    const actual = exported(secondTimestamp);
    const before = globalThis.structuredClone([actual, expected]);
    expect(() => assertSameSavedExport(actual, expected)).not.toThrow();
    expect([actual, expected]).toEqual(before);
    expect(actual.exported_at).not.toBe(expected.exported_at);
  });
  it.each([
    [
      "edited input",
      (data) => {
        data.project.layers[0].cd_nm += 1;
      },
    ],
    [
      "original result input",
      (data) => {
        data.result_project.layers[0].cd_nm += 1;
      },
    ],
    [
      "spectrum value",
      (data) => {
        data.result.spectra.s.R[0] += 0.001;
      },
    ],
    [
      "result hash",
      (data) => {
        data.result.metadata.input_hash = "changed";
      },
    ],
    [
      "warning",
      (data) => {
        data.result.metadata.warnings = ["new warning"];
      },
    ],
    [
      "provenance",
      (data) => {
        data.provenance = { source: "server_computed", job_id: "unexpected" };
      },
    ],
    [
      "format",
      (data) => {
        data.format = "different-format";
      },
    ],
    [
      "removed field",
      (data) => {
        delete data.result_project;
      },
    ],
    [
      "unknown future field",
      (data) => {
        data.future_identity = "unexpected";
      },
    ],
  ])(
    "rejects a change to %s even when the download timestamp also changes",
    (_label, mutate) => {
      const actual = exported(secondTimestamp);
      mutate(actual);
      expect(() => assertSameSavedExport(actual, exported())).toThrow();
    },
  );
  it("distinguishes positive and negative zero in an input", () => {
    const expected = exported();
    expected.project.illumination.angle_deg = 0;
    const actual = globalThis.structuredClone(expected);
    actual.exported_at = secondTimestamp;
    actual.project.illumination.angle_deg = -0;
    expect(() => assertSameSavedExport(actual, expected)).toThrow();
  });
  it("does not ignore nested fields that happen to be named exported_at", () => {
    const expected = exported();
    expected.result.metadata.exported_at = firstTimestamp;
    const actual = globalThis.structuredClone(expected);
    actual.exported_at = secondTimestamp;
    actual.result.metadata.exported_at = secondTimestamp;
    expect(() => assertSameSavedExport(actual, expected)).toThrow();
  });
  it.each([
    undefined,
    null,
    1,
    "",
    "not-a-date",
    "2026-02-30T00:00:00.000Z",
    "2026-10-12",
  ])("rejects missing or invalid timestamp %s on either side", (timestamp) => {
    const invalid = exported();
    invalid.exported_at = timestamp;
    expect(() => assertSameSavedExport(invalid, exported())).toThrow();
    expect(() => assertSameSavedExport(exported(), invalid)).toThrow();
  });
});
