import { useEffect, useRef, useSyncExternalStore } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { nearestIndex, sampleAt, type Series } from "../../core/spectrum";

interface Props {
  series: Series;
  cursor: number;
  onCursor: (nm: number) => void;
}

/** How long a new result takes to morph into place. */
const MORPH_MS = 240;

const css = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim() || "#888";

const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");
const subscribeScheme = (onChange: () => void) => {
  const query = darkQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};
const isDark = () => darkQuery()?.matches ?? false;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const STEPS: Record<string, (i: number, last: number) => number> = {
  ArrowLeft: (i) => i - 1,
  ArrowDown: (i) => i - 1,
  ArrowRight: (i) => i + 1,
  ArrowUp: (i) => i + 1,
  Home: () => 0,
  End: (_, last) => last,
};

/**
 * R/T/A against wavelength; the vertical rule marks the inspected sample, set
 * by a click or the arrow keys. One chart lives for the whole session: a new
 * result morphs the drawn curves into place instead of rebuilding the chart.
 * It fills its container's height (at least 220 px) and is rebuilt with the
 * theme's colors when the system switches between light and dark.
 */
export function SpectrumChart({ series, cursor, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const shown = useRef<uPlot.AlignedData | null>(null);
  const frame = useRef(0);
  const cursorRef = useRef(cursor);
  const onCursorRef = useRef(onCursor);
  const dark = useSyncExternalStore(subscribeScheme, isDark);
  useEffect(() => {
    onCursorRef.current = onCursor;
  }, [onCursor]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const color = {
      R: css(element, "--curve-r"),
      T: css(element, "--curve-t"),
      A: css(element, "--curve-a"),
      ink: css(element, "--ink-2"),
      grid: css(element, "--line"),
    };
    const font = `12px ${getComputedStyle(element).fontFamily}`;
    const axis = { stroke: color.ink, font, labelFont: font, grid: { stroke: color.grid, width: 1 }, ticks: { stroke: color.grid } };
    const fit = () => Math.max(220, element.clientHeight || 300);
    const options: uPlot.Options = {
      width: element.clientWidth || 600,
      height: fit(),
      series: [
        { label: "Wavelength (nm)" },
        { label: "R", stroke: color.R, width: 2, spanGaps: true, points: { show: false } },
        { label: "T", stroke: color.T, width: 2, spanGaps: true, points: { show: false } },
        { label: "A", stroke: color.A, width: 2, dash: [4, 3], spanGaps: true, points: { show: false } },
      ],
      legend: { show: false },
      scales: { x: { time: false }, y: { range: [0, 1] } },
      axes: [
        { ...axis, label: "Wavelength (nm)", labelSize: 22 },
        // Steps of at least 0.1 keep one-decimal tick labels distinct.
        { ...axis, label: "Fraction of incident power", labelSize: 22, incrs: [0.1, 0.2, 0.5, 1], values: (_, ticks) => ticks.map((t) => t.toFixed(1)) },
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
    const chart = new uPlot(options, shown.current ?? [[], [], [], []], element);
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
      cancelAnimationFrame(frame.current);
      observer.disconnect();
      chart.destroy();
      plot.current = null;
    };
  }, [dark]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    const xs = series.wavelengths;
    const target: uPlot.AlignedData = [xs, series.R, series.T, series.A];
    const from = shown.current;
    cancelAnimationFrame(frame.current);
    if (!from || !from[0].length || reducedMotion()) {
      chart.setData(target);
      shown.current = target;
      return;
    }
    // Start from what is drawn now, resampled onto the new wavelengths (a
    // preview has fewer samples than a full result), then ease into the target.
    const start = [1, 2, 3].map((k) => xs.map((x) => sampleAt(from[0], from[k], x)));
    const begun = performance.now();
    const step = (now: number) => {
      const f = Math.min(1, (now - begun) / MORPH_MS);
      const ease = 1 - (1 - f) ** 3;
      const data: uPlot.AlignedData =
        f < 1 ? [xs, ...start.map((a, k) => a.map((v, i) => v + ((target[k + 1][i] ?? 0) - v) * ease))] : target;
      chart.setData(data);
      shown.current = data;
      if (f < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [series]);

  useEffect(() => {
    cursorRef.current = cursor;
    plot.current?.redraw(false);
  }, [cursor]);

  const ws = series.wavelengths;
  const index = nearestIndex(ws, cursor);
  return (
    <div
      ref={host}
      className="spectrum-chart"
      role="slider"
      tabIndex={0}
      aria-label="Inspected wavelength"
      aria-valuemin={ws[0]}
      aria-valuemax={ws[ws.length - 1]}
      aria-valuenow={ws[index]}
      aria-valuetext={`${ws[index]} nm`}
      onKeyDown={(e) => {
        const step = STEPS[e.key];
        if (!step) return;
        e.preventDefault();
        onCursor(ws[Math.min(ws.length - 1, Math.max(0, step(index, ws.length - 1)))]);
      }}
    />
  );
}
