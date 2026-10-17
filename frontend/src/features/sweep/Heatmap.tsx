import { useEffect, useRef, useState } from "react";
import { colorAt, rampCss, type Ramp } from "../../core/colormap";

export interface HeatmapProps {
  /** File name for the "Save image" button; omit to hide it. */
  fileName?: string;
  /** rows[y][x]; null rows are not computed yet and borrow the nearest computed row. */
  rows: (number[] | null)[];
  xs: number[];
  ys: number[];
  xLabel: string;
  yLabel: string;
  valueLabel: string;
  range?: [number, number];
  ramp?: Ramp;
  /** Curves drawn on top, in data coordinates. */
  overlays?: { x: number; y: number }[][];
  marker?: { x: number; y: number } | null;
  onPick?: (xi: number, yi: number) => void;
  describe?: (x: number, y: number, value: number) => string;
}

const PAD = { left: 64, right: 12, top: 10, bottom: 40 };

function nearestFilled(rows: (number[] | null)[], i: number) {
  for (let d = 0; d < rows.length; d++) {
    if (rows[i - d]) return rows[i - d];
    if (rows[i + d]) return rows[i + d];
  }
  return null;
}

/** Canvas heat map with axes, hover readout and click-to-pick. */
export function Heatmap({ fileName, rows, xs, ys, xLabel, yLabel, valueLabel, range = [0, 1], ramp = "viridis", overlays = [], marker, onPick, describe }: HeatmapProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ xi: number; yi: number } | null>(null);
  const width = 760;
  const height = 380;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = width * dpr;
    el.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(el);
    const ink = style.getPropertyValue("--ink-2") || "#555";
    ctx.clearRect(0, 0, width, height);
    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const image = ctx.createImageData(xs.length, ys.length);
    for (let yi = 0; yi < ys.length; yi++) {
      const row = rows[yi] ?? nearestFilled(rows, yi);
      for (let xi = 0; xi < xs.length; xi++) {
        const v = row ? row[xi] : NaN;
        const [r, g, b] = colorAt((v - range[0]) / (range[1] - range[0] || 1), ramp);
        const k = ((ys.length - 1 - yi) * xs.length + xi) * 4;
        image.data.set([r, g, b, row ? (rows[yi] ? 255 : 150) : 30], k);
      }
    }
    const off = document.createElement("canvas");
    off.width = xs.length;
    off.height = ys.length;
    off.getContext("2d")!.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = xs.length > 1 && ys.length > 1;
    ctx.drawImage(off, PAD.left, PAD.top, w, h);
    const px = (x: number) => PAD.left + ((x - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * w;
    const py = (y: number) => PAD.top + h - ((y - ys[0]) / (ys[ys.length - 1] - ys[0] || 1)) * h;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.setLineDash([4, 3]);
    for (const line of overlays) {
      ctx.beginPath();
      line.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (marker) {
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(px(marker.x) - 4, py(marker.y) - 4, 8, 8);
    }
    ctx.fillStyle = ink;
    ctx.font = "11px 'IBM Plex Sans', sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const x = xs[0] + ((xs[xs.length - 1] - xs[0]) * i) / 4;
      ctx.fillText(x.toFixed(0), px(x), height - PAD.bottom + 16);
    }
    ctx.fillText(xLabel, PAD.left + w / 2, height - 6);
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = ys[0] + ((ys[ys.length - 1] - ys[0]) * i) / 4;
      ctx.fillText(y.toFixed(y < 10 ? 1 : 0), PAD.left - 6, py(y) + 4);
    }
    ctx.save();
    ctx.translate(14, PAD.top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }, [rows, xs, ys, xLabel, yLabel, range, ramp, overlays, marker]);

  function locate(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * width;
    const fy = ((e.clientY - rect.top) / rect.height) * height;
    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    if (fx < PAD.left || fx > PAD.left + w || fy < PAD.top || fy > PAD.top + h) return null;
    const xi = Math.round(((fx - PAD.left) / w) * (xs.length - 1));
    const yi = Math.round(((PAD.top + h - fy) / h) * (ys.length - 1));
    return { xi, yi };
  }

  const hovered = hover && (rows[hover.yi] ?? null);
  return (
    <div className="heatmap-wrap">
      <canvas
        ref={canvas}
        style={{ aspectRatio: `${width} / ${height}` }}
        role="img"
        aria-label={`${valueLabel} map against ${xLabel} and ${yLabel}`}
        onPointerMove={(e) => setHover(locate(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const at = locate(e);
          if (at && onPick) onPick(at.xi, at.yi);
        }}
      />
      <div className="heatmap-legend">
        <span>{range[0]}</span>
        <span className="heatmap-scale" style={{ background: rampCss(ramp) }} aria-hidden />
        <span>{range[1]}</span>
        <span>{valueLabel}</span>
        {fileName && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() =>
              canvas.current?.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }, "image/png")
            }
          >
            Save image (.png)
          </button>
        )}
        <span className="heatmap-hover" aria-live="polite">
          {hover && hovered && describe ? describe(xs[hover.xi], ys[hover.yi], hovered[hover.xi]) : onPick ? "Click a point to apply it to the design." : ""}
        </span>
      </div>
    </div>
  );
}
