#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
NemoClaw Blueprint Runner

Orchestrates OpenClaw sandbox lifecycle inside OpenShell.
Called by the thin TS plugin via subprocess.

Protocol:
  - stdout lines starting with PROGRESS:<0-100>:<label> are parsed as progress updates
  - stdout line RUN_ID:<id> reports the run identifier
  - exit code 0 = success, non-zero = failure
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

RUN_ID_PATTERN = re.compile(r"^nc-\d{8}-\d{6}-[0-9a-f]{8}$")


def validate_run_id(rid: str) -> None:
    """Ensure the RUN_ID is a valid format to prevent path traversal and misuse."""
    if not RUN_ID_PATTERN.fullmatch(rid):
        log(f"ERROR: Invalid Run ID format: {rid}")
        log("Expected format: nc-YYYYMMDD-HHMMSS-xxxxxxxx")
        sys.exit(1)


def log(msg: str) -> None:
    print(msg, flush=True)


def progress(pct: int, label: str) -> None:
    print(f"PROGRESS:{pct}:{label}", flush=True)


def emit_run_id() -> str:
    rid = f"nc-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    print(f"RUN_ID:{rid}", flush=True)
    return rid


def load_blueprint() -> dict[str, Any]:
    blueprint_path = Path(os.environ.get("NEMOCLAW_BLUEPRINT_PATH", "."))
    bp_file = blueprint_path / "blueprint.yaml"
    if not bp_file.exists():
        log(f"ERROR: blueprint.yaml not found at {bp_file}")
        sys.exit(1)
    with bp_file.open() as f:
        return yaml.safe_load(f)


def run_cmd(
    args: list[str],
    *,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run a command as an argv list (never shell=True)."""
    return subprocess.run(
        args,
        check=check,
        capture_output=capture,
        text=True,
    )


def openshell_available() -> bool:
    """Check if openshell CLI is available."""
    return shutil.which("openshell") is not None


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


def action_plan(
    profile: str,
    blueprint: dict[str, Any],
    *,
    dry_run: bool = False,
    endpoint_url: str | None = None,
) -> dict[str, Any]:
    """Plan the deployment: validate inputs, resolve profile, check prerequisites."""
    rid = emit_run_id()
    progress(10, "Validating blueprint")

    inference_profiles: dict[str, Any] = (
        blueprint.get("components", {}).get("inference", {}).get("profiles", {})
    )
    if profile not in inference_profiles:
        available = ", ".join(inference_profiles.keys())
        log(f"ERROR: Profile '{profile}' not found. Available: {available}")
        sys.exit(1)

    progress(20, "Checking prerequisites")
    if not openshell_available():
        log("ERROR: openshell CLI not found. Install OpenShell first.")
        log("  See: https://github.com/NVIDIA/OpenShell")
        sys.exit(1)

    sandbox_cfg: dict[str, Any] = blueprint.get("components", {}).get("sandbox", {})
    inference_cfg: dict[str, Any] = inference_profiles[profile]

    # Override endpoint if provided (e.g., NCP dynamic endpoint)
    if endpoint_url:
        inference_cfg = {**inference_cfg, "endpoint": endpoint_url}

    plan: dict[str, Any] = {
        "run_id": rid,
        "profile": profile,
        "sandbox": {
            "image": sandbox_cfg.get("image", "openclaw"),
            "name": sandbox_cfg.get("name", "openclaw"),
            "forward_ports": sandbox_cfg.get("forward_ports", [18789]),
        },
        "inference": {
            "provider_type": inference_cfg.get("provider_type"),
            "provider_name": inference_cfg.get("provider_name"),
            "endpoint": inference_cfg.get("endpoint"),
            "model": inference_cfg.get("model"),
            "credential_env": inference_cfg.get("credential_env"),
        },
        "policy_additions": (
            blueprint.get("components", {}).get("policy", {}).get("additions", {})
        ),
        "dry_run": dry_run,
    }

    progress(85, "Saving plan")
    state_dir = Path.home() / ".nemoclaw" / "state" / "runs" / rid
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "plan.json").write_text(json.dumps(plan, indent=2))

    progress(100, "Plan complete")
    log(json.dumps(plan, indent=2))
    return plan


def action_apply(
    profile: str,
    blueprint: dict[str, Any],
    plan_path: str | None = None,
    endpoint_url: str | None = None,
) -> None:
    """Apply the plan: create sandbox, configure provider, set inference route."""
    # Reuse plan ID if provided, otherwise generate one
    if plan_path:
        rid = plan_path
        # The TS layer needs to see the RUN_ID line to confirm tracking
        print(f"RUN_ID:{rid}", flush=True)
    else:
        rid = emit_run_id()

    # If --plan is provided, it is the AUTHORITATIVE source of truth.
    # We ignore the current blueprint and profile to ensure we apply exactly what was planned.
    if plan_path:
        plan_file = Path.home() / ".nemoclaw" / "state" / "runs" / plan_path / "plan.json"
        if not plan_file.exists():
            log(f"ERROR: Plan file not found at {plan_file}")
            sys.exit(1)

        plan_data = json.loads(plan_file.read_text())
        inference_cfg = plan_data.get("inference", {})
        sandbox_cfg = plan_data.get("sandbox", {})

        # Log that we are using a stored plan
        log(f"Applying stored plan for run {rid}")
    else:
        # No plan: resolve from current blueprint and profile
        inference_profiles: dict[str, Any] = (
            blueprint.get("components", {}).get("inference", {}).get("profiles", {})
        )
        if profile not in inference_profiles:
            available = ", ".join(inference_profiles.keys())
            log(f"ERROR: Profile '{profile}' not found. Available: {available}")
            sys.exit(1)

        inference_cfg = inference_profiles.get(profile, {})
        sandbox_cfg = blueprint.get("components", {}).get("sandbox", {})

    # Override endpoint if provided (e.g., NCP dynamic endpoint override during apply)
    if endpoint_url:
        inference_cfg = {**inference_cfg, "endpoint": endpoint_url}

    sandbox_name: str = sandbox_cfg.get("name", "openclaw")
    sandbox_image: str = sandbox_cfg.get("image", "openclaw")
    forward_ports: list[int] = sandbox_cfg.get("forward_ports", [18789])

    # Step 1: Create sandbox
    progress(20, "Creating OpenClaw sandbox")
    create_args = [
        "openshell",
        "sandbox",
        "create",
        "--from",
        sandbox_image,
        "--name",
        sandbox_name,
    ]
    for port in forward_ports:
        create_args.extend(["--forward", str(port)])

    result = run_cmd(create_args, check=False, capture=True)
    if result.returncode != 0:
        if "already exists" in (result.stderr or ""):
            log(f"Sandbox '{sandbox_name}' already exists, reusing.")
        else:
            log(f"ERROR: Failed to create sandbox: {result.stderr}")
            sys.exit(1)

    # Step 2: Configure inference provider
    progress(50, "Configuring inference provider")
    provider_name: str = inference_cfg.get("provider_name", "default")
    provider_type: str = inference_cfg.get("provider_type", "openai")
    endpoint: str = inference_cfg.get("endpoint", "")
    model: str = inference_cfg.get("model", "")

    # Resolve credential from environment
    credential_env = inference_cfg.get("credential_env")
    credential_default: str = inference_cfg.get("credential_default", "")
    credential = ""
    if credential_env:
        credential = os.environ.get(credential_env, credential_default)

    provider_args = [
        "openshell",
        "provider",
        "create",
        "--name",
        provider_name,
        "--type",
        provider_type,
    ]
    if credential:
        provider_args.extend(["--credential", f"OPENAI_API_KEY={credential}"])
    if endpoint:
        provider_args.extend(["--config", f"OPENAI_BASE_URL={endpoint}"])

    run_cmd(provider_args, check=False, capture=True)

    # Step 3: Set inference route
    progress(70, "Setting inference route")
    run_cmd(
        ["openshell", "inference", "set", "--provider", provider_name, "--model", model],
        check=False,
        capture=True,
    )

    # Step 4: Save run state (separate from plan.json)
    progress(85, "Saving run state")
    state_dir = Path.home() / ".nemoclaw" / "state" / "runs" / rid
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "run.json").write_text(
        json.dumps(
            {
                "run_id": rid,
                "profile": profile,
                "sandbox_name": sandbox_name,
                "inference": inference_cfg,
                "timestamp": datetime.now(UTC).isoformat(),
                "status": "applied",
            },
            indent=2,
        )
    )

    progress(100, "Apply complete")
    log(f"Sandbox '{sandbox_name}' is ready.")
    log(f"Inference: {provider_name} -> {model} @ {endpoint}")


def action_status(rid: str | None = None) -> None:
    """Report current state of the most recent (or specified) run."""
    emit_run_id()
    state_dir = Path.home() / ".nemoclaw" / "state" / "runs"

    if rid:
        run_dir = state_dir / rid
    else:
        if not state_dir.exists():
            log("No runs found.")
            sys.exit(0)
        runs = sorted(
            [d for d in state_dir.iterdir() if d.is_dir() and RUN_ID_PATTERN.fullmatch(d.name)],
            key=lambda x: x.name,
            reverse=True,
        )
        if not runs:
            log("No runs found.")
            sys.exit(0)
        run_dir = runs[0]

    run_file = run_dir / "run.json"
    plan_file = run_dir / "plan.json"

    if run_file.exists():
        log(run_file.read_text())
    elif plan_file.exists():
        log(plan_file.read_text())
    else:
        log(json.dumps({"run_id": run_dir.name, "status": "unknown"}))


def action_rollback(rid: str) -> None:
    """Rollback a specific run: stop sandbox, remove provider config."""
    emit_run_id()

    state_dir = Path.home() / ".nemoclaw" / "state" / "runs" / rid
    if not state_dir.exists():
        log(f"ERROR: Run {rid} not found.")
        sys.exit(1)

    run_file = state_dir / "run.json"
    if run_file.exists():
        run_data = json.loads(run_file.read_text())
        sandbox_name = run_data.get("sandbox_name", "openclaw")

        progress(30, f"Stopping sandbox {sandbox_name}")
        run_cmd(
            ["openshell", "sandbox", "stop", sandbox_name],
            check=False,
            capture=True,
        )

        progress(60, f"Removing sandbox {sandbox_name}")
        run_cmd(
            ["openshell", "sandbox", "remove", sandbox_name],
            check=False,
            capture=True,
        )
    else:
        log(f"ERROR: No run state found for {rid}. Cannot rollback.")
        sys.exit(1)

    progress(90, "Cleaning up run state")
    (state_dir / "rolled_back").write_text(datetime.now(UTC).isoformat())

    progress(100, "Rollback complete")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="NemoClaw Blueprint Runner")
    parser.add_argument("action", choices=["plan", "apply", "status", "rollback"])
    parser.add_argument("--profile", default="default")
    parser.add_argument("--plan", dest="plan_path")
    parser.add_argument("--run-id", dest="run_id")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--endpoint-url",
        dest="endpoint_url",
        default=None,
        help="Override endpoint URL for the selected profile",
    )

    args = parser.parse_args()
    blueprint = load_blueprint()

    if args.action == "plan":
        action_plan(args.profile, blueprint, dry_run=args.dry_run, endpoint_url=args.endpoint_url)
    elif args.action == "apply":
        if args.plan_path:
            validate_run_id(args.plan_path)
        action_apply(
            args.profile, blueprint, plan_path=args.plan_path, endpoint_url=args.endpoint_url
        )
    elif args.action == "status":
        if args.run_id:
            validate_run_id(args.run_id)
        action_status(rid=args.run_id)
    elif args.action == "rollback":
        if not args.run_id:
            log("ERROR: --run-id is required for rollback")
            sys.exit(1)
        validate_run_id(args.run_id)
        action_rollback(args.run_id)


if __name__ == "__main__":
    main()
