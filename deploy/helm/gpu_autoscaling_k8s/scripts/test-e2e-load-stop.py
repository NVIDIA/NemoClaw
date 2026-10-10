#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: HPA helper reports 8 GPUs; 0/0 polls are not treated as 8."""

from __future__ import annotations

import importlib.util
import asyncio
import inspect
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "e2e-openclaw-ollama-load-test.py"
spec = importlib.util.spec_from_file_location("e2e_openclaw_ollama_load_test", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
reached = mod.hpa_replicas_reached_target

assert reached(0, 0, 8) is False, "failed HPA poll must not look like 8 GPUs"
assert reached(1, 1, 8) is False
assert reached(7, 7, 8) is False
assert reached(7, 8, 8) is True, "desired 8 is at the demo target"
assert reached(8, 7, 8) is True
assert reached(8, 8, 8) is True
assert reached(2, 3, 8) is False

import subprocess
import sys

missing_host = subprocess.run(
    [sys.executable, str(SCRIPT), "--users", "1", "--output", "/tmp/e2e-openclaw-host-required"],
    check=False,
    capture_output=True,
    text=True,
)
assert missing_host.returncode == 2, missing_host.stderr
assert "in-sandbox load helpers" in missing_host.stderr
assert "KILL_OPENCLAW_EXEC" in mod.KILL_SANDBOX_HELPERS
assert "[e]2e-openclaw-load" in mod.KILL_SANDBOX_HELPERS
assert "KILL_OPENCLAW_EXEC" in mod.INTERRUPT_OPENCLAW_INFLIGHT
assert "[o]penclaw gateway run" in mod.INTERRUPT_OPENCLAW_INFLIGHT
assert 'or "nemoclaw-start" in cmd' in mod.INTERRUPT_OPENCLAW_INFLIGHT
source = inspect.getsource(mod.stop_sandbox_chats)
assert "kill_sandbox_load_helpers" in source
assert "interrupt_openclaw_inflight" in source
start_source = inspect.getsource(mod.run_test)
assert "kill_sandbox_load_helpers" in start_source
assert "interrupt_openclaw_inflight" in start_source
assert "publish_ramp_to_sandboxes" not in start_source
assert "Each user sends chats to that user's sandbox." not in start_source
# Start must not restart the gateway (that races the max_tokens pin).
start_only = start_source.split("print(\"=\" * 70)", 1)[0]
assert "interrupt_openclaw_inflight" not in start_only
try:
    asyncio.run(mod.simulate_user())
except RuntimeError as exc:
    assert "does not copy load helpers" in str(exc)
else:
    raise AssertionError("simulate_user must not copy e2e-openclaw-load into sandboxes")
chart = Path(__file__).resolve().parent.parent
helper = (chart / "files" / "openclaw-e2e-ws-prompt.py").read_text()
assert 'os.environ.get("E2E_DRAIN_SEC", "0")' in helper
assert 'os.environ.get("E2E_DRAIN_SEC", "8")' not in helper
assert 'send_params["maxTokens"]' not in helper
discovery = (chart / "files" / "e2e-http-discovery.py").read_text()
assert 'E2E_PUBLISH_BIND' in discovery
assert 'return "127.0.0.1"' in discovery
assert 'ThreadingHTTPServer(("0.0.0.0"' not in discovery
shortcut = (chart / "files" / "e2e-openclaw-ui-shortcut.py").read_text()
assert 'E2E_PUBLISH_BIND' in shortcut
assert 'sock.bind(("0.0.0.0"' not in shortcut
forward = (chart / "scripts" / "remote-http-clients.sh").read_text()
assert "E2E_PUBLISH_BIND:-127.0.0.1" in forward
assert 'E2E_PUBLISH_BIND:-0.0.0.0' in forward
assert "E2E_OPENCLAW_GATEWAY_TOKEN_FILE" in forward
assert '"token": sys.argv[7]' not in forward
assert "Location: /#token=" not in shortcut
assert "sys.argv[4]" not in shortcut
assert "settimeout(None)" in shortcut
assert "up.join(timeout=120)" not in shortcut
disc_spec = importlib.util.spec_from_file_location(
    "e2e_http_discovery", chart / "files" / "e2e-http-discovery.py"
)
assert disc_spec and disc_spec.loader
disc = importlib.util.module_from_spec(disc_spec)
disc_spec.loader.exec_module(disc)
redacted = disc.redact_secrets(
    {
        "users": [
            {
                "user_id": 0,
                "token": "SECRET",
                "api_key": "SECRET",
                "dashboard_url": "http://127.0.0.1:18789/u/0#token=SECRET",
            }
        ]
    }
)
redacted_text = json.dumps(redacted)
assert "SECRET" not in redacted_text
assert "token" not in redacted_text
sc_spec = importlib.util.spec_from_file_location(
    "e2e_openclaw_ui_shortcut", chart / "files" / "e2e-openclaw-ui-shortcut.py"
)
assert sc_spec and sc_spec.loader
sc = importlib.util.module_from_spec(sc_spec)
sc_spec.loader.exec_module(sc)
injected = sc.inject_connect_token(
    b'{"type":"req","method":"connect","params":{"auth":{"token":""}}}',
    "SECRET",
)
assert b"SECRET" in injected
dash = (chart / "scripts" / "openclaw-dashboard-url.sh").read_text()
assert "#token=" not in dash
client = (chart / "scripts" / "client.sh").read_text()
assert "_client_load_started=1" in client
assert 'exit "${load_rc}"' in client
hermes = (chart / "scripts" / "client_hermes.sh").read_text()
assert 'headers["Authorization"] = f"Bearer {token}"' in hermes
deep = (chart / "scripts" / "client_deepagents.sh").read_text()
assert "agent_common_print_laptop_client_usage" not in deep
common = (chart / "scripts" / "agent-common.sh").read_text()
assert "hermes vllm nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8" in common
assert "deepagents nim nvidia/nemotron-3-nano" in common
readme = (chart / "README.md").read_text()
assert "## Simple HPA-only test (optional)" in readme
assert "[Simple HPA-only test (optional)](#simple-hpa-only-test-optional)" in readme
assert "Simple HPA only test" not in readme
assert "DCGM_NAMESPACE=gpu-operator-resources MAX_REPLICAS=8" in readme
assert "It is a one-shot through the in-sandbox" in readme
assert "#token=" in readme and "with no `#token=`" in readme
assert "hermes nim nvidia/nemotron-3-nano" not in common
assert 'E2E_CLIENT_HOST' in common
dgx = (chart / "scripts" / "hpa-load-test-dgx-8xh100.sh").read_text()
assert "ingress.auth.password" in dgx
assert "--force-conflicts" in dgx
adapter = (chart / "monitoring" / "prometheus-adapter-gpu-values.yaml").read_text()
assert "[90s]" in adapter
assert "client.sh shortens this to 15s" in adapter
assert "stabilizationWindowSeconds=120" not in (chart / "scripts" / "hpa-common.sh").read_text()
hpa_common = (chart / "scripts" / "hpa-common.sh").read_text()
gateway = (chart / "templates" / "gateway.yaml").read_text()
assert "maxRequestsPerConnection: 1" in gateway
assert "hpa_common_set_dcgm_peak_window" in hpa_common
assert "sys.exit(2)" in hpa_common
assert "hpa_common_set_dcgm_peak_window 90" in client
assert "hpa_common_set_dcgm_peak_window 15" in client
assert "Restarting OpenClaw so max_tokens=" in client
assert '"maxReplicas":1' not in client.split("_client_finish")[1].split("trap ")[0]
finish = client.split("_client_finish")[1].split("trap ")[0]
assert "setup-openclaw-ollama-e2e-sandboxes.sh\" stop" in finish
assert "SKIP_WAIT_INFERENCE_LOCAL=1" in finish
assert "SKIP_WAIT_INFERENCE_LOCAL" in (chart / "scripts" / "setup-openclaw-ollama-e2e-sandboxes.sh").read_text()
print("OK: HPA helper reports the 8 GPU target without treating a failed poll as 8")
print("OK: OpenClaw client requires --host and does not start in-sandbox helpers")
print("OK: client stop kills leftover helpers and drops in-flight OpenClaw completions")
print("OK: WS helper does not drain chat.send after SIGTERM")
assert "e2e_timeline" in (chart / "scripts" / "e2e-openclaw-ollama-load-test.py").read_text()
assert "client-timeline.jsonl" in (chart / "scripts" / "e2e-openclaw-ollama-load-test.py").read_text()
assert "e2e-hpa-timeline.py" in (chart / "scripts" / "agent-common.sh").read_text()
print("OK: inner forwards bind 127.0.0.1; remote publish binds 0.0.0.0 unless E2E_PUBLISH_BIND is set")
print("OK: published HTTP and argv do not include gateway tokens or API keys")
print("OK: client cleanup, Hermes Bearer, pairings, and Helm restore match review fixes")
