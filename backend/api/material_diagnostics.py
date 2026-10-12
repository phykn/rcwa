"""Request-only hints; no persistent flag or change to normalized input identity."""

from rcwa_core.preflight import Diagnostic


def material_default_diagnostics(project):
    materials = [(project.ambient, ["ambient"]), (project.substrate, ["substrate"])]
    for index, layer in enumerate(project.layers):
        materials.append((layer.material, ["layers", index, "material"]))
        if hasattr(layer, "background"):
            materials.append((layer.background, ["layers", index, "background"]))
    return [
        Diagnostic(
            code="material_name_only", severity="warning", location=path,
            message="Material name is only a label, not a database lookup. This request omitted both n and k, "
                    "so it uses the defaults n=1 and k=0. Supply explicit optical constants or a tabulated material.",
        )
        for material, path in materials
        if material.kind == "constant" and "name" in material.model_fields_set
        and not {"n", "k"}.intersection(material.model_fields_set)
    ]
