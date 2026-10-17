import { spectrumColor } from "./color";
import { describeRange } from "./design";
import { series } from "./spectrum";
import type { Design, SpectrumResult } from "../engine/types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function chart(ws: number[], curves: [string, number[], string][]) {
  const W = 640;
  const H = 260;
  const x = (w: number) => 40 + ((w - ws[0]) / (ws[ws.length - 1] - ws[0] || 1)) * (W - 56);
  const y = (v: number) => H - 30 - v * (H - 50);
  const lines = curves
    .map(([, values, color]) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${values.map((v, i) => `${x(ws[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`)
    .join("");
  const grid = [0, 0.5, 1]
    .map((v) => `<line x1="40" x2="${W - 16}" y1="${y(v)}" y2="${y(v)}" stroke="#d2d8df"/><text x="34" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
    .join("");
  const legend = curves.map(([label, , color], i) => `<text x="${60 + i * 110}" y="16" fill="${color}">${label}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">${grid}${lines}${legend}<text x="${W / 2}" y="${H - 6}" text-anchor="middle">Wavelength (nm): ${ws[0]}–${ws[ws.length - 1]}</text></svg>`;
}

function material(m: Design["ambient"]) {
  return m.kind === "constant" ? `${esc(m.name)} (n ${m.n}${m.k ? `, k ${m.k}` : ""})` : `${esc(m.name)} (table, ${esc(m.source ?? "")})`;
}

/** A standalone page with inputs, the spectrum and run details. */
export function reportHtml(design: Design, result: SpectrumResult): string {
  const s = series(result, "avg");
  const range = describeRange(design.illumination.wavelengths_nm);
  const color = spectrumColor(s.wavelengths, s.R);
  const layers = design.layers
    .map((l, i) => {
      const shape =
        l.geometry === "circular_hole_2d"
          ? `holes ⌀ ${l.diameter_nm} nm; host ${material(l.background)}; fill ${material(l.material)}`
          : l.geometry === "rectangle_2d"
            ? `blocks ${l.cd_x_nm} × ${l.cd_y_nm} nm of ${material(l.material)} in ${material(l.background)}`
            : l.geometry === "rectangle_1d"
              ? `lines ${l.cd_nm} nm of ${material(l.material)} in ${material(l.background)}`
              : `film of ${material(l.material)}`;
      return `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${l.thickness_nm} nm</td><td>${shape}</td></tr>`;
    })
    .join("");
  const rows = s.wavelengths.map((w, i) => `<tr><td>${w}</td><td>${s.R[i].toFixed(5)}</td><td>${s.T[i].toFixed(5)}</td><td>${s.A[i].toFixed(5)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(design.name)} · RCWA report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#18212c;background:#fff;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e9ee;padding:4px 6px;text-align:left;font-variant-numeric:tabular-nums}.note{color:#4c5968}.chip{display:inline-block;width:18px;height:18px;border-radius:4px;vertical-align:middle;border:1px solid #d2d8df}</style></head><body>
<h1>${esc(design.name)}</h1>
<p class="note">Generated ${new Date().toISOString()} by RCWA Workbench · engine meent 0.13.2 (${result.engine === "server" ? "local server" : "browser"}) · ${result.harmonics.join(" × ")} Fourier orders</p>
<h2>Structure</h2>
<p>Pitch ${design.period_nm} × ${design.period_y_nm} nm. Incident medium ${material(design.ambient)}; substrate ${material(design.substrate)}.</p>
<table><thead><tr><th>#</th><th>Layer</th><th>Thickness</th><th>Pattern</th></tr></thead><tbody>${layers}</tbody></table>
<h2>Illumination</h2>
<p>${range.start}–${range.end} nm, ${range.points} samples; θ ${design.illumination.angle_deg}°, φ ${design.illumination.azimuth_deg}°, polarization ${design.illumination.polarization}. Values below are for unpolarized light when both polarizations were calculated.</p>
<h2>Spectrum</h2>
${chart(s.wavelengths, [["R", s.R, "#2d4fd6"], ["T", s.T, "#0b8574"], ["A", s.A, "#b7791f"]])}
${color ? `<p>Approximate reflected color <span class="chip" style="background:${color.css}"></span> ${color.hex} (CIE 1931, 6500 K daylight).</p>` : ""}
<h2>Notes</h2><ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
<h2>Data</h2><table><thead><tr><th>λ (nm)</th><th>R</th><th>T</th><th>A</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Design file</h2><pre style="white-space:pre-wrap;font-size:11px">${esc(JSON.stringify(design))}</pre>
</body></html>`;
}
