import { useMemo, useState } from "react";
import type { Material } from "../core/model";
import { coverage, describeMaterial, indexAt, LIBRARY, parseMaterialCsv } from "../core/materials";
import { constantMaterial } from "../core/design";
import { Popover } from "./Popover";

const FAMILY = { dielectric: "Dielectrics", semiconductor: "Semiconductors", metal: "Metals" } as const;

/** Optical density as a tone: low index pale, high index deep, absorbing metallic. */
export function materialColor(material: Material, wavelength: number) {
  const value = indexAt(material, wavelength) ?? { n: material.n, k: material.k };
  if (value.k > 0.5) return "var(--mat-metal)";
  const t = Math.min(1, Math.max(0, (value.n - 1) / 3));
  return `color-mix(in oklab, var(--mat-low) ${Math.round((1 - t) * 100)}%, var(--mat-high))`;
}

export function MaterialField({
  label,
  material,
  span,
  lossless,
  onChange,
}: {
  label: string;
  material: Material;
  /** Design wavelength range; tables must cover it. */
  span: [number, number];
  lossless?: boolean;
  onChange: (material: Material) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [n, setN] = useState(String(material.n));
  const [k, setK] = useState(String(material.k));
  const [error, setError] = useState("");
  const center = (span[0] + span[1]) / 2;
  const range = coverage(material);
  const uncovered = range && (span[0] < range[0] || span[1] > range[1]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LIBRARY.filter(
      (m) =>
        (!lossless || m.material.k_values?.every((v) => v === 0)) &&
        (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
    );
  }, [query, lossless]);

  function applyConstant() {
    const nv = Number(n);
    const kv = lossless ? 0 : Number(k);
    if (!(nv > 0 && nv <= 10) || !(kv >= 0 && kv <= 10)) return setError("Use 0 < n ≤ 10 and 0 ≤ k ≤ 10.");
    onChange(constantMaterial(material.kind === "constant" ? material.name : `n=${nv}`, nv, kv));
    setOpen(false);
  }

  async function importTable(file: File) {
    try {
      onChange(parseMaterialCsv(file.name.replace(/\.[^.]+$/, ""), await file.text()));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="field material-field">
      <span className="field-label">{label}</span>
      <button
        type="button"
        className={`material-chip${uncovered ? " material-chip-warn" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setN(String(material.n));
          setK(String(material.k));
          setError("");
          setOpen(true);
        }}
      >
        <span className="material-dot" style={{ background: materialColor(material, center) }} aria-hidden />
        <span className="material-name">{material.name}</span>
        <span className="material-value">{describeMaterial(material, center)}</span>
      </button>
      {uncovered && (
        <p className="field-error">
          Data covers {range![0]}–{range![1]} nm; the light spans {span[0]}–{span[1]} nm.
        </p>
      )}
      {open && (
        <Popover label={`Choose ${label.toLowerCase()}`} onClose={() => setOpen(false)} className="material-popover">
          <input
            className="popover-search"
            placeholder="Search materials"
            aria-label="Search materials"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="material-list" role="listbox" aria-label="Material library">
            {(Object.keys(FAMILY) as (keyof typeof FAMILY)[]).map((family) => {
              const items = matches.filter((m) => m.family === family);
              if (!items.length) return null;
              return (
                <div key={family} role="group" aria-label={FAMILY[family]}>
                  <div className="material-group">{FAMILY[family]}</div>
                  {items.map((item) => {
                    const fits = span[0] >= item.range_nm[0] && span[1] <= item.range_nm[1];
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={material.name === item.material.name}
                        className="material-option"
                        title={item.source}
                        onClick={() => {
                          onChange(item.material);
                          setOpen(false);
                        }}
                      >
                        <span className="material-option-id">{item.id}</span>
                        <span className="material-option-name">{item.name}</span>
                        <span className={fits ? "material-option-range" : "material-option-range warn"}>
                          {item.range_nm[0]}–{item.range_nm[1]} nm
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!matches.length && <p className="empty-note">No library material matches. Enter constants below.</p>}
          </div>
          <form
            className="material-constant"
            onSubmit={(e) => {
              e.preventDefault();
              applyConstant();
            }}
          >
            <span className="field-label">Constant index</span>
            <label>
              n <input inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} />
            </label>
            {!lossless && (
              <label>
                k <input inputMode="decimal" value={k} onChange={(e) => setK(e.target.value)} />
              </label>
            )}
            <button type="submit" className="btn">
              Use
            </button>
          </form>
          {!lossless && (
            <label className="material-import btn btn-quiet">
              Import n, k table (CSV)
              <input
                type="file"
                accept=".csv,.txt,.tsv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so the same file can be chosen again after fixing an error.
                  e.target.value = "";
                  if (file) void importTable(file);
                }}
              />
            </label>
          )}
          {error && <p className="field-error">{error}</p>}
        </Popover>
      )}
    </div>
  );
}
