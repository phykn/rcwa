import { series, polLabel, type PolView } from "./spectrum";
import type { Design, SpectrumResult } from "../engine/types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function spectrumSvg(ws: number[], curves: [string, number[], string][], title = "") {
  const W = 640;
  const H = 300;
  const left = 48;
  const top = title ? 34 : 24;
  const x = (w: number) => left + ((w - ws[0]) / (ws[ws.length - 1] - ws[0] || 1)) * (W - left - 16);
  const y = (v: number) => H - 40 - v * (H - 40 - top);
  const lines = curves
    .map(([, values, color]) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${values.map((v, i) => `${x(ws[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`)
    .join("");
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line x1="${left}" x2="${W - 16}" y1="${y(v)}" y2="${y(v)}" stroke="#d2d8df"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
    .join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const w = ws[0] + f * (ws[ws.length - 1] - ws[0]);
      return `<text x="${x(w)}" y="${H - 22}" text-anchor="middle">${Math.round(w)}</text>`;
    })
    .join("");
  const legend = curves.map(([label, , color], i) => `<text x="${left + 10 + i * 110}" y="${top - 8}" fill="${color}">${esc(label)}</text>`).join("");
  const heading = title ? `<text x="${left}" y="16" font-weight="600" fill="#18212c">${esc(title)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="IBM Plex Sans, sans-serif" font-size="11" fill="#4c5968"><rect width="${W}" height="${H}" fill="#ffffff"/>${heading}${grid}${ticks}${lines}${legend}<text x="${(W + left) / 2}" y="${H - 6}" text-anchor="middle">Wavelength (nm)</text></svg>`;
}

const COLORS = { R: "#2d4fd6", T: "#0b8574", A: "#b7791f" };

export function spectrumChartSvg(design: Design, result: SpectrumResult, pol: PolView) {
  const s = series(result, pol);
  return spectrumSvg(
    s.wavelengths,
    [
      ["R reflected", s.R, COLORS.R],
      ["T transmitted", s.T, COLORS.T],
      ["A absorbed", s.A, COLORS.A],
    ],
    `${design.name}, ${polLabel(result, pol)} light`,
  );
}

export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw images.");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
