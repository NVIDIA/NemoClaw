#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify and summarize evidence from the Hermes Switchyard prototype."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sys
from collections import Counter
from pathlib import Path
from typing import Any

RESULT_PREFIX = "NEMOCLAW_HERMES_SWITCHYARD_PROTOTYPE="
CLIENT_SENTINEL = "nemoclaw-prototype-client-sentinel"
PROVIDER_SENTINEL = "Bearer nemoclaw-prototype-provider-sentinel"
BOUNDED_PROMPT = (
    "Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 "
    "medium findings."
)
CAPABLE_PROMPT = (
    "Design a fail-closed remediation plan for critical vulnerabilities across "
    "multiple services, including credential isolation, rollback, and end-to-end "
    "validation."
)
REQUIRED_MARKS = {
    "switchyard.routing.call",
    "switchyard.routing.decision",
    "switchyard.routing.requested",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_json_lines(path: Path) -> tuple[str, list[dict[str, Any]]]:
    raw = path.read_text(encoding="utf-8")
    records = [json.loads(line) for line in raw.splitlines() if line.strip()]
    return raw, records


def process_names() -> set[str]:
    names: set[str] = set()
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            names.add(Path(os.readlink(process / "exe")).name)
        except OSError:
            continue
    return names


def verify(args: argparse.Namespace) -> None:
    provider_raw, provider_events = read_json_lines(args.provider_log)
    atof_raw, atof_events = read_json_lines(args.atof_log)
    relay_raw = args.relay_log.read_text(encoding="utf-8")
    combined = provider_raw + atof_raw + relay_raw
    if CLIENT_SENTINEL in combined or PROVIDER_SENTINEL in combined:
        fail("credential sentinel was written to prototype evidence")

    models = [event.get("model") for event in provider_events]
    expected_models = [
        "provider/classifier",
        "provider/fast",
        "provider/classifier",
        "provider/quality",
    ]
    if models != expected_models:
        fail(f"expected weak and strong routed turns, got {models!r}")
    if len(provider_events) != 4 or not all(
        event.get("accepted") is True for event in provider_events
    ):
        fail("provider observed an unexpected or rejected request")
    if any(event.get("path") != "/v1/chat/completions" for event in provider_events):
        fail("Relay dispatched a provider request to an unexpected path")
    if not all(event.get("authorization_matches") is True for event in provider_events):
        fail("Relay did not replace caller credentials with target credentials")
    if not all(event.get("client_executable") == "nemo-relay" for event in provider_events):
        fail("provider socket was not owned by Relay")
    if any(event.get("unexpected_credential_seen") is True for event in provider_events):
        fail("provider observed a credential sentinel outside the target authorization header")
    if any(event.get("switchyard_server_seen") is True for event in provider_events):
        fail("a separate switchyard-server process was observed")
    classifier_events = provider_events[::2]
    routed_events = provider_events[1::2]
    if any(
        event.get("response_format_type") != "json_schema"
        for event in classifier_events
    ):
        fail("classifier requests did not carry Switchyard's structured response contract")
    stream_modes = [event.get("stream") for event in provider_events]
    if stream_modes != [True, True, True, True]:
        fail(
            "expected Switchyard classifier and routed provider requests to preserve "
            f"Hermes streaming, got {stream_modes!r}"
        )

    mark_events = [
        event for event in atof_events if str(event.get("name", "")).startswith("switchyard.routing.")
    ]
    mark_names = {event["name"] for event in mark_events}
    missing_marks = REQUIRED_MARKS - mark_names
    if missing_marks:
        fail(f"missing Switchyard routing marks: {sorted(missing_marks)}")
    mark_counts = Counter(event["name"] for event in mark_events)
    expected_mark_counts = {
        "switchyard.routing.call": 4,
        "switchyard.routing.decision": 2,
        "switchyard.routing.requested": 2,
    }
    if mark_counts != expected_mark_counts:
        fail(
            "unexpected Switchyard routing lifecycle: "
            f"expected {expected_mark_counts!r}, got {dict(mark_counts)!r}"
        )

    decisions = [
        event
        for event in mark_events
        if event.get("name") == "switchyard.routing.decision"
        and event.get("data", {}).get("is_routed_call") is True
    ]
    decision_targets = [event.get("data", {}).get("semantic_target") for event in decisions]
    if decision_targets != ["fast", "quality"]:
        fail(f"expected Switchyard decisions selecting fast then quality, got {decision_targets!r}")

    call_roles = {
        event.get("data", {}).get("is_routed_call")
        for event in mark_events
        if event.get("name") == "switchyard.routing.call"
    }
    if call_roles != {False, True}:
        fail("expected one classifier call and one routed provider call")

    final_stream_models = [
        event.get("category_profile", {}).get("annotated_response", {}).get("model")
        for event in atof_events
        if event.get("kind") == "scope"
        and event.get("scope_category") == "end"
        and "streaming" in event.get("attributes", [])
    ]
    if not all(model in final_stream_models for model in ("provider/fast", "provider/quality")):
        fail("ATOF did not preserve both streamed routed responses")

    expected_demo = [
        ("bounded-summary", BOUNDED_PROMPT, "weak", "fast", "provider/fast"),
        ("risk-remediation", CAPABLE_PROMPT, "strong", "quality", "provider/quality"),
    ]
    demo_turns = []
    for classifier, routed, (turn, prompt, tier, target, model) in zip(
        classifier_events, routed_events, expected_demo, strict=True
    ):
        if (
            classifier.get("demo_turn") != turn
            or classifier.get("classifier_tier") != tier
            or routed.get("demo_turn") != turn
            or routed.get("selected_tier") != tier
            or routed.get("model") != model
            or not isinstance(classifier.get("classifier_reason"), str)
            or not isinstance(routed.get("demo_answer"), str)
        ):
            fail(f"invalid demo evidence for {turn}")
        demo_turns.append(
            {
                "answer": routed["demo_answer"],
                "model": model,
                "prompt": prompt,
                "reason": classifier["classifier_reason"],
                "target": target,
                "tier": tier,
                "turn": turn,
            }
        )

    running = process_names()
    if "nemo-relay" in running or "switchyard-server" in running:
        fail("Relay or switchyard-server remained after the wrapped Hermes process exited")
    if list(Path("/tmp").glob(".nemo-relay-hermes-home*")):
        fail("Relay left a process-private Hermes overlay behind")

    interfaces = {name for _, name in socket.if_nameindex()}
    if args.runtime == "standalone":
        if interfaces != {"lo"}:
            fail(
                "standalone prototype container has unexpected network interfaces: "
                f"{sorted(interfaces)}"
            )
        network = "none"
    else:
        if "lo" not in interfaces or interfaces == {"lo"}:
            fail(
                "managed prototype did not expose both loopback and an OpenShell "
                f"network interface: {sorted(interfaces)}"
            )
        network = "openshell-managed"

    binary_sha256 = hashlib.sha256(args.relay_binary.read_bytes()).hexdigest()
    result = {
        "atof_routing_marks": sorted(mark_names),
        "credentials_redacted": True,
        "demo_turns": demo_turns,
        "hermes_version": os.environ["PROTOTYPE_HERMES_VERSION"],
        "network": network,
        "provider_models": models,
        "provider_streaming": stream_modes,
        "relay_binary_sha256": binary_sha256,
        "relay_version": os.environ["PROTOTYPE_RELAY_VERSION"],
        "runtime": args.runtime,
        "separate_switchyard_process": False,
        "status": "pass",
        "streaming": True,
    }
    print(RESULT_PREFIX + json.dumps(result, separators=(",", ":"), sort_keys=True))


def diagnose(path: Path) -> None:
    raw = path.read_text(encoding="utf-8", errors="replace")
    for sentinel in (CLIENT_SENTINEL, PROVIDER_SENTINEL):
        raw = raw.replace(sentinel, "[REDACTED]")
    sys.stderr.write(raw[-16_000:])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    diagnose_parser = commands.add_parser("diagnose")
    diagnose_parser.add_argument("relay_log", type=Path)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--atof-log", type=Path, required=True)
    verify_parser.add_argument("--provider-log", type=Path, required=True)
    verify_parser.add_argument("--relay-binary", type=Path, required=True)
    verify_parser.add_argument("--relay-log", type=Path, required=True)
    verify_parser.add_argument(
        "--runtime",
        choices=("standalone", "nemoclaw-managed"),
        required=True,
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "diagnose":
        diagnose(args.relay_log)
    else:
        verify(args)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"prototype verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
