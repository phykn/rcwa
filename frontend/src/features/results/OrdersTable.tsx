import { useState } from "react";
import type { SpectrumResult } from "../../engine/types";
import type { PolView } from "../../core/spectrum";
import { nearestIndex } from "../../core/spectrum";

const pct = (v: number) => (Math.abs(v) < 5e-5 ? "0" : (v * 100).toFixed(v < 0.01 ? 3 : 2));

/** Diffraction orders at the inspected wavelength, strongest first. */
export function OrdersTable({ result, pol, cursor }: { result: SpectrumResult; pol: PolView; cursor: number }) {
  const [all, setAll] = useState(false);
  const wi = nearestIndex(result.wavelengths_nm, cursor);
  const s = result.spectra.s?.orders[wi];
  const p = result.spectra.p?.orders[wi];
  const base = (pol === "p" ? p : s) ?? p!;
  const rows = base.map((row, i) => {
    const avg = pol === "avg" && s && p;
    return {
      ...row,
      R: avg ? (s[i].R + p[i].R) / 2 : row.R,
      T: avg ? (s[i].T + p[i].T) / 2 : row.T,
    };
  });
  const shown = rows
    .filter((r) => all || r.R + r.T > 1e-6 || (r.m === 0 && r.n === 0))
    .sort((a, b) => b.R + b.T - (a.R + a.T));
  const open = rows.filter((r) => r.reflection_propagating || r.transmission_propagating).length;
  return (
    <div className="orders">
      <div className="orders-head">
        <p>
          {result.wavelengths_nm[wi]} nm · {open} open {open === 1 ? "channel" : "channels"} of {rows.length} kept orders
        </p>
        <label className="toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Show orders without power
        </label>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Diffraction orders">
        <table>
          <thead>
            <tr>
              <th scope="col">Order (m, n)</th>
              <th scope="col">R %</th>
              <th scope="col">T %</th>
              <th scope="col">Direction kx/k₀, ky/k₀</th>
              <th scope="col">Above</th>
              <th scope="col">Below</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.m},${r.n}`} className={r.m === 0 && r.n === 0 ? "specular" : undefined}>
                <th scope="row">
                  ({r.m}, {r.n}){r.m === 0 && r.n === 0 ? " specular" : ""}
                </th>
                <td>{pct(r.R)}</td>
                <td>{pct(r.T)}</td>
                <td>
                  {r.kx_over_k0.toFixed(3)}, {r.ky_over_k0.toFixed(3)}
                </td>
                <td>{r.reflection_propagating ? "propagates" : "evanescent"}</td>
                <td>
                  {r.transmission_class === "absorbing_half_space"
                    ? "absorbed"
                    : r.transmission_propagating
                      ? "propagates"
                      : "evanescent"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
