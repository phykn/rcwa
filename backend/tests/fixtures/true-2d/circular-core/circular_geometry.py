"""Deterministic midpoint-strip disk approximation for directional Fourier rules.

This is a real two-dimensional disk geometry, approximated by centered horizontal
rectangles. Fourier integrals over each step are continuous/exact, not a sampled
FFT. The independent reference uses S4's analytical circular regions instead.
"""
from __future__ import annotations

import math

import numpy as np

CIRCLE_STRIPS = 64


def validate_circle_strips(strips):
    if type(strips) is not int or strips < 8 or strips > 512 or strips % 2:
        raise ValueError("Circle strips must be an even integer from 8 through 512")
    return strips


def circle_widths(diameter, strips):
    """Mirror the first half exactly to preserve y symmetry at floating precision."""
    validate_circle_strips(strips)
    y = (np.arange(strips // 2, dtype=float) + 0.5) / strips - 0.5
    widths = diameter * np.sqrt(1 - (2 * y)**2)
    return np.r_[widths, widths[::-1]]


def circular_cell_2d(px, py, diameter, inclusion, background, *, strips=CIRCLE_STRIPS):
    widths = circle_widths(diameter, strips)
    # Sorted unique boundaries exclude zero-length cells, including limiting d=0.
    xs = np.unique(np.r_[0, (px - widths) / 2, (px + widths) / 2, px])
    ys = np.unique(np.r_[0, (py - diameter) / 2 + diameter * np.arange(strips + 1) / strips, py])
    xm, ym = (xs[:-1] + xs[1:]) / 2, (ys[:-1] + ys[1:]) / 2
    values = np.full((len(ym), len(xm)), background, dtype=np.complex128)
    if diameter > 0:
        offset = (py - diameter) / 2
        active = (ym >= offset) & (ym < offset + diameter)
        band = np.clip(((ym[active] - offset) / diameter * strips).astype(int), 0, strips - 1)
        values[active] = np.where(
            np.abs(xm[None, :] - px / 2) < widths[band, None] / 2,
            inclusion,
            background,
        )
    return [values, xs[1:, None].astype(np.complex128), ys[1:, None].astype(np.complex128)]


def circle_approximation_metadata(project, strips, offline_override):
    rows = []
    for index, layer in enumerate(project.layers):
        if layer.geometry != "circular_hole_2d":
            continue
        diameter = layer.diameter_nm
        exact_area = math.pi * (diameter / 2)**2
        approximate_area = float(sum(circle_widths(diameter, strips)) * diameter / strips)
        # For even N, width is monotone on each half. The midpoint-rule absolute
        # area difference <= (h/2)*total_variation(width) = d^2/N. The roundoff
        # allowance also covers circles below representable cell-coordinate size.
        bound = diameter**2 / strips + 64 * np.finfo(float).eps * project.period_nm * project.period_y_nm
        rows.append({
            "layer_index": index,
            "exact_area_nm2": exact_area,
            "approximate_area_nm2": approximate_area,
            "symmetric_difference_area_bound_nm2": bound,
        })
    return {
        "method": "centered_midpoint_strips",
        "strips": strips,
        "offline_spatial_override": offline_override,
        "area_bound_is_optical_error_bound": False,
        "layers": rows,
    }
