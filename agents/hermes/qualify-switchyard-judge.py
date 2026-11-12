# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Qualify the selected judge through the packaged router before Hermes admits traffic."""

import asyncio
import os
import signal
import stat
import sys
import tomllib
import uuid

PLUGINS_PATH = "/usr/local/share/nemoclaw/hermes-relay-plugins.toml"
DEPLOYMENT_PATH = "/usr/local/share/nemoclaw/hermes-switchyard-v1.toml"
PLUGINS_ENV = "HERMES_NEMO_RELAY_PLUGINS_TOML"
SUBSCRIBER = "nemoclaw-switchyard-judge-preflight"


def read_configuration(path):
    """Read one bounded root-owned routing file without following a final symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0
                or before.st_mode & 0o022 or before.st_nlink != 1
                or not 0 < before.st_size <= 65536):
            raise ValueError("untrusted routing configuration")
        data = os.read(fd, before.st_size + 1)
        after = os.fstat(fd)
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("routing configuration changed")
        if len(data) != before.st_size:
            raise ValueError("incomplete routing configuration")
        return tomllib.loads(data.decode("utf-8"))
    finally:
        os.close(fd)


def selected_models(deployment):
    """Resolve the judge and answer models from the installed deployment."""
    route = deployment["routes"]["switchyard"]
    if route["type"] != "llm_classifier" or route["mode"] != "capability":
        raise ValueError("unsupported classifier")
    if route["classifier_target"] not in ("capable", "judge"):
        raise ValueError("unidentified judge")
    if route["weak_target"] != "efficient" or route["strong_target"] != "capable":
        raise ValueError("unidentified target roles")
    roles = [route["classifier_target"], route["weak_target"], route["strong_target"]]
    models = []
    for role in roles:
        target = deployment["targets"][role]
        client = deployment["llm_clients"][target["llm_client"]]
        if client.get("forward_auth") is not False or not client.get("api_key_env"):
            raise ValueError("unscoped client authentication")
        models.append(target["id"])
    return tuple(models)


def verify_evidence(events, models):
    """Reject fail-open answers, missing judge evidence, and unaccounted model calls."""
    judge, efficient, capable = models
    decisions = [event["data"] for event in events
                 if event["name"] == "switchyard.routing.decision"]
    if len(decisions) != 1 or decisions[0].get("evidence", {}).get("source") != "llm-classifier":
        raise ValueError("judge did not produce a usable classification")
    selected = decisions[0].get("selected_model")
    if selected not in (efficient, capable):
        raise ValueError("unidentified answer model")
    calls = [event["data"] for event in events
             if event["name"] == "switchyard.routing.llm_call"]
    for role, model in (("routing", judge), ("answer", selected)):
        matching = [call for call in calls if call.get("call_role") == role]
        if len(matching) != 1 or matching[0].get("selected_model") != model or matching[0].get("outcome") != "ok":
            raise ValueError("model call identity or role is missing")
        accounted = False
        for event in events:
            if event["name"] != "switchyard.routing.llm_tokens":
                continue
            if event.get("data_schema") != {"name": "nemo.relay.metric_measurements", "version": "1"}:
                continue
            for measurement in event["data"].get("measurements", []):
                attributes = measurement.get("attributes", {})
                value = measurement.get("value")
                if (measurement.get("name") == "switchyard.routing.llm_tokens"
                        and attributes.get("call_role") == role
                        and attributes.get("target_model") == model
                        and attributes.get("token_type") in ("input", "output", "total")
                        and type(value) is int and value >= 0):
                    accounted = True
        if not accounted:
            raise ValueError("model usage is not separately accounted")


def qualify(models, *, relay, runtime_factory, timeout_seconds=40):
    """Use the native Relay intercept and keep probe payloads and credentials out of output."""
    events = []
    overflow = False

    def observe(event):
        nonlocal overflow
        if event.kind != "mark" or event.name not in (
                "switchyard.routing.decision", "switchyard.routing.llm_call",
                "switchyard.routing.llm_tokens"):
            return
        if len(events) >= 64:
            overflow = True
            return
        events.append({"name": event.name, "data": event.data, "data_schema": event.data_schema})

    async def reject_passthrough(_request):
        raise ValueError("native routing was bypassed")

    async def probe():
        await asyncio.wait_for(
            relay.llm.execute(
                "openai.chat_completions",
                relay.LLMRequest({"x-switchyard-session-id": str(uuid.uuid4())}, {
                    "model": "switchyard",
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                    "max_completion_tokens": 8,
                }),
                reject_passthrough,
            ),
            timeout=timeout_seconds,
        )

    previous = os.environ.get(PLUGINS_ENV)
    runtime = None
    registered = False
    os.environ[PLUGINS_ENV] = PLUGINS_PATH
    try:
        relay.subscribers.register(SUBSCRIBER, observe)
        registered = True
        runtime = runtime_factory()
        if not runtime.managed_execution_enabled():
            raise ValueError("native routing is unavailable")
        asyncio.run(probe())
        relay.subscribers.flush()
        if overflow:
            raise ValueError("ambiguous routing evidence")
        verify_evidence(events, models)
    finally:
        try:
            if runtime is not None:
                runtime.shutdown()
        finally:
            try:
                if registered:
                    relay.subscribers.flush()
            finally:
                try:
                    if registered:
                        relay.subscribers.deregister(SUBSCRIBER)
                finally:
                    if previous is None:
                        os.environ.pop(PLUGINS_ENV, None)
                    else:
                        os.environ[PLUGINS_ENV] = previous


def main():
    """Bound this process independently of asynchronous cancellation and native shutdown."""
    signal.alarm(45)
    try:
        plugins = read_configuration(PLUGINS_PATH)
        dynamic = plugins["plugins"]["dynamic"]
        if len(dynamic) != 1 or dynamic[0]["config"]["switchyard_config_path"] != DEPLOYMENT_PATH:
            raise ValueError("ambiguous native plugin configuration")
        models = selected_models(read_configuration(DEPLOYMENT_PATH))
        import nemo_relay
        from agent import relay_runtime
        qualify(models, relay=nemo_relay, runtime_factory=relay_runtime.RelayRuntime)
        return 0
    except Exception:
        # Neither upstream errors nor model output are safe startup diagnostics.
        print("Switchyard judge qualification failed; routing was not started.", file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
