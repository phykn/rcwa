"""Request-only hints; no persistent flag or change to normalized input identity."""

from rcwa_core.preflight import Diagnostic, declared_materials


def material_default_diagnostics(project):
    return [
        Diagnostic(
            code="material_name_only", severity="warning", location=path,
            message="Material name is only a label, not a database lookup. This request omitted both n and k, "
                    "so it uses the defaults n=1 and k=0. Supply explicit optical constants or a tabulated material.",
        )
        for material, path in declared_materials(project)
        if material.kind == "constant" and "name" in material.model_fields_set
        and not {"n", "k"}.intersection(material.model_fields_set)
    ]
