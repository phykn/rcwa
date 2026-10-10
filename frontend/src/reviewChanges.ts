import type { Layer, Material, Project } from "./model";
import { semanticEqual, summarizeMaterial } from "./workflow";

export interface ReviewChange {
  key: string;
  label: string;
  before: string;
  after: string;
  detail?: string;
}

const geometryName = (value: Layer["geometry"] | undefined) =>
  value === "homogeneous"
    ? "Uniform film"
    : value === "rectangle_1d"
      ? "Patterned grating"
      : "Not present";
const valueText = (value: unknown, unit = "") =>
  value === undefined
    ? "Not set"
    : value === null
      ? "None"
      : `${String(value)}${unit}`;
const layerLabel = (index: number, layer: Layer) =>
  `Layer ${index + 1} · ${layer.name}`;
const orderText = (layers: Layer[]) =>
  layers.map((layer, index) => `${index + 1}. ${layer.name}`).join(" · ");

function tableText(material: Material | undefined) {
  if (!material) return "Not present";
  const table = summarizeMaterial(material).table;
  if (!table) return "No table";
  return `${table.rows} rows · ${table.wavelength_min_nm}–${table.wavelength_max_nm} nm · ${table.checksum}`;
}

/** Display only. Exact projects, proposal diffs and validation remain untouched. */
export function reviewInputChanges(
  before: Project,
  after: Project,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const legacy =
    before.schema_version === "1.0" && after.schema_version === "1.0";
  function field(
    key: string,
    label: string,
    a: unknown,
    b: unknown,
    format = valueText,
  ) {
    if (!semanticEqual(a, b))
      changes.push({ key, label, before: format(a), after: format(b) });
  }
  function material(
    key: string,
    label: string,
    a: Material | undefined,
    b: Material | undefined,
  ) {
    const tableKind = a?.kind === "tabulated" || b?.kind === "tabulated";
    for (const [property, name] of [
      ["name", "Material name"],
      ["kind", "Optical model"],
      ["n", tableKind ? "Scalar n (table placeholder)" : "Refractive index n"],
      [
        "k",
        tableKind ? "Scalar k (table placeholder)" : "Extinction coefficient k",
      ],
      ["source", "Source"],
    ] as const)
      field(
        `${key}.${property}`,
        `${label} · ${name}`,
        a?.[property],
        b?.[property],
        property === "kind"
          ? (value) =>
              value === "constant"
                ? "Constant n/k"
                : value === "tabulated"
                  ? "Tabulated n/k"
                  : "Not present"
          : valueText,
      );
    const columns = [
      ["wavelengths_nm", "wavelength"],
      ["n_values", "n"],
      ["k_values", "k"],
    ] as const;
    const changedColumns = columns.filter(
      ([property]) => !semanticEqual(a?.[property], b?.[property]),
    );
    if (!changedColumns.length) return;
    // Compare actual samples as well as the existing compact fingerprint: even
    // a fingerprint collision or null/omitted-field edit must remain visible.
    const rows = new Set<number>();
    for (const [property] of changedColumns)
      for (
        let index = 0;
        index <
        Math.max(a?.[property]?.length ?? 0, b?.[property]?.length ?? 0);
        index++
      )
        if (a?.[property]?.[index] !== b?.[property]?.[index]) rows.add(index);
    if (rows.size)
      changes.push({
        key: `${key}.table`,
        label: `${label} · Optical table`,
        before: tableText(a),
        after: tableText(b),
        detail: `${rows.size} ${rows.size === 1 ? "row" : "rows"} changed (${changedColumns.map(([, name]) => name).join(", ")}). Exact samples are in Full inputs.`,
      });
    // Missing and explicit null are distinct input representations. Keep those
    // changes visible even though both represent an unused table column.
    for (const [property, name] of changedColumns)
      if (!Array.isArray(a?.[property]) && !Array.isArray(b?.[property]))
        field(
          `${key}.${property}`,
          `${label} · ${name} table input`,
          a?.[property],
          b?.[property],
        );
  }
  function layer(a: Layer | undefined, b: Layer | undefined, index: number) {
    const key = `layers[${index}]`;
    const label = layerLabel(index, b ?? a!);
    if (!a || !b)
      changes.push({
        key,
        label,
        before: a ? geometryName(a.geometry) : "Not present",
        after: b
          ? `Added ${geometryName(b.geometry).toLowerCase()}`
          : "Removed",
      });
    else {
      field(`${key}.name`, `Layer ${index + 1} · Name`, a.name, b.name);
      field(
        `${key}.geometry`,
        `${label} · Type`,
        a.geometry,
        b.geometry,
        (value) => geometryName(value as Layer["geometry"]),
      );
    }
    field(
      `${key}.thickness_nm`,
      legacy && index === 0 ? "Height" : `${label} · Thickness`,
      a?.thickness_nm,
      b?.thickness_nm,
      (value) => valueText(value, " nm"),
    );
    field(
      `${key}.cd_nm`,
      legacy && index === 0 ? "Width" : `${label} · Width (CD)`,
      a?.geometry === "rectangle_1d" ? a.cd_nm : undefined,
      b?.geometry === "rectangle_1d" ? b.cd_nm : undefined,
      (value) => valueText(value, " nm"),
    );
    material(`${key}.material`, label, a?.material, b?.material);
    material(
      `${key}.background`,
      `${label} · Groove`,
      a?.geometry === "rectangle_1d" ? a.background : undefined,
      b?.geometry === "rectangle_1d" ? b.background : undefined,
    );
  }
  field(
    "schema_version",
    "Project format",
    before.schema_version,
    after.schema_version,
  );
  field("period_nm", "Pitch", before.period_nm, after.period_nm, (value) =>
    valueText(value, " nm"),
  );

  // Exact matching handles additions/removals and pure reorders without
  // inventing stable layer identities from editable or duplicate names.
  const used = new Set<number>();
  const matches = after.layers.map((next) => {
    const index = before.layers.findIndex(
      (current, index) => !used.has(index) && semanticEqual(current, next),
    );
    if (index >= 0) used.add(index);
    return index;
  });
  const onlyAdded = used.size === before.layers.length;
  const onlyRemoved = matches.every((index) => index >= 0);
  if (
    !semanticEqual(before.layers, after.layers) &&
    (onlyAdded || onlyRemoved)
  ) {
    changes.push({
      key: "layers.order",
      label: "Layer order (top to bottom)",
      before: orderText(before.layers),
      after: orderText(after.layers),
      detail: `Current positions in proposed order: ${matches.map((index) => (index < 0 ? "new" : index + 1)).join(" → ")}.`,
    });
    after.layers.forEach((next, index) => {
      if (matches[index] < 0) layer(undefined, next, index);
    });
    before.layers.forEach((current, index) => {
      if (!used.has(index)) layer(current, undefined, index);
    });
  } else {
    for (
      let index = 0;
      index < Math.max(before.layers.length, after.layers.length);
      index++
    )
      layer(before.layers[index], after.layers[index], index);
  }
  field("name", "Project name", before.name, after.name);
  material("ambient", "Ambient", before.ambient, after.ambient);
  material("substrate", "Substrate", before.substrate, after.substrate);
  field(
    "illumination.angle_deg",
    "Incidence angle",
    before.illumination.angle_deg,
    after.illumination.angle_deg,
    (value) => valueText(value, "°"),
  );
  field(
    "illumination.polarization",
    "Polarization",
    before.illumination.polarization,
    after.illumination.polarization,
    (value) => (value === "both" ? "s & p" : String(value)),
  );
  field(
    "solver.harmonics",
    "Fourier order N",
    before.solver.harmonics,
    after.solver.harmonics,
  );
  if (
    !semanticEqual(
      before.illumination.wavelengths_nm,
      after.illumination.wavelengths_nm,
    )
  ) {
    const summarize = (values: number[]) =>
      `${values.length} ${values.length === 1 ? "wavelength" : "wavelengths"} · ${values[0]}–${values.at(-1)} nm`;
    const a = before.illumination.wavelengths_nm,
      b = after.illumination.wavelengths_nm;
    const changed = Array.from(
      { length: Math.max(a.length, b.length) },
      (_, i) => i,
    ).filter((i) => a[i] !== b[i]).length;
    changes.push({
      key: "illumination.wavelengths_nm",
      label: "Wavelength sampling",
      before: summarize(a),
      after: summarize(b),
      detail: `${changed} ${changed === 1 ? "sample" : "samples"} changed. Exact wavelengths are in Full inputs.`,
    });
  }
  return changes;
}
