#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate a USD Performance Tuning report against optimization-report.schema.json.

Deterministic local validation with no third-party runtime dependencies. The
agent (or CI) should run this before treating a report as final, so an
out-of-enum verdict, a missing required field, or an unexpected array-item key
is caught instead of shipping a schema-invalid report.

Implements the JSON Schema draft-07 subset this schema uses: type (including
type unions like ["string", "null"]), enum, required, properties,
additionalProperties=false, items, minimum, and maximum.

Phase-4 target coverage gate
----------------------------
Schema validation alone cannot catch a Phase-4 target that was never enumerated
in the report (the failure mode where an assembly_root remainder is silently
left un-optimized). A report's ``target_coverage.complete`` flag is self-attested
by the report author, so the gate reconciles ``target_coverage`` against the
upstream apply-restructure manifest(s): the report must cover the UNION of every
iteration's ``phase4_targets[]``, every disposition must be resolved, and
``skipped_zero_meshes`` is accepted only when the manifest's authoritative
``mesh_count`` for that target is 0.

Reconciliation is fail-closed, not opt-in: when any coverage entry has a
restructure role (assembly_root | prototype | shared_layer | loadable_subasset)
a manifest is REQUIRED. Manifests are taken from ``--manifest`` and/or the
report's own ``target_coverage.source_manifests[]`` (auto-loaded relative to the
report), so a restructure report cannot pass merely because the operator forgot
the flag. Monolith/diagnosis runs (no restructure roles) stay manifest-free.

Usage:
    python3 validate_report.py <report.json> [--schema <schema.json>] \\
        [--manifest <apply-restructure-manifest.json> ...]
Exit code 0 when the report conforms and the coverage gate passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DEFAULT_SCHEMA = Path(__file__).resolve().parent / "optimization-report.schema.json"

#: A Phase-4 target is "resolved" only with one of these dispositions. ``blocked``
#: (or a target with no entry at all) keeps ``target_coverage.complete`` false and
#: the report non-final — mirroring the validation report's RESOLVED_STATUSES.
PHASE4_RESOLVED_DISPOSITIONS = frozenset(
    {"optimized", "skipped_zero_meshes", "skipped_user_declined"}
)
RESTRUCTURE_TARGET_CLASSES = frozenset(
    {"prototype", "shared_layer", "loadable_subasset", "assembly_root"}
)
#: Coverage-entry roles that mean "a restructure happened", so a manifest is
#: mandatory and reconciliation is not optional. The ``monolith`` role (an
#: optimize-as-is N=1 target) and an empty ledger stay manifest-free.
RESTRUCTURE_ROLES = frozenset(
    {"assembly_root", "prototype", "shared_layer", "loadable_subasset"}
)


def _type_ok(instance: Any, type_name: str) -> bool:
    if type_name == "object":
        return isinstance(instance, dict)
    if type_name == "array":
        return isinstance(instance, list)
    if type_name == "string":
        return isinstance(instance, str)
    if type_name == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if type_name == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if type_name == "boolean":
        return isinstance(instance, bool)
    if type_name == "null":
        return instance is None
    return True


def _validate(instance: Any, schema: dict, path: str, errors: list[str]) -> None:
    declared_type = schema.get("type")
    if declared_type is not None:
        candidates = declared_type if isinstance(declared_type, list) else [declared_type]
        if not any(_type_ok(instance, name) for name in candidates):
            got = "null" if instance is None else type(instance).__name__
            errors.append(f"{path}: expected type {candidates}, got {got}")
            return

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of {schema['enum']}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} is below minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} is above maximum {schema['maximum']}")

    if isinstance(instance, dict):
        properties = schema.get("properties", {})
        for required_key in schema.get("required", []):
            if required_key not in instance:
                errors.append(f"{path}: missing required property '{required_key}'")
        allow_additional = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in properties:
                _validate(value, properties[key], f"{path}.{key}", errors)
            elif allow_additional is False:
                errors.append(f"{path}: unexpected property '{key}'")

    if isinstance(instance, list) and "items" in schema:
        for index, item in enumerate(instance):
            _validate(item, schema["items"], f"{path}[{index}]", errors)


def validate_report(report: Any, schema: dict | None = None) -> list[str]:
    """Return a list of schema-violation messages; empty list means the report conforms."""
    if schema is None:
        schema = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))
    errors: list[str] = []
    _validate(report, schema, "$", errors)
    return errors


def validate_manifest_structure(manifest: Any) -> list[str]:
    """Enforce the load-bearing apply-restructure manifest invariants.

    Independent of the JSON-Schema walker so the rules hold without ``jsonschema``:
    a ``mode=restructure`` manifest must carry a non-empty ``phase4_targets[]``,
    and every target must declare an integer ``mesh_count >= 0`` (the authoritative
    default-predicate count the coverage gate keys on).
    """
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return [f"manifest must be an object, got {type(manifest).__name__}"]
    mode = manifest.get("mode")
    targets = manifest.get("phase4_targets")
    if mode == "restructure" and not targets:
        errors.append(
            "mode=restructure manifest must list a non-empty phase4_targets[] "
            "(do not drop the key; an assembly_root with retained meshes must appear)"
        )
    for index, target in enumerate(targets or []):
        where = f"phase4_targets[{index}]"
        path = target.get("path") if isinstance(target, dict) else None
        label = f"{where} ({path})" if path else where
        if not isinstance(target, dict):
            errors.append(f"{where}: must be an object")
            continue
        if not isinstance(path, str) or not path:
            errors.append(f"{where}: missing required 'path'")
        target_class = target.get("target_class")
        if target_class not in RESTRUCTURE_TARGET_CLASSES:
            errors.append(
                f"{label}: target_class {target_class!r} not in {sorted(RESTRUCTURE_TARGET_CLASSES)}"
            )
        mesh_count = target.get("mesh_count")
        if isinstance(mesh_count, bool) or not isinstance(mesh_count, int) or mesh_count < 0:
            errors.append(
                f"{label}: mesh_count must be an integer >= 0 (authoritative "
                f"default-predicate count), got {mesh_count!r}"
            )
    return errors


def load_recorded_manifests(
    report: Any, base_dir: Path
) -> tuple[list[tuple[str, Any]], list[str]]:
    """Load the manifests recorded in ``target_coverage.source_manifests[]``.

    Relative paths resolve against ``base_dir`` (the report's directory) so a
    report can carry its own provenance and the gate fails closed without the
    operator having to remember ``--manifest``. Returns ``(labeled_manifests,
    errors)`` where each labeled manifest is ``(source_path, manifest_dict)``.
    """
    labeled: list[tuple[str, Any]] = []
    errors: list[str] = []
    coverage = report.get("target_coverage") if isinstance(report, dict) else None
    if not isinstance(coverage, dict):
        return labeled, errors
    for rel in coverage.get("source_manifests", []) or []:
        path = Path(rel)
        if not path.is_absolute():
            path = base_dir / path
        try:
            labeled.append((rel, json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(
                f"target_coverage.source_manifests entry {rel!r} could not be loaded: {exc}"
            )
    return labeled, errors


def _manifest_targets(manifests: list[Any]) -> dict[str, int | None]:
    """Union of every manifest's phase4_targets path -> authoritative mesh_count.

    Multi-iteration runs must reconcile against the UNION: the exact regression
    that prompted this gate was iteration 1 listing an assembly_root that
    iteration 2's manifest dropped, leaving it uncovered by the final report.
    """
    planned: dict[str, int | None] = {}
    for manifest in manifests:
        for target in manifest.get("phase4_targets", []) or []:
            if isinstance(target, dict) and isinstance(target.get("path"), str):
                planned[target["path"]] = target.get("mesh_count")
    return planned


def reconcile_target_coverage(report: Any, manifests: list[Any] | None = None) -> list[str]:
    """Gate the report's Phase-4 target_coverage; reconcile against manifest(s).

    Returns violation messages (empty == the gate passes). Always checks the
    report's internal consistency (resolved dispositions, the
    ``skipped_zero_meshes => mesh_count == 0`` rule, and the ``complete`` flag).
    When ``manifests`` are supplied it also asserts the covered set equals the
    union of every manifest's ``phase4_targets[]`` and cross-checks each
    disposition against the manifest's authoritative ``mesh_count``.
    """
    errors: list[str] = []
    coverage = report.get("target_coverage") if isinstance(report, dict) else None
    if not isinstance(coverage, dict):
        return ["target_coverage missing or not an object"]
    entries = coverage.get("entries", [])
    by_path: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("path"), str):
            by_path[entry["path"]] = entry

    for entry in entries:
        path = entry.get("path", "<unknown>")
        disposition = entry.get("disposition")
        mesh_count = entry.get("mesh_count")
        if disposition == "skipped_zero_meshes" and mesh_count != 0:
            errors.append(
                f"target_coverage entry {path}: skipped_zero_meshes requires "
                f"mesh_count == 0, got {mesh_count!r} (a non-zero target cannot be skipped)"
            )

    present_restructure_roles = sorted(
        {e.get("role") for e in entries} & RESTRUCTURE_ROLES
    )
    if present_restructure_roles and not manifests:
        errors.append(
            "target_coverage has restructure role(s) "
            f"{present_restructure_roles} but no source manifest was supplied or recorded; "
            "reconciliation is mandatory once a restructure happened. Record "
            "target_coverage.source_manifests[] (or pass --manifest) so the covered set is "
            "reconciled against the planned phase4_targets[] instead of self-attested."
        )

    all_resolved = all(
        e.get("disposition") in PHASE4_RESOLVED_DISPOSITIONS for e in entries
    )
    if coverage.get("complete") is not True:
        errors.append(
            "target_coverage.complete must be true for a final report "
            "(false => a Phase-4 target is unresolved/blocked)"
        )
    elif not all_resolved:
        errors.append(
            "target_coverage.complete is true but some entries are unresolved "
            "(only optimized | skipped_zero_meshes | skipped_user_declined count as resolved)"
        )

    if manifests:
        planned = _manifest_targets(manifests)
        planned_paths = set(planned)
        covered_paths = set(by_path)
        for path in sorted(planned_paths - covered_paths):
            errors.append(
                f"target_coverage is missing an entry for manifest phase4_target: {path} "
                "(every planned Phase-4 target, across all iterations, must be covered)"
            )
        for path in sorted(covered_paths - planned_paths):
            errors.append(
                f"target_coverage entry {path} is not present in any supplied manifest "
                "phase4_targets[] (unexpected target or a missing manifest)"
            )
        for path in sorted(planned_paths & covered_paths):
            authoritative = planned[path]
            disposition = by_path[path].get("disposition")
            if (
                disposition == "skipped_zero_meshes"
                and isinstance(authoritative, int)
                and authoritative > 0
            ):
                errors.append(
                    f"target_coverage entry {path}: skipped_zero_meshes but the manifest's "
                    f"authoritative mesh_count is {authoritative} > 0 (lying skip)"
                )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="Path to the report JSON to validate.")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument(
        "--manifest",
        type=Path,
        action="append",
        default=[],
        help="apply-restructure manifest(s) to reconcile Phase-4 coverage against; "
        "repeat once per iteration so the union is checked. Manifests recorded in "
        "the report's target_coverage.source_manifests[] are loaded automatically "
        "and merged with these.",
    )
    args = parser.parse_args()

    report = json.loads(args.report.read_text(encoding="utf-8"))
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    errors = validate_report(report, schema)

    labeled: list[tuple[str, Any]] = []
    for manifest_path in args.manifest:
        labeled.append((manifest_path.name, json.loads(manifest_path.read_text(encoding="utf-8"))))
    recorded, load_errors = load_recorded_manifests(report, args.report.resolve().parent)
    errors.extend(load_errors)
    labeled.extend(recorded)

    for label, manifest in labeled:
        errors.extend(f"{label}: {msg}" for msg in validate_manifest_structure(manifest))

    manifests = [manifest for _, manifest in labeled]
    errors.extend(reconcile_target_coverage(report, manifests))

    if errors:
        print(f"{args.report}: INVALID ({len(errors)} error(s))")
        for error in errors:
            print(f"  {error}")
        return 1
    print(f"{args.report}: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
