import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Series } from "../../core/spectrum";

export interface ChartLayer {
  id: string;
  label: string;
  series: Series;
  kind: "main" | "stale" | "preview" | "ghost" | "overlay";
}

interface Props {
  layers: ChartLayer[];
  showSpecular: boolean;
  showAbsorption: boolean;
  /** Fit the vertical axis to the drawn curves instead of 0–1. */
  zoom?: boolean;
  cursor: number;
  onCursor: (nm: number) => void;
  height?: number;
}

const css = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim() || "#888";

/** R/T/A against wavelength; the vertical rule marks the inspected sample. */
/** Without `height`, the chart fills its container's height (at least 220 px). */
export function SpectrumChart({ layers, showSpecular, showAbsorption, zoom = false, cursor, onCursor, height }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const cursorRef = useRef(cursor);
  const onCursorRef = useRef(onCursor);
  useEffect(() => {
    onCursorRef.current = onCursor;
  }, [onCursor]);

  useEffect(() => {
    const element = host.current;
    if (!element || !layers.length) return;
    const color = {
      R: css(element, "--curve-r"),
      T: css(element, "--curve-t"),
      A: css(element, "--curve-a"),
      ghost: css(element, "--ghost"),
      ink: css(element, "--ink-2"),
      grid: css(element, "--line"),
    };
    const tables: uPlot.AlignedData[] = [];
    const series: uPlot.Series[] = [{ label: "Wavelength (nm)" }];
    for (const layer of layers) {
      const s = layer.series;
      const curves: [string, number[], string][] = [
        ["R", s.R, color.R],
        ["T", s.T, color.T],
      ];
      if (showAbsorption && (layer.kind === "main" || layer.kind === "stale")) curves.push(["A", s.A, color.A]);
      if (showSpecular && layer.kind === "main") curves.push(["R₀", s.Rspec, color.R], ["T₀", s.Tspec, color.T]);
      tables.push([s.wavelengths, ...curves.map((c) => c[1])] as uPlot.AlignedData);
      for (const [name, , stroke] of curves) {
        const specular = name.endsWith("₀");
        const muted = layer.kind === "ghost" || layer.kind === "overlay";
        series.push({
          label: `${name}, ${layer.label}`,
          stroke: muted ? color.ghost : stroke,
          width: layer.kind === "main" ? (specular ? 1.25 : 2) : layer.kind === "preview" ? 1.5 : 1.25,
          dash: specular || layer.kind === "preview" ? [6, 4] : layer.kind === "overlay" ? [2, 3] : name === "A" ? [4, 3] : undefined,
          alpha: layer.kind === "stale" ? 0.35 : 1,
          spanGaps: true,
          points: { show: layer.kind === "preview" },
        });
      }
    }
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables);
    const font = `12px ${getComputedStyle(element).fontFamily}`;
    const axis = { stroke: color.ink, font, labelFont: font, grid: { stroke: color.grid, width: 1 }, ticks: { stroke: color.grid } };
    const fit = () => height ?? Math.max(220, element.clientHeight || 300);
    const options: uPlot.Options = {
      width: element.clientWidth || 600,
      height: fit(),
      series,
      legend: { show: false },
      scales: {
        x: { time: false },
        y: {
          range: zoom
            ? (_u, lo, hi) => {
                const pad = Math.max(0.002, (hi - lo) * 0.08);
                return [Math.max(0, lo - pad), Math.min(1, hi + pad)];
              }
            : [0, 1],
        },
      },
      axes: [
        { ...axis, label: "Wavelength (nm)", labelSize: 22 },
        { ...axis, label: "Fraction of incident power", labelSize: 22, values: (_, ticks) => ticks.map((t) => (zoom ? t.toFixed(3) : t.toFixed(1))) },
      ],
      cursor: { y: false, points: { show: false } },
      hooks: {
        draw: [
          (u) => {
            const x = u.valToPos(cursorRef.current, "x", true);
            if (!Number.isFinite(x)) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = color.ink;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, u.bbox.top);
            ctx.lineTo(x, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };
    const chart = new uPlot(options, data, element);
    chart.over.addEventListener("click", () => {
      const idx = chart.cursor.idx;
      if (idx !== null && idx !== undefined) onCursorRef.current(chart.data[0][idx] as number);
    });
    plot.current = chart;
    // Width follows the container; the chart never feeds its own size back.
    let last = [element.clientWidth, fit()];
    const observer = new ResizeObserver(() => {
      const size = [element.clientWidth, fit()];
      if (Math.abs(size[0] - last[0]) < 1 && Math.abs(size[1] - last[1]) < 1) return;
      last = size;
      chart.setSize({ width: size[0], height: size[1] });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.destroy();
      plot.current = null;
    };
  }, [layers, showSpecular, showAbsorption, zoom, height]);

  useEffect(() => {
    cursorRef.current = cursor;
    plot.current?.redraw(false);
  }, [cursor]);

  return <div ref={host} className={height ? "spectrum-chart" : "spectrum-chart spectrum-chart-fill"} aria-hidden />;
}
