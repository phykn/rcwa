// UI evidence reuses archived production powers; no numerical work is run here.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";

export function orderFixture(name) {
  const { gate } = JSON.parse(
    gunzipSync(
      fs.readFileSync(
        new URL(`../../docs/true-2d/${name}-gate.json.gz`, import.meta.url),
      ),
    ),
  );
  return { project: gate.input, result: gate.production[0] };
}
export function pOnlyOrderFixture() {
  // Selection-only contract fixture, not a new solver result/provenance claim.
  // Every p value is unchanged from the genuine archived both-polarization run.
  // The exact hash is checked with the production binder in the unit tests.
  const data = orderFixture("multiple-open-channels");
  data.project.illumination.polarization = "p";
  data.result.spectra = { p: data.result.spectra.p };
  data.result.metadata.input_hash =
    "3454b9391e61349ebe818ed51ed44897244590b8146bb48348b2bfbeb057eb0d";
  return data;
}
