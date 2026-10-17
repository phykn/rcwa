export type Polarization = "s" | "p" | "both";

export interface Material {
  name: string;
  kind: "constant" | "tabulated";
  n: number;
  k: number;
  wavelengths_nm?: number[] | null;
  n_values?: number[] | null;
  k_values?: number[] | null;
  source?: string;
}

export interface RectangleLayer {
  name: string;
  geometry: "rectangle_1d";
  thickness_nm: number;
  cd_nm: number;
  material: Material;
  background: Material;
}

export interface HomogeneousLayer {
  name: string;
  geometry: "homogeneous";
  thickness_nm: number;
  material: Material;
}
