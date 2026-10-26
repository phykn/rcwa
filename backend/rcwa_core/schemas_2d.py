"""Explicit 1.2 bounded 2D contract; legacy defaults remain unchanged.

Public requests opt in through shared version dispatch. Lengths are vacuum nm.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import ConfigDict, Field, model_validator

from .schemas import HomogeneousLayer, Illumination, Layer, Material, StrictModel


class Rectangle2D(StrictModel):
    name: str = Field(default="Synthetic rectangular pattern", min_length=1, max_length=100)
    geometry: Literal["rectangle_2d"] = "rectangle_2d"
    thickness_nm: float = Field(default=90, ge=0, le=2000)
    cd_x_nm: float = Field(ge=0, le=5000)
    cd_y_nm: float = Field(ge=0, le=5000)
    material: Material
    background: Material


class CircularHole2D(StrictModel):
    """Centered circular cylinder: material fills the hole, background is its host."""

    name: str = Field(default="Synthetic circular hole", min_length=1, max_length=100)
    geometry: Literal["circular_hole_2d"] = "circular_hole_2d"
    thickness_nm: float = Field(default=90, ge=0, le=2000)
    diameter_nm: float = Field(ge=0, le=5000)
    material: Material
    background: Material


Layer2D = Annotated[Rectangle2D | CircularHole2D | Layer | HomogeneousLayer, Field(discriminator="geometry")]


class Illumination2D(Illumination):
    wavelengths_nm: list[float] = Field(min_length=1, max_length=31)
    azimuth_deg: float = Field(default=0, ge=0, lt=360)


class SolverSettings2D(StrictModel):
    harmonics_x: int = Field(default=3, ge=1, le=5, strict=True)
    harmonics_y: int = Field(default=3, ge=1, le=5, strict=True)


def require_layer_geometry(schema):
    # A runtime discriminator requires its tag even when the underlying legacy
    # model has a constructor default. Constrain only this 1.2 union, not legacy.
    for branch in schema["properties"]["layers"]["items"]["oneOf"]:
        branch["required"] = ["geometry"]


class Project2D(StrictModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, json_schema_extra=require_layer_geometry)

    schema_version: Literal["1.2"]  # Explicit opt-in; no implicit version migration.
    name: str = Field(default="Synthetic 2D stack", min_length=1, max_length=100)
    period_nm: float = Field(ge=20, le=5000)
    period_y_nm: float = Field(ge=20, le=5000)
    ambient: Material = Field(default_factory=lambda: Material(name="Air", n=1))
    substrate: Material = Field(default_factory=lambda: Material(name="Synthetic substrate", n=1.5))
    layers: list[Layer2D] = Field(min_length=1, max_length=8)
    illumination: Illumination2D
    solver: SolverSettings2D = Field(default_factory=SolverSettings2D)

    @model_validator(mode="after")
    def validate_supported_scope(self):
        for i, layer in enumerate(self.layers):
            if isinstance(layer, Rectangle2D):
                if layer.cd_x_nm > self.period_nm or layer.cd_y_nm > self.period_y_nm:
                    raise ValueError(f"Layer {i + 1}: rectangle widths must not exceed their periods")
            elif isinstance(layer, CircularHole2D):
                if layer.diameter_nm > min(self.period_nm, self.period_y_nm):
                    raise ValueError(f"Layer {i + 1}: hole diameter must not exceed either period")
            elif isinstance(layer, Layer) and layer.cd_nm > self.period_nm:
                raise ValueError(f"Layer {i + 1}: CD must not exceed the x period")
        if (self.ambient.kind == "constant" and self.ambient.k != 0) or (
            self.ambient.kind == "tabulated" and any(self.ambient.k_values)
        ):
            raise ValueError("The incident ambient must be lossless")
        from .preflight import PreflightError, material_coverage_diagnostics

        errors = material_coverage_diagnostics(self)
        if errors:
            raise PreflightError(errors)
        return self
