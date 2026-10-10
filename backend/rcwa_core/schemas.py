"""Engine-independent, versioned prototype input contract. All lengths are nm."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Material(StrictModel):
    name: str = Field(default="Synthetic material", min_length=1, max_length=100)
    kind: Literal["constant", "tabulated"] = "constant"
    n: float = Field(default=1.0, gt=0, le=10)
    k: float = Field(default=0.0, ge=0, le=10)
    wavelengths_nm: list[float] | None = Field(default=None, min_length=2, max_length=2000)
    n_values: list[float] | None = None
    k_values: list[float] | None = None
    source: str = Field(default="User-defined synthetic optical constants", max_length=500)

    @model_validator(mode="after")
    def validate_table(self):
        columns = (self.wavelengths_nm, self.n_values, self.k_values)
        if self.kind == "constant":
            if any(column is not None for column in columns):
                raise ValueError("Constant materials must not also contain a table")
        else:
            if any(column is None for column in columns):
                raise ValueError("Tabulated materials require wavelengths_nm, n_values, and k_values")
            wavelengths, ns, ks = columns
            if not (len(wavelengths) == len(ns) == len(ks)):
                raise ValueError("Material table columns must have the same length")
            if any(w <= 0 for w in wavelengths) or any(a >= b for a, b in zip(wavelengths, wavelengths[1:])):
                raise ValueError("Material wavelengths must be positive and strictly increasing")
            if any(not 0 < n <= 10 for n in ns) or any(not 0 <= k <= 10 for k in ks):
                raise ValueError("Material table requires 0 < n <= 10 and 0 <= k <= 10")
        return self


class Layer(StrictModel):
    name: str = Field(default="Patterned layer", min_length=1, max_length=100)
    geometry: Literal["rectangle_1d"] = "rectangle_1d"
    thickness_nm: float = Field(default=160.0, ge=0, le=2000)
    cd_nm: float = Field(default=180.0, ge=0, le=5000)
    material: Material = Field(default_factory=lambda: Material(name="Synthetic dielectric", n=2.1))
    background: Material = Field(default_factory=lambda: Material(name="Air", n=1.0))


class Illumination(StrictModel):
    wavelengths_nm: list[float] = Field(
        default_factory=lambda: [float(w) for w in range(450, 851, 20)], min_length=1, max_length=81
    )
    angle_deg: float = Field(default=15.0, ge=0, le=75)
    polarization: Literal["s", "p", "both"] = "both"

    @model_validator(mode="after")
    def validate_wavelengths(self):
        if any(not 200 <= w <= 2500 for w in self.wavelengths_nm):
            raise ValueError("Supported vacuum wavelengths are 200 to 2500 nm")
        if any(a >= b for a, b in zip(self.wavelengths_nm, self.wavelengths_nm[1:])):
            raise ValueError("Wavelengths must be strictly increasing")
        return self


class SolverSettings(StrictModel):
    harmonics: int = Field(default=7, ge=1, le=20, strict=True)


class Project(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    name: str = Field(default="One-layer grating", min_length=1, max_length=100)
    period_nm: float = Field(default=400.0, ge=20, le=5000)
    ambient: Material = Field(default_factory=lambda: Material(name="Air", n=1.0))
    substrate: Material = Field(default_factory=lambda: Material(name="Synthetic substrate", n=1.5))
    layers: list[Layer] = Field(default_factory=lambda: [Layer()], min_length=1, max_length=1)
    illumination: Illumination = Field(default_factory=Illumination)
    solver: SolverSettings = Field(default_factory=SolverSettings)

    @model_validator(mode="after")
    def validate_supported_scope(self):
        if len(self.layers) != 1:
            raise ValueError("Version 1 supports exactly one finite rectangular layer")
        if self.layers[0].cd_nm > self.period_nm:
            raise ValueError("CD must not exceed the period")
        if (self.ambient.kind == "constant" and self.ambient.k != 0) or (
            self.ambient.kind == "tabulated" and any(k != 0 for k in self.ambient.k_values)
        ):
            raise ValueError("The incident ambient must be lossless")
        from .preflight import PreflightError, material_coverage_diagnostics

        coverage = material_coverage_diagnostics(self)
        if coverage:
            raise PreflightError(coverage)
        return self


class FitRequest(StrictModel):
    """An intentionally synthetic, CD-only recovery experiment; not measured-data metrology."""

    project: Project
    target_cd_nm: float = Field(gt=0)
    lower_cd_nm: float = Field(default=40.0, gt=0)
    upper_cd_nm: float = Field(default=360.0, gt=0)

    @model_validator(mode="after")
    def validate_bounds(self):
        if not 0 < self.lower_cd_nm < self.upper_cd_nm < self.project.period_nm:
            raise ValueError("Fit bounds must satisfy 0 < lower < upper < period")
        if not self.lower_cd_nm < self.target_cd_nm < self.upper_cd_nm:
            raise ValueError("Synthetic target CD must be strictly inside the fit bounds")
        if len(self.project.illumination.wavelengths_nm) < 5:
            raise ValueError("Synthetic fit requires at least five wavelengths")
        if len(self.project.illumination.wavelengths_nm) > 41 or self.project.solver.harmonics > 12:
            raise ValueError("Synthetic fitting is limited to 41 wavelengths and 12 harmonics")
        if self.project.layers[0].thickness_nm == 0:
            raise ValueError("A zero-thickness layer has no CD sensitivity")
        return self
