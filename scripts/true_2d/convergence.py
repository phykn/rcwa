"""Offline reference comparison: common channels, totals, and summed new tails.

No production run uses this to claim automatic convergence. Callers must bind
all samples to complete inputs, solver formulations and exact source provenance.
"""

from __future__ import annotations

import math

FIELDS = ("R", "T", "R_s", "R_p", "T_s", "T_p")
REFINEMENT_TOLERANCE = 5e-4
INDEPENDENT_TOLERANCE = 2e-3


def sample_from_result(result, wavelength_index):
    polarizations = {}
    for pol, series in result["spectra"].items():
        orders = series["orders"][wavelength_index]
        polarizations[pol] = {
            "orders": orders,
            "totals": {field: sum(order[field] for order in orders) for field in FIELDS},
        }
        polarizations[pol]["totals"].update(R=series["R"][wavelength_index], T=series["T"][wavelength_index])
    return {"polarizations": polarizations}


def compare_samples(coarse, refined):
    """Signed refined-minus-coarse residuals; all coarse integer orders retained."""
    maximum = {"absolute": 0.0}
    tail_maximum = {"absolute": 0.0}
    residuals, tails = [], []
    if set(coarse["polarizations"]) != set(refined["polarizations"]):
        raise ValueError("Incident polarization sets differ")
    for pol in coarse["polarizations"]:
        a, b = coarse["polarizations"][pol], refined["polarizations"][pol]
        am = {(o["m"], o["n"]): o for o in a["orders"]}
        bm = {(o["m"], o["n"]): o for o in b["orders"]}
        if len(am) != len(a["orders"]) or len(bm) != len(b["orders"]) or not am.keys() <= bm.keys():
            raise ValueError("Duplicate labels or missing coarse orders in refined basis")
        for field in FIELDS:
            delta = b["totals"][field] - a["totals"][field]
            residuals.append({"polarization": pol, "kind": "total", "field": field, "signed_delta": delta})
        for m, n in sorted(am, key=lambda label: (label[1], label[0])):
            for field in FIELDS:
                residuals.append(
                    {
                        "polarization": pol,
                        "kind": "order",
                        "m": m,
                        "n": n,
                        "field": field,
                        "signed_delta": bm[(m, n)][field] - am[(m, n)][field],
                    }
                )
        added = sorted(bm.keys() - am.keys(), key=lambda label: (label[1], label[0]))
        for field in FIELDS:
            tail = sum(bm[label][field] for label in added)
            tails.append({"polarization": pol, "field": field, "sum": tail, "orders": [list(label) for label in added]})
    for row in residuals:
        if not math.isfinite(row["signed_delta"]):
            raise ValueError("Nonfinite comparison residual")
        if abs(row["signed_delta"]) > maximum["absolute"]:
            maximum = {**row, "absolute": abs(row["signed_delta"])}
    for row in tails:
        if not math.isfinite(row["sum"]):
            raise ValueError("Nonfinite added-order tail")
        if abs(row["sum"]) > tail_maximum["absolute"]:
            tail_maximum = {**row, "absolute": abs(row["sum"])}
    return {
        "maximum": maximum,
        "added_order_tail_maximum": tail_maximum,
        "signed_residuals": residuals,
        "added_order_tails": tails,
    }


def passes(comparison, tolerance):
    return max(comparison["maximum"]["absolute"], comparison["added_order_tail_maximum"]["absolute"]) <= tolerance
