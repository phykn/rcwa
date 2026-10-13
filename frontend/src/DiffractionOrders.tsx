import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PublicForwardResult2D, PublicOrderPower2D } from "./result2d";
import "./diffractionOrders.css";

/** Display only: never clamp, take absolute values, or round a nonzero to zero. */
export function exactOrderPower(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}
export function compactOrderPower(value: number): string {
  if (value === 0) return exactOrderPower(value);
  return Math.abs(value) < 0.001
    ? value.toExponential(3)
    : String(Number(value.toPrecision(5)));
}
/** Order only a copy for inspection; keep signed powers and retained data intact. */
export function rankedDiffractionOrders(orders: readonly PublicOrderPower2D[]) {
  return orders
    .map((order, index) => ({
      order,
      index,
      magnitude: Math.max(Math.abs(order.R), Math.abs(order.T)),
    }))
    .sort((a, b) => b.magnitude - a.magnitude || a.index - b.index)
    .map(({ order }) => order);
}
/** Deliberate sample reset, independent of CSS/native smooth-scroll behavior. */
export function resetOrderTableScroll(
  table: Pick<HTMLDivElement, "scrollTo"> | null,
) {
  table?.scrollTo({ top: 0, behavior: "instant" });
}
/** Own boundary navigation only while the table region itself has focus. */
export function handleOrderTableKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (
    event.target !== event.currentTarget ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    (event.key !== "Home" && event.key !== "End")
  )
    return;
  event.preventDefault();
  event.currentTarget.scrollTo({
    top: event.key === "Home" ? 0 : event.currentTarget.scrollHeight,
    behavior: "instant",
  });
}
function Power({
  value,
  exact,
  field,
}: {
  value: number;
  exact: boolean;
  field: string;
}) {
  const text = exactOrderPower(value);
  return (
    <span className="order-power" data-field={field} data-value={text}>
      {exact ? (
        text
      ) : (
        <>
          <span aria-hidden="true">{compactOrderPower(value)}</span>
          <span className="sr-only">{text}</span>
        </>
      )}
    </span>
  );
}
const transmissionLabels = {
  propagating: "Propagating",
  evanescent: "Evanescent",
  absorbing_half_space: "Absorbing half-space",
} as const;
function Port({
  order,
  port,
  exact,
  channels,
}: {
  order: PublicOrderPower2D;
  port: "R" | "T";
  exact: boolean;
  channels: boolean;
}) {
  return (
    <td>
      <Power value={order[port]} exact={exact} field={port} />
      <span className="order-class">
        {port === "R"
          ? order.reflection_propagating
            ? "Propagating"
            : "Evanescent"
          : transmissionLabels[order.transmission_class]}
      </span>
      {channels && (
        <div className="order-channels">
          {(["s", "p"] as const).map((channel) => {
            const field = `${port}_${channel}` as const;
            return (
              <div key={channel}>
                <span>{channel}: </span>
                <Power value={order[field]} exact={exact} field={field} />
              </div>
            );
          })}
        </div>
      )}
    </td>
  );
}

// Only the already validated, displayed result enters this view. There is no
// project prop: edited geometry must never reclassify a retained result's ports.
export function DiffractionOrders({
  result,
  polarization,
  sampleIndex,
  onUnavailableFocus,
}: {
  result: PublicForwardResult2D;
  polarization: "s" | "p";
  sampleIndex: number;
  onUnavailableFocus: () => void;
}) {
  const [exact, setExact] = useState(false);
  const [channels, setChannels] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Reset after row reordering and before paint, including during an active
    // native scroll. A new sample starts at its strongest orders. Do not move focus,
    // the page, or the scroll position for exact/component display toggles.
    resetOrderTableScroll(tableRef.current);
  }, [result, polarization, sampleIndex]);
  const rootRef = useCallback(
    (node: HTMLDetailsElement | null) => {
      if (!node) return;
      return () => {
        if (node.contains(node.ownerDocument.activeElement))
          onUnavailableFocus();
      };
    },
    [onUnavailableFocus],
  );
  const orders = result.spectra[polarization]?.orders[sampleIndex];
  if (!orders) return null;
  const absorbing = orders.some(
    (order) => order.transmission_class === "absorbing_half_space",
  );
  return (
    <details ref={rootRef} className="diffraction-orders">
      <summary>Diffraction orders</summary>
      <p className="order-sample" aria-live="polite" aria-atomic="true">
        {result.wavelengths_nm[sampleIndex]} nm · Incident {polarization} · All{" "}
        {orders.length} retained orders
      </p>
      <p className="order-help">
        R and T are fractions of incident power from the displayed spectrum.
        Small signed values are retained. Largest power magnitudes first; all
        orders shown.
        {absorbing &&
          " T is interface flux into the absorbing substrate, not backside transmission. Ordinary propagating/evanescent classification does not apply there."}
      </p>
      <div className="order-options">
        <label>
          <input
            type="checkbox"
            checked={exact}
            onChange={(event) => setExact(event.target.checked)}
          />
          Exact values
        </label>
        <label>
          <input
            type="checkbox"
            checked={channels}
            onChange={(event) => setChannels(event.target.checked)}
          />
          Outgoing local s/p
        </label>
      </div>
      {channels && (
        <p className="order-help">
          s/p below are outgoing local port components, distinct from the
          selected incident polarization.
        </p>
      )}
      <div
        ref={tableRef}
        className="order-table-scroll"
        role="region"
        aria-label="All retained diffraction orders"
        tabIndex={0}
        onKeyDown={handleOrderTableKeyDown}
      >
        <table className="order-table">
          <caption className="sr-only">
            Diffraction orders at {result.wavelengths_nm[sampleIndex]} nm,
            incident {polarization} polarization. R and T power fractions.
          </caption>
          <thead>
            <tr>
              <th scope="col">(m, n)</th>
              <th scope="col">Reflected R</th>
              <th scope="col">Transmitted T</th>
            </tr>
          </thead>
          <tbody>
            {rankedDiffractionOrders(orders).map((order) => (
              <tr
                key={`${order.m},${order.n}`}
                data-order={`${order.m},${order.n}`}
              >
                <th scope="row">
                  ({order.m}, {order.n})
                </th>
                <Port
                  order={order}
                  port="R"
                  exact={exact}
                  channels={channels}
                />
                <Port
                  order={order}
                  port="T"
                  exact={exact}
                  channels={channels}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
