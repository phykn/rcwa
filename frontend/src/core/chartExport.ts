import { spectrumSvg } from "./report";
import { series, polLabel, type PolView } from "./spectrum";
import type { Design, SpectrumResult } from "../engine/types";

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
    `${design.name} · ${polLabel(result, pol)} light`,
  );
}

/** Rasterize an SVG string at 2× for crisp slides and papers. */
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
