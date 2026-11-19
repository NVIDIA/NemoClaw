# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Payload-free projection of pinned Relay 0.8.3 routing events.

Do not serialize an event or its metadata wholesale. Native scope UUIDs retain
ancestry to the Hermes turn; model hashes bind observed selections to the
protected deployment without retaining arbitrary provider-controlled strings.
This module neither initializes Relay nor changes its routing decisions.
"""

import hashlib
import importlib.util
import json
import logging
import os
import re
import threading
import tomllib
import uuid


DECISION = "switchyard.routing.decision"
CALL = "switchyard.routing.llm_call"
TOKENS = "switchyard.routing.llm_tokens"
MAX_TOKENS = 2**53 - 1


def _uuid(value):
    if type(value) is not str or len(value) != 36:
        return None
    try:
        parsed = str(uuid.UUID(value))
    except ValueError:
        return None
    return parsed if parsed == value else None


def _model(value, models):
    if type(value) is not str or value not in models:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _count(value):
    return type(value) is int and 0 <= value <= MAX_TOKENS


def project(event, models):
    """Return an allowlisted record, or None for unsupported/malformed events.

    ``models`` is the selected_models tuple from the protected deployment:
    judge, efficient, capable. Source labels and outcomes are finite enums;
    unknown native schemas fail closed rather than exporting their payloads.
    """
    identity = _uuid(getattr(event, "uuid", None))
    parent_value = getattr(event, "parent_uuid", None)
    parent = _uuid(parent_value)
    if identity is None or (parent_value is not None and parent is None):
        return None
    record = {"schema": 1, "uuid": identity, "parent_uuid": parent}
    kind = getattr(event, "kind", None)
    name = getattr(event, "name", None)
    if kind == "scope":
        phase = getattr(event, "scope_category", None)
        if phase not in ("start", "end"):
            return None
        record.update(kind="scope", phase=phase, hermes_turn=name == "hermes.turn")
        return record
    if kind != "mark" or name not in (DECISION, CALL, TOKENS):
        return None
    data = getattr(event, "data", None)
    if type(data) is not dict:
        return None
    record.update(kind="mark", name=name)
    if name == DECISION:
        selected = _model(data.get("selected_model"), models[1:])
        evidence = data.get("evidence")
        if selected is None or type(evidence) is not dict:
            return None
        if evidence.get("source") != "llm-classifier":
            return None
        record.update(selected_model_sha256=selected, source="llm-classifier")
    elif name == CALL:
        role = data.get("call_role")
        allowed = models[:1] if role == "routing" else models[1:]
        selected = _model(data.get("selected_model"), allowed)
        outcome = data.get("outcome")
        if role not in ("routing", "answer") or selected is None or outcome not in ("ok", "error"):
            return None
        record.update(call_role=role, selected_model_sha256=selected, outcome=outcome)
    else:
        if getattr(event, "data_schema", None) != {
            "name": "nemo.relay.metric_measurements", "version": "1"
        }:
            return None
        measurements = data.get("measurements")
        if type(measurements) is not list or not 0 < len(measurements) <= 64:
            return None
        projected = []
        for measurement in measurements:
            if type(measurement) is not dict or measurement.get("name") != TOKENS:
                return None
            attributes = measurement.get("attributes")
            if type(attributes) is not dict:
                return None
            role = attributes.get("call_role")
            allowed = models[:1] if role == "routing" else models[1:]
            selected = _model(attributes.get("target_model"), allowed)
            token_type = attributes.get("token_type")
            value = measurement.get("value")
            if (role not in ("routing", "answer") or selected is None
                    or token_type not in ("input", "output", "total") or not _count(value)):
                return None
            projected.append({"call_role": role, "target_model_sha256": selected,
                              "token_type": token_type, "value": value})
        record["measurements"] = projected
    return record


class Observer:
    """Bound output per gateway process; incomplete capture is explicit."""

    def __init__(self, models, emit, limit=4096):
        self.models = models
        self.emit = emit
        self.limit = limit
        self.count = 0
        self.stopped = False
        self.lock = threading.Lock()

    def __call__(self, event):
        with self.lock:
            if self.stopped:
                return
            try:
                record = project(event, self.models)
                if record is None:
                    return
                if self.count >= self.limit:
                    record = {"schema": 1, "kind": "truncated"}
                    self.stopped = True
                self.count += 1
                record.update(pid=os.getpid(), sequence=self.count)
                self.emit(json.dumps(record, separators=(",", ":"), allow_nan=False))
            except Exception:
                # Do not log exception text or the native event on this boundary.
                self.stopped = True
                self.emit('{"schema":1,"kind":"capture_failed"}')

    def stop(self):
        with self.lock:
            self.stopped = True


def _load_helper(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install(ctx):
    """Observe the existing process without initializing a second Relay runtime."""
    expected = os.environ.get("NEMOCLAW_HERMES_SWITCHYARD_SHA256", "")
    if not expected:
        return False
    logger = logging.getLogger("gateway.nemoclaw_switchyard")
    try:
        if re.fullmatch(r"[a-f0-9]{64}", expected) is None:
            raise ValueError("invalid routing identity")
        # Reuse the protected-read and role-resolution owners; never load a
        # user-selected Python module or relax immutable routing configuration.
        preflight = _load_helper(
            "nemoclaw_switchyard_event_preflight",
            "/opt/nemoclaw-hermes-config/switchyard-preflight.py",
        )
        files = preflight.read_installed()
        if preflight.fingerprint(files) != expected:
            raise ValueError("routing identity changed")
        qualifier = _load_helper(
            "nemoclaw_switchyard_event_roles",
            "/opt/nemoclaw-hermes-config/qualify-switchyard-judge.py",
        )
        models = qualifier.selected_models(tomllib.loads(files["switchyardDeploymentToml"]))
        import nemo_relay

        observer = Observer(models, lambda line: logger.info("[switchyard-evidence] %s", line))
        name = "nemoclaw.switchyard.evidence"
        nemo_relay.subscribers.register(name, observer)

        def cleanup():
            observer.stop()
            nemo_relay.subscribers.deregister(name)

        try:
            ctx.on_unload(cleanup)
        except Exception:
            cleanup()
            raise
    except Exception:
        logger.warning("[switchyard-evidence] capture unavailable; routing evidence is incomplete")
        return False
    return True
