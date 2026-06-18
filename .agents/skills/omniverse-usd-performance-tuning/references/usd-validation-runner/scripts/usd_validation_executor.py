# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Canonical validation reference executor for the USD performance-tuning skill.

This is the ONE supported way to run validators inside the skill. Agents call
this API with **canonical concept names** (e.g. ``primvar_indexability``); they
never enumerate rules, guess class names, or shell out to a CLI.

Why this exists
---------------
Bare rule names are not unique. ``IndexedPrimvarChecker`` is registered by both
Scene Optimizer (0.3 s triage) and the Asset Validator (376 s full audit). A
name-only lookup picks one by registry order, so the same scope note produces
different work and wildly different runtimes on different hosts. That is the
root cause of "every run finds a different solution and it takes forever."

Contract (no ambiguity, no fallbacks)
-------------------------------------
1. Identity is ``(module, class_name)``, sourced from ``validator-concepts.json``.
   Concept -> implementation -> rule class is resolved by identity, never by
   bare name.
2. Resolution is fail-closed: zero matches raises, more than one match raises.
   The executor never "best-guesses" a rule.
3. The Python validation runtime is required. If it cannot be imported, the
   executor raises ``ValidationRuntimeUnavailable`` and the caller records
   ``blocked_validation_runtime`` in the coverage ledger. There is no CLI path.
4. Scoping is mandatory for non-whole-stage policies: callers pass ``paths`` /
   ``mask_paths`` and the stage is opened with ``Usd.Stage.OpenMasked()``.

The validator runtime packages (``omni.asset_validator`` / ``pxr``) only import
inside a Kit/AV environment, so every runtime import is deferred into the
function that needs it. Importing this module is always safe (and unit-testable)
without those packages present.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

#: Every ledger disposition is an explicit "resolved" outcome. The completion
#: gate is satisfied only when every planned (target, concept) has one of these.
RESOLVED_STATUSES = frozenset(
    {
        "probed_with_findings",
        "probed_clean",
        "user_declined",
        "timeout_recorded",
        "blocked_validation_runtime",
    }
)

DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent.parent / "references" / "validator-concepts.json"
)


class ConceptResolutionError(RuntimeError):
    """A concept name or its identity could not be resolved unambiguously."""


class ValidationRuntimeUnavailable(RuntimeError):
    """The Python validation runtime is not importable. No CLI fallback exists."""


#: Single message for every "runtime missing" condition. Callers record
#: ``blocked_validation_runtime`` in the coverage ledger; there is no CLI path.
_RUNTIME_UNAVAILABLE = (
    "No USD validation runtime (omni.asset_validator[.core]) is importable. "
    "Record 'blocked_validation_runtime'; there is no CLI fallback."
)


@dataclass(frozen=True)
class ResolvedImplementation:
    """A concept resolved to a single runtime rule identity."""

    canonical_name: str
    provider: str
    module: str
    class_name: str
    tier: int
    scope_policy: str
    backing_op: str | None
    gpu_bound: bool


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #
def load_registry(path: str | Path | None = None) -> dict[str, Any]:
    """Load and index the canonical validator-concept registry.

    Returns a dict with the raw ``concepts`` list plus a ``by_name`` index.
    Raises ``ConceptResolutionError`` if a canonical name is duplicated.
    """
    registry_path = Path(path) if path is not None else DEFAULT_REGISTRY_PATH
    data = json.loads(Path(registry_path).read_text(encoding="utf-8"))
    by_name: dict[str, dict[str, Any]] = {}
    for concept in data["concepts"]:
        name = concept["canonical_name"]
        if name in by_name:
            raise ConceptResolutionError(f"Duplicate canonical_name in registry: {name}")
        by_name[name] = concept
    data["by_name"] = by_name
    return data


def resolve_implementation(
    registry: dict[str, Any],
    canonical_name: str,
    *,
    provider: str | None = None,
) -> ResolvedImplementation:
    """Resolve a canonical concept name to a single ``(module, class_name)``.

    ``provider`` defaults to the concept's ``preferred_provider`` (``so`` for
    performance tuning). Fail-closed: an unknown concept or a provider with no
    implementation raises ``ConceptResolutionError``.
    """
    concept = registry.get("by_name", {}).get(canonical_name)
    if concept is None:
        raise ConceptResolutionError(
            f"Unknown concept '{canonical_name}'. Concepts must come from "
            f"validator-concepts.json; do not synthesize names."
        )
    chosen_provider = provider or concept["preferred_provider"]
    impls = [im for im in concept["implementations"] if im["provider"] == chosen_provider]
    if not impls:
        raise ConceptResolutionError(
            f"Concept '{canonical_name}' has no '{chosen_provider}' implementation."
        )
    if len(impls) > 1:
        raise ConceptResolutionError(
            f"Concept '{canonical_name}' has ambiguous '{chosen_provider}' implementations."
        )
    impl = impls[0]
    return ResolvedImplementation(
        canonical_name=canonical_name,
        provider=impl["provider"],
        module=impl["module"],
        class_name=impl["class_name"],
        tier=int(impl.get("tier", concept["tier"])),
        scope_policy=concept["scope_policy"],
        backing_op=concept["backing_op"],
        gpu_bound=bool(concept["gpu_bound"]),
    )


# --------------------------------------------------------------------------- #
# Runtime                                                                      #
# --------------------------------------------------------------------------- #
def get_rule_registry() -> Any:
    """Return the validator runtime's rule registry, or fail closed.

    Tries the Kit core package first, then the standalone package. Raises
    ``ValidationRuntimeUnavailable`` if neither imports — there is no CLI path.
    """
    try:
        from omni.asset_validator.core import ValidationRulesRegistry  # type: ignore

        return ValidationRulesRegistry
    except ImportError:
        pass
    try:
        from omni.asset_validator import CategoryRuleRegistry  # type: ignore

        return CategoryRuleRegistry()
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ValidationRuntimeUnavailable(_RUNTIME_UNAVAILABLE) from exc


def get_validation_engine_cls() -> Any:
    """Return the ``ValidationEngine`` class, or fail closed.

    Kit exposes it at ``omni.asset_validator.core``; the standalone package
    exposes it at ``omni.asset_validator`` (no ``.core``). Try both so the same
    executor works in either runtime.
    """
    try:
        from omni.asset_validator.core import ValidationEngine  # type: ignore

        return ValidationEngine
    except ImportError:
        pass
    try:
        from omni.asset_validator import ValidationEngine  # type: ignore

        return ValidationEngine
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ValidationRuntimeUnavailable(_RUNTIME_UNAVAILABLE) from exc


def iter_registered_rules(rule_registry: Any) -> Iterable[type]:
    """Yield every registered rule *class* (collision-aware enumeration).

    Identity lives on the class as ``__module__`` and ``__name__``. This adapts
    to the differing registry shapes across runtimes but never collapses rules
    to bare names. Fail-closed: if no enumeration entry point is found, raises.
    """
    # Scene Optimizer registers its rules on import for discovery.
    try:
        import omni.scene.optimizer.validators  # type: ignore  # noqa: F401
    except ImportError:  # pragma: no cover - environment dependent
        pass

    # Known registry shapes, probed by entry point (never collapsed to bare
    # names — matching stays identity-based below):
    #   - ``registered_rules``  Kit core ValidationRulesRegistry (iterable/callable)
    #   - ``rules_by_name``     older name->rule map
    #   - ``rules``             OAV 1.18.0 CategoryRuleRegistry (iterable of classes)
    # This is a runtime adapter, not a correctness fallback. Extend here only if
    # a new runtime exposes another shape, and only with an entry point that
    # yields rule classes carrying real ``__module__`` / ``__name__`` identity.
    rules = getattr(rule_registry, "registered_rules", None)
    if callable(rules):
        rules = rules()
    if rules is None:
        mapping = getattr(rule_registry, "rules_by_name", None)
        rules = mapping.values() if isinstance(mapping, dict) else None
    if rules is None:
        direct = getattr(rule_registry, "rules", None)
        if callable(direct):
            direct = direct()
        if isinstance(direct, dict):
            direct = direct.values()
        rules = direct
    if rules is None:
        raise ValidationRuntimeUnavailable(
            "Could not enumerate registered rules from the runtime registry; the "
            "registry API shape is unrecognized. Record the gap rather than guessing."
        )

    for rule in rules:
        rule_cls = getattr(rule, "rule", rule)  # unwrap registration wrappers
        if isinstance(rule_cls, type):
            yield rule_cls


def resolve_rule_class(rule_registry: Any, module: str, class_name: str) -> type:
    """Resolve ``(module, class_name)`` to exactly one registered rule class.

    This is the collision-safe core. ``IndexedPrimvarChecker`` exists twice by
    bare name but is unique by ``(module, __name__)``. Fail-closed on zero or
    multiple matches.
    """
    matches = [
        rule_cls
        for rule_cls in iter_registered_rules(rule_registry)
        if rule_cls.__module__ == module and rule_cls.__name__ == class_name
    ]
    if not matches:
        raise ConceptResolutionError(
            f"Rule not registered in this runtime: {module}.{class_name}. "
            f"Confirm the providing package was imported."
        )
    if len(matches) > 1:
        raise ConceptResolutionError(
            f"Ambiguous rule identity: {module}.{class_name} matched "
            f"{len(matches)} registered classes."
        )
    return matches[0]


# --------------------------------------------------------------------------- #
# Scoped stage open                                                            #
# --------------------------------------------------------------------------- #
def open_scoped_stage(stage_path: str, mask_paths: list[str] | None = None) -> Any:
    """Open a stage, optionally masked to ``mask_paths`` (+ the default prim).

    ``Usd.Stage.OpenMasked()`` is the only reliable scoping mechanism for the
    Asset Validator (it discards caller ``StageLoadRules`` but preserves the
    population mask). Rejects an empty masked sample so the caller never reports
    a misleading "0 findings".
    """
    from pxr import Sdf, Usd, UsdGeom  # deferred runtime import

    if not mask_paths:
        return Usd.Stage.Open(stage_path)

    root_layer = Sdf.Layer.FindOrOpen(stage_path)
    mask = Usd.StagePopulationMask()
    default_prim_path = f"/{root_layer.defaultPrim}" if root_layer.defaultPrim else None
    for path in [*mask_paths, default_prim_path]:
        if path:
            mask.Add(path)

    stage = Usd.Stage.OpenMasked(root_layer, mask)
    assert stage.GetDefaultPrim().IsValid(), "masked stage excluded default prim"

    mesh_count = sum(
        1
        for prim in Usd.PrimRange.Stage(
            stage, Usd.TraverseInstanceProxies(Usd.PrimDefaultPredicate)
        )
        if prim.IsA(UsdGeom.Mesh)
    )
    if mesh_count == 0:
        raise RuntimeError("masked validation sample contains no meshes")
    return stage


# --------------------------------------------------------------------------- #
# Selected validation                                                          #
# --------------------------------------------------------------------------- #
def validate_concepts(
    stage_path: str,
    concepts: list[str],
    *,
    registry: dict[str, Any] | None = None,
    mask_paths: list[str] | None = None,
    provider: str | None = None,
) -> list[Any]:
    """Run the named canonical concepts on a (optionally masked) stage.

    Enables exactly the resolved rule classes — never ``init_rules=True`` — so
    only the selected concepts execute. Intended to be invoked once per Tier 1
    batch, and from a bounded ``subprocess`` per target for Tier 2 / Tier 3 so
    a slow C++ rule can be killed by the parent (see the runner README).

    Returns the list of issues. Resolution failures fail closed; a missing
    runtime raises ``ValidationRuntimeUnavailable``.
    """
    reg = registry if registry is not None else load_registry()
    rule_registry = get_rule_registry()
    engine_cls = get_validation_engine_cls()

    engine = engine_cls(init_rules=False)
    for canonical_name in concepts:
        impl = resolve_implementation(reg, canonical_name, provider=provider)
        rule_cls = resolve_rule_class(rule_registry, impl.module, impl.class_name)
        engine.enable_rule(rule_cls)

    stage = open_scoped_stage(stage_path, mask_paths)
    return list(engine.validate(stage).issues())


# --------------------------------------------------------------------------- #
# Coverage ledger + completion gate                                           #
# --------------------------------------------------------------------------- #
def coverage_complete(
    planned_targets: list[dict[str, Any]],
    ledger_entries: list[dict[str, Any]],
) -> bool:
    """The completion gate.

    Returns True only when every planned ``(target, concept)`` has a ledger
    entry with a resolved status. This is what prevents an agent from declaring
    victory while a flagged Tier 3 probe was silently skipped: an unresolved
    target has no entry, so the gate stays closed and the report's
    ``coverage_ledger.complete`` is False.
    """
    planned = {
        (t["target"], t["concept"])
        for tgt in planned_targets
        for t in _expand_target(tgt)
    }
    covered = {
        (e["target"], e["concept"])
        for e in ledger_entries
        if e["status"] in RESOLVED_STATUSES
    }
    return planned.issubset(covered)


def _iter_execution_units(
    target: dict[str, Any],
) -> Iterable[tuple[dict[str, str], list[str]]]:
    """Yield ``(ledger_unit, mask_paths)`` for each concrete path/pair in a target.

    The mask is built **per unit** so every probe is scoped to exactly its own
    geometry — and, critically, a ``pairs`` entry contributes *both* prim paths
    to the mask. (The earlier code derived the mask from ``paths``/``mask_paths``
    only, so a pairs-only spatial target produced an empty mask and silently ran
    the approval-gated full stage while the ledger logged it as a scoped probe.)

    A target with no concrete paths/pairs yields a single whole-stage unit with
    an empty mask; ``run_scope_note`` permits that only for ``whole_stage``
    concepts and otherwise fails closed.
    """
    concept = target["concept"]
    singles = list(target.get("paths", [])) + list(target.get("mask_paths", []))
    pairs = [list(p) for p in target.get("pairs", [])]
    produced = False
    for path in singles:
        produced = True
        yield {"target": path, "concept": concept}, [path]
    for pair in pairs:
        produced = True
        yield {"target": "::".join(pair), "concept": concept}, list(pair)
    if not produced:
        yield {"target": "<whole_stage>", "concept": concept}, []


def _expand_target(target: dict[str, Any]) -> Iterable[dict[str, str]]:
    """Yield one ``{target, concept}`` per concrete path/pair (ledger identity).

    Shares its expansion with execution via ``_iter_execution_units`` so the
    completion gate and the executor can never disagree about what was planned.
    """
    for unit, _mask in _iter_execution_units(target):
        yield unit


def run_scope_note(
    stage_path: str,
    scope_note: dict[str, Any],
    *,
    registry: dict[str, Any] | None = None,
    concept_runner: Callable[..., list[Any]] | None = None,
    phase: str = "baseline",
    provider: str | None = None,
) -> dict[str, Any]:
    """Execute a scope note tier-by-tier and build a schema-valid report.

    ``concept_runner(stage_path, concept, mask_paths=...) -> issues`` is
    injectable so Tier 2/3 work can be wrapped in a killable subprocess (see the
    runner README's driver section). The default runs in-process via
    ``validate_concepts``; for Tier 2/3 the caller should pass a subprocess
    driver so one slow C++ rule cannot hang the batch.

    Each target's disposition is recorded in the coverage ledger:
      - issues found        -> ``probed_with_findings``
      - clean               -> ``probed_clean``
      - subprocess timeout  -> ``timeout_recorded`` (retry masked/standalone)
      - runtime unavailable -> ``blocked_validation_runtime``
    Resolution failures (unknown/ambiguous concept) are NOT swallowed — they
    raise, because they indicate a malformed plan, not a runtime condition.
    """
    reg = registry if registry is not None else load_registry()
    run = concept_runner if concept_runner is not None else validate_concepts

    validators: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    error_count = 0

    for target in scope_note.get("targets", []):
        concept = target["concept"]
        impl = resolve_implementation(reg, concept, provider=provider)  # fail-closed
        base_entry = {
            "name": concept,
            "kind": "rule",
            "canonical_name": concept,
            "module": impl.module,
            "class_name": impl.class_name,
        }
        for unit, mask_paths in _iter_execution_units(target):
            if impl.scope_policy != "whole_stage" and not mask_paths:
                raise ConceptResolutionError(
                    f"Concept '{concept}' has scope_policy '{impl.scope_policy}' but its "
                    f"target supplied no paths or pairs to scope to. A scoped concept "
                    f"must never fall back to an implicit full-stage run; fix the scope "
                    f"note (provide paths/pairs, or use the approved full-sweep path)."
                )
            try:
                issues = run(stage_path, [concept], registry=reg, mask_paths=mask_paths)
            except subprocess.TimeoutExpired:
                validators.append({**base_entry, "status": "TIMEOUT"})
                ledger.append({**unit, "tier": impl.tier, "status": "timeout_recorded"})
                continue
            except ValidationRuntimeUnavailable as exc:
                validators.append({**base_entry, "status": "BLOCKED", "notes": str(exc)})
                ledger.append({**unit, "tier": impl.tier, "status": "blocked_validation_runtime"})
                continue
            count = len(issues)
            error_count += count
            validators.append({**base_entry, "status": "FAIL" if count else "PASS", "issues": count})
            ledger.append({
                **unit,
                "tier": impl.tier,
                "status": "probed_with_findings" if count else "probed_clean",
            })

    complete = coverage_complete(scope_note.get("targets", []), ledger)
    return {
        "schemaVersion": "1.0.0",
        "phase": phase,
        "stage": {"identifier": stage_path},
        "validators": validators,
        "summary": {
            "status": "BLOCKED" if not complete else ("FAIL" if error_count else "PASS"),
            "errorCount": error_count,
            "warningCount": 0,
        },
        "coverage_ledger": {"complete": complete, "entries": ledger},
    }


# --------------------------------------------------------------------------- #
# Subprocess runner (killable Tier 2 / Tier 3)                                 #
# --------------------------------------------------------------------------- #
def subprocess_concept_runner(
    *,
    timeout_seconds: int = 120,
    python_executable: str | None = None,
    registry_path: str | Path | None = None,
) -> Callable[..., list[Any]]:
    """Build a ``concept_runner`` that runs each concept in a child process.

    Tier 2 / Tier 3 rules are C++-heavy and can hang; Python ``signal``/threads
    cannot interrupt them. Running each concept in a child process means the
    parent can kill it on timeout. Pass the returned callable as
    ``run_scope_note(..., concept_runner=subprocess_concept_runner())``.

    The child is invoked as ``python <this file>`` with a JSON job on stdin and
    a JSON result on stdout — an internal worker protocol, not a CLI: there are
    no rule-selection flags. On timeout, ``subprocess.TimeoutExpired`` propagates
    (``run_scope_note`` records ``timeout_recorded``). A child that reports the
    runtime missing raises ``ValidationRuntimeUnavailable``.
    """
    import os
    import sys

    executable = python_executable or sys.executable
    worker = str(Path(__file__).resolve())

    def _runner(stage_path, concepts, *, registry=None, mask_paths=None):
        job = json.dumps(
            {
                "stage_path": stage_path,
                "concept": concepts[0],
                "mask_paths": mask_paths or [],
                "registry_path": str(registry_path) if registry_path else None,
            }
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(Path(worker).parent), env.get("PYTHONPATH", "")]
        )
        completed = subprocess.run(
            [executable, worker],
            input=job,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"validation worker failed (rc={completed.returncode}): "
                f"{completed.stderr.strip()[:500]}"
            )
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        if result.get("status") == "blocked_validation_runtime":
            raise ValidationRuntimeUnavailable(result.get("detail", "runtime unavailable"))
        return list(result.get("issues", []))

    return _runner


def _worker_main() -> int:
    """Child entrypoint: read one JSON job from stdin, print a JSON result.

    Internal protocol used by ``subprocess_concept_runner`` — not a user CLI.
    """
    import sys

    job = json.loads(sys.stdin.read())
    registry = load_registry(job.get("registry_path"))
    try:
        issues = validate_concepts(
            job["stage_path"],
            [job["concept"]],
            registry=registry,
            mask_paths=job.get("mask_paths") or None,
        )
    except ValidationRuntimeUnavailable as exc:
        print(json.dumps({"status": "blocked_validation_runtime", "detail": str(exc)}))
        return 0
    print(json.dumps({"status": "ok", "issues": [str(i) for i in issues]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(_worker_main())
