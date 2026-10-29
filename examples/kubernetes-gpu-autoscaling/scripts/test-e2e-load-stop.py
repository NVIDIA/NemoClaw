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
assert mod.hpa_effective_replicas(0, 0) == 0
assert mod.hpa_stop_new_chats_at(8) == 8
assert mod.hpa_should_stop_new_chats(0, 0, 8) is False
assert mod.hpa_should_stop_new_chats(6, 6, 8) is False
assert mod.hpa_should_stop_new_chats(7, 7, 8) is False
assert mod.hpa_should_stop_new_chats(7, 8, 8) is True
assert mod.hpa_should_stop_new_chats(8, 8, 8) is True
assert mod.hpa_replicas_back_to_one(0, 0) is False
assert mod.hpa_replicas_back_to_one(1, 1) is True
assert mod.hpa_replicas_back_to_one(2, 1) is False
assert mod.endpoint_for_user([{"user_id": 0, "url": "http://u0"}], 0)["url"] == "http://u0"

hold = mod.should_stop_after_hold
stop_now, since = hold(False, 60, None, 10.0)
assert stop_now is False
assert since is None
stop_now, since = hold(True, 60, None, 10.0)
assert stop_now is False
assert since == 10.0
stop_now, _since = hold(True, 60, 10.0, 69.9)
assert stop_now is False
stop_now, _since = hold(True, 60, 10.0, 70.0)
assert stop_now is True
stop_now, _since = hold(True, 0, None, 10.0)
assert stop_now is True

import os
import subprocess
import sys

missing_host_env = os.environ.copy()
missing_host_env.pop("E2E_CLIENT_HOST", None)
missing_host_env.pop("E2E_ENDPOINTS", None)
missing_host = subprocess.run(
    [sys.executable, str(SCRIPT), "--users", "1", "--output", "/tmp/e2e-openclaw-host-required"],
    check=False,
    capture_output=True,
    text=True,
    env=missing_host_env,
)
assert missing_host.returncode == 2, missing_host.stderr
assert "in-sandbox load helpers" in missing_host.stderr
assert "KILL_OPENCLAW_EXEC" in mod.KILL_SANDBOX_HELPERS
assert "[e]2e-openclaw-load" in mod.KILL_SANDBOX_HELPERS
assert 'or "nemoclaw-start" in cmd' in mod.KILL_SANDBOX_HELPERS
assert "INTERRUPT_OPENCLAW_INFLIGHT" not in SCRIPT.read_text()
assert "interrupt_openclaw_inflight" not in SCRIPT.read_text()
assert "[o]penclaw gateway run" not in SCRIPT.read_text()
source = inspect.getsource(mod.stop_sandbox_chats)
assert "kill_sandbox_load_helpers" in source
assert "interrupt_openclaw_inflight" not in source
start_source = inspect.getsource(mod.run_test)
assert "kill_sandbox_load_helpers" in start_source
assert "interrupt_openclaw_inflight" not in start_source
assert "prune_stale_openclaw_sessions" not in start_source
assert "publish_ramp_to_sandboxes" not in start_source
assert "e2e_latency_load_ramp" not in SCRIPT.read_text()
assert 'item.get("user_id") or -1' not in SCRIPT.read_text()
assert "if args.chat_only or bool(endpoints):" not in SCRIPT.read_text()
assert "check_listeners=not args.chat_only," in SCRIPT.read_text()
assert "if args.chat_only:" in SCRIPT.read_text()
assert "clear_ramp_from_sandboxes" not in SCRIPT.read_text()
assert "Each user sends chats to that user's sandbox." not in start_source
# Start must not restart the gateway (that races the max_tokens pin).
start_only = start_source.split("print(\"=\" * 70)", 1)[0]
assert "setup-openclaw-ollama-e2e-sandboxes.sh" not in start_only
try:
    asyncio.run(mod.simulate_user())
except RuntimeError as exc:
    assert "does not copy load helpers" in str(exc)
else:
    raise AssertionError("simulate_user must not copy e2e-openclaw-load into sandboxes")
chart = Path(__file__).resolve().parent.parent
helper = (chart / "files" / "openclaw-e2e-ws-prompt.py").read_text()
assert 'os.environ.get("E2E_DRAIN_SEC")' in helper
assert 'os.environ.get("E2E_PROMPT_TIMEOUT_SEC")' in helper
assert 'os.environ.get("E2E_DRAIN_SEC", "0")' not in helper
assert 'os.environ.get("E2E_DRAIN_SEC", "8")' not in helper
assert "return 2, 0" in helper
assert 'event_payload.get("state") == "final"' in helper
assert "if answer and send_id and send_id not in pending:" not in helper
assert "E2E_CHATS_PER_USER" not in helper
assert "CHATS" not in helper.split("MAX_TOKENS")[0]
assert '"maxTokens": _max_tokens()' not in helper
assert 'send_params["maxTokens"]' not in helper
assert "pause = 0.0" in helper
assert "def _max_tokens()" in helper
assert "Do not use tools." in helper
assert 'f"{session_base}:w{wid}"' in helper
assert ":t{turn}" not in helper
assert '"sessions.delete"' in helper
assert "_read_latency_ramp" not in helper
assert "E2E_LATENCY_RAMP" not in helper
assert "def _replica_count()" in helper
assert "_replica_count() >= 6" in helper
assert "def _latency_metric()" in helper
assert "_latency_metric() and _replica_count() >= 6" in helper
assert "pin_short_max_tokens_for_demo" not in SCRIPT.read_text()
assert "hpa_common_set_dcgm_peak_window 15" in SCRIPT.read_text()
pin_src = (chart / "files" / "pin-openclaw-ollama-model.py").read_text()
assert '"write"' in pin_src
assert '"read"' in pin_src
assert '"edit"' in pin_src
assert '"agents" / "main" / "sessions"' in pin_src
assert "import shutil" in pin_src
assert 'maint["maxEntries"] = 100000' in pin_src
assert 'maint["mode"] = "warn"' in pin_src
assert 'tools["profile"] = "minimal"' in pin_src
agent_common = (chart / "scripts" / "agent-common.sh").read_text()
assert "PIN_RESET_SESSIONS" not in agent_common
assert "agent_common_repin_openclaw_max_tokens" not in agent_common
assert '"write"' in agent_common
assert 'maint["maxEntries"] = 100000' in agent_common
assert "openclaw) raw=2048" in agent_common
assert 'openclaw) echo "onprem-openclaw"' in agent_common
uninstall = (chart / "scripts" / "uninstall-e2e.sh").read_text()
assert "onprem-openclaw" in uninstall
assert "onprem-ollama" not in uninstall
hermes_setup = (chart / "scripts" / "setup-hermes-vllm-e2e-sandboxes.sh").read_text()
assert "prepare_hermes_sandbox_home" in hermes_setup
assert 'os.chmod("/sandbox", 0o755)' in hermes_setup
assert 'os.chown("/sandbox/.nemoclaw", 0, 0)' in hermes_setup or 'os.chown(home, 0, 0)' in hermes_setup
assert 'os.chmod(home, 0o755)' in hermes_setup
assert "503 gateway_draining" in hermes_setup
assert 'os.chmod("/sandbox/.hermes", 0o700)' in hermes_setup
assert "start exited early (attempt" in hermes_setup
assert "agent_common_pin_hermes_model" not in hermes_setup
hermes_load = (chart / "scripts" / "e2e-hermes-load-test.py").read_text()
assert '"-m"' in hermes_load
assert "inference_model()" in hermes_load
assert 'raw="${E2E_LATENCY_TOKEN_START:-2048}"' in agent_common
assert 'raw="${E2E_HERMES_LATENCY_TOKEN_START:-2048}"' in agent_common
assert 'raw="${E2E_DEEPAGENTS_LATENCY_TOKEN_START:-1024}"' in agent_common
assert "*latency*)" in agent_common
assert "INFLIGHT=1" in agent_common.split("agent_common_export_demo_workload")[1].split("agent_common_export_client_inflight")[0]
assert 'INFLIGHT="${E2E_HERMES_LATENCY_INFLIGHT:-1}"' in agent_common
assert 'INFLIGHT="${E2E_DEEPAGENTS_LATENCY_INFLIGHT:-1}"' in agent_common
assert "agent_common_export_demo_workload deepagents" in (chart / "scripts" / "client_deepagents.sh").read_text()
assert "Leftover MAX_TOKENS from GPU util must not change the latency demo." in agent_common
assert "agent_common_export_demo_workload hermes" in (chart / "scripts" / "client_hermes.sh").read_text()
discovery = (chart / "files" / "e2e-http-discovery.py").read_text()
assert 'E2E_PUBLISH_BIND' in discovery
assert 'return "127.0.0.1"' in discovery
assert 'ThreadingHTTPServer(("0.0.0.0"' not in discovery
shortcut = (chart / "files" / "e2e-openclaw-ui-shortcut.py").read_text()
assert 'E2E_PUBLISH_BIND' in shortcut
assert 'sock.bind(("0.0.0.0"' not in shortcut
forward = (chart / "scripts" / "remote-http-clients.sh").read_text()
hermes_ui_proxy = (chart / "files" / "e2e-hermes-ui-host-proxy.py").read_text()
assert "rewrite_host_header" in hermes_ui_proxy
assert 'sock.bind(("0.0.0.0"' not in hermes_ui_proxy
assert "remote_http_start_hermes_ui_proxy" in forward
assert "remote_http_start_hermes_api_proxy" in forward
assert "remote_http_prepare_hermes_home" in forward
assert "os.chown(home, 0, 0)" in forward
assert "E2E_HERMES_API_KEY_FILE" in forward
assert "inner_api=$((28642 + i))" in forward
assert "remote_http_stop_ports_for_count" in forward
assert "seq 18789 18799" not in forward
assert "seq 8642 8652" not in forward
assert 'remote_http_start_forward "${name}" 18789 "${inner}"' in forward.split("remote_http_publish_hermes")[1]
assert "Laptop HTTP does not set a Bearer token." in forward
hermes_api_proxy = (chart / "files" / "e2e-hermes-api-auth-proxy.py").read_text()
assert "E2E_HERMES_API_KEY_FILE" in hermes_api_proxy
assert "inject_authorization" in hermes_api_proxy
assert "sys.argv[4]" not in hermes_api_proxy
ha_spec = importlib.util.spec_from_file_location(
    "e2e_hermes_api_auth_proxy", chart / "files" / "e2e-hermes-api-auth-proxy.py"
)
assert ha_spec and ha_spec.loader
ha = importlib.util.module_from_spec(ha_spec)
ha_spec.loader.exec_module(ha)
injected = ha.inject_authorization(
    b"POST /v1/chat/completions HTTP/1.1\r\nHost: 10.184.164.109:8642\r\n\r\n",
    "SECRET",
)
assert b"Authorization: Bearer SECRET" in injected
assert b"Host: 10.184.164.109:8642" in injected
hp_spec = importlib.util.spec_from_file_location(
    "e2e_hermes_ui_host_proxy", chart / "files" / "e2e-hermes-ui-host-proxy.py"
)
assert hp_spec and hp_spec.loader
hp = importlib.util.module_from_spec(hp_spec)
hp_spec.loader.exec_module(hp)
rewritten = hp.rewrite_host_header(
    b"GET / HTTP/1.1\r\nHost: 10.184.164.109:18789\r\nAccept: text/html",
    b"127.0.0.1:18789",
)
assert b"Host: 127.0.0.1:18789" in rewritten
assert b"10.184.164.109" not in rewritten
assert "relay_requests" in hermes_api_proxy
assert "relay_requests" in hermes_ui_proxy
relay_spec = importlib.util.spec_from_file_location(
    "e2e_http_header_relay", chart / "files" / "e2e_http_header_relay.py"
)
assert relay_spec and relay_spec.loader
relay = importlib.util.module_from_spec(relay_spec)
relay_spec.loader.exec_module(relay)


class _Chunks:
    def __init__(self, parts: list[bytes]) -> None:
        self.parts = list(parts)
        self.sent = bytearray()

    def recv(self, _n: int) -> bytes:
        if not self.parts:
            return b""
        part = self.parts.pop(0)
        return part

    def sendall(self, data: bytes) -> None:
        self.sent.extend(data)


def _auth(head: bytes) -> bytes:
    return ha.inject_authorization(head, "SECRET")


def _host(head: bytes) -> bytes:
    return hp.rewrite_host_header(head, b"127.0.0.1:18789")


# First header is split across reads. The second request follows on the same socket.
_auth_stream = (
    b"POST /v1/chat/completions HTTP/1.1\r\nHos",
    b"t: 10.184.164.109:8642\r\nContent-Length: 2\r\n\r\nab",
    b"POST /v1/chat/completions HTTP/1.1\r\nHost: 10.184.164.109:8642\r\nContent-Length: 1\r\n\r\nz",
)
_auth_out = _Chunks([])
relay.relay_requests(_Chunks(list(_auth_stream)), _auth_out, _auth)
assert _auth_out.sent.count(b"Authorization: Bearer SECRET") == 2
assert _auth_out.sent.count(b"POST /v1/chat/completions") == 2
_host_stream = (
    b"GET / HTTP/1.1\r\nHost: 10.184.",
    b"164.109:18789\r\n\r\nGET /assets/app.js HTTP/1.1\r\nHost: 10.184.164.109:18789\r\n\r\n",
)
_host_out = _Chunks([])
relay.relay_requests(_Chunks(list(_host_stream)), _host_out, _host)
assert _host_out.sent.count(b"Host: 127.0.0.1:18789") == 2
assert b"10.184.164.109" not in _host_out.sent
_chunked = _Chunks(
    [
        b"POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"2\r\nab\r\n0\r\n\r\n"
        b"GET /next HTTP/1.1\r\nHost: h\r\n\r\n"
    ]
)
_chunked_out = _Chunks([])
relay.relay_requests(_chunked, _chunked_out, _auth)
assert _chunked_out.sent.count(b"Authorization: Bearer SECRET") == 2
assert b"\r\n2\r\nab\r\n0\r\n\r\n" in _chunked_out.sent
# After an Upgrade request the stream is WebSocket frames, not HTTP. Copy it unchanged.
_ws = _Chunks(
    [
        b"GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n\x81\x05hello",
        b"\x81\x03abc",
    ]
)
_ws_out = _Chunks([])
relay.relay_requests(_ws, _ws_out, _host)
assert _ws_out.sent.count(b"Host: 127.0.0.1:18789") == 1
assert _ws_out.sent.endswith(b"\r\n\r\n\x81\x05hello\x81\x03abc")
_partial = _Chunks([b"GET / HTTP/1.1\r\nHost: h\r\n"])
_partial_out = _Chunks([])
relay.relay_requests(_partial, _partial_out, _host)
assert _partial_out.sent == b""
assert "E2E_PUBLISH_BIND:-127.0.0.1" in forward
assert 'E2E_PUBLISH_BIND:-0.0.0.0' not in forward
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
assert sc._is_websocket_upgrade(
    b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\r\n"
)
assert not sc._is_websocket_upgrade(
    b"GET /assets/app.js HTTP/1.1\r\nHost: x\r\n\r\n"
)
dash = (chart / "scripts" / "openclaw-dashboard-url.sh").read_text()
assert "#token=" not in dash
client = (chart / "scripts" / "client.sh").read_text()
assert "trap '_client_finish' EXIT" in client
assert 'exit "${load_rc}"' in client
hermes = (chart / "scripts" / "client_hermes.sh").read_text()
assert 'headers["Authorization"] = f"Bearer {token}"' in hermes
assert "export E2E_OUTPUT_DIR" in hermes
assert "export E2E_OUTPUT_DIR" in client
deep = (chart / "scripts" / "client_deepagents.sh").read_text()
assert "agent_common_print_laptop_client_usage" not in deep
assert "Deep Agents has no laptop HTTP" in deep
assert "export E2E_OUTPUT_DIR" in deep
assert 'E2E_CLIENT_HOST:-' in deep
common = (chart / "scripts" / "agent-common.sh").read_text()
assert "client_deepagents.sh)" in common
assert 'script="$(basename "${0}")"' in common
assert "hermes vllm nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8" in common
assert "deepagents nim nvidia/nemotron-3-nano" in common
readme = (chart / "README.md").read_text()
assert "`secrets.env` is gitignored." in readme
assert "Keep [step 5](#5-connect-the-openshell-cli) in another terminal:" not in readme
assert "Keep this attached for step 6." in readme
publish_hermes = (chart / "scripts" / "publish-hermes-remote-http.sh").read_text()
publish_openclaw = (chart / "scripts" / "publish-openclaw-remote-http.sh").read_text()
assert "remote_http_publish_hermes" in publish_hermes
assert "Does not print API keys." in publish_hermes
assert 'E2E_PUBLISH_BIND:-0.0.0.0' in publish_hermes
assert 'E2E_PUBLISH_BIND:-0.0.0.0' in publish_openclaw
assert "publish-hermes-remote-http.sh" in readme
assert "The laptop does not set a Hermes API key." in readme
assert "broken pipe" in readme
assert "not a failed OpenShell tunnel" in readme
forward_sh = (chart / "scripts" / "openshell-port-forward.sh").read_text()
assert "kubectl may print broken pipe" in forward_sh
assert "Git has `secrets.env.example` only." in readme
assert "The default vLLM NGC image and Hugging Face model are public, so no extra Secret is required." in readme
assert "https://catalog.ngc.nvidia.com/orgs/nvidia/-/containers/vllm/" in readme
assert "Public vLLM (6b) needs no NGC key." in readme
assert "https://org.ngc.nvidia.com/account/api-keys" in readme
assert "https://org.ngc.nvidia.com" in readme
assert "Skip `apply-local-secrets.sh` only when **both** Secrets exist" in readme
assert "**both** Secrets from one `NGC_API_KEY`" in readme
assert "kubelet uses `ngc-registry`" in readme
assert "the running NIM uses `nim-ngc-key`" in readme
assert "./scripts/apply-local-secrets.sh --replace" in readme
apply_secrets = (chart / "scripts" / "apply-local-secrets.sh").read_text()
assert "vLLM only uses ngc-registry" not in apply_secrets
assert "vLLM image pull: VLLM_IMAGE_PULL_SECRET=ngc-registry" not in apply_secrets
assert "Public vLLM (6b) does not use these Secrets." in apply_secrets
assert "NIM Secrets: NIM_IMAGE_PULL_SECRET=ngc-registry" in apply_secrets
local_ex = (chart / "local.env.example").read_text()
assert "kubelet still needs ngc-registry" not in local_ex
assert "Public vLLM (6b) needs no NGC Secret." in local_ex
secrets_ex = (chart / "secrets.env.example").read_text()
assert "nvcr.io/nvidia/vllm" not in secrets_ex
assert "Public vLLM (6b) needs neither Secret." in secrets_ex
assert "https://org.ngc.nvidia.com/account/api-keys" in secrets_ex
assert secrets_ex.split("NGC_API_KEY=", 1)[1].splitlines()[0] == ""
assert "paste NGC_API_KEY=nvapi-" not in readme
assert "Paste the nvapi- key" not in apply_secrets
assert "one OpenClaw agent per sandbox" in readme
assert "### Disk (already under Persistence)" not in readme
assert "### Aggregated metrics API" not in readme
assert "\n## Simple HPA-only test\n" in readme
assert "Simple HPA only test" not in readme
assert "DCGM_NAMESPACE=gpu-operator-resources MAX_REPLICAS=8" in readme
assert "It is a one-shot through the in-sandbox" in readme
assert "#token=" in readme and "with no `#token=`" in readme
assert "Keep `./scripts/run-agent-sandbox.sh` attached so `:18789` is up." not in readme
assert "Keep `./scripts/openshell-port-forward.sh` attached so `openshell status` succeeds." in readme
assert "It does **not** set a 10% threshold" not in readme
assert "ceiling to 2 desired replicas" not in readme
assert "ceil(1 × 3706/3000) = ceil(1.235) = 2" in readme
assert "That script binds `0.0.0.0` and serves the page over plain HTTP." in readme
_remote_ui = readme.find("**Remote UI test**")
_plain_http = readme.find("That script binds `0.0.0.0` and serves the page over plain HTTP.")
_url_table = readme.find("| User | Open this in a browser on the remote machine |")
assert -1 not in (_remote_ui, _plain_http, _url_table)
assert _remote_ui < _plain_http < _url_table
assert "hermes nim nvidia/nemotron-3-nano" not in common
assert 'E2E_CLIENT_HOST' in common
dgx = (chart / "scripts" / "hpa-load-test-dgx-8xh100.sh").read_text()
assert "ingress.auth.password" in dgx
assert "--force-conflicts" not in dgx
assert "hpa_common_append_helm_force_conflicts HPA_HELM_ARGS" in dgx
assert "hpa_common_append_helm_force_conflicts HPA_RESTORE_HELM_ARGS" in dgx
for _reuse_name in (
    "agentscaling-common.sh",
    "agentscaling-hermes-common.sh",
    "agentscaling-deepagents-common.sh",
):
    _reuse = (chart / "scripts" / _reuse_name).read_text()
    assert "hpa_common_live_inference_model" in _reuse
    assert '"${current_model}" == "${INFERENCE_MODEL}"' in _reuse
    assert (
        '"${current_runtime}" == "${INFERENCE_RUNTIME}" && "${current_mode}" == "${wanted}"'
        not in _reuse
    )
adapter = (chart / "monitoring" / "prometheus-adapter-gpu-values.yaml").read_text()
assert "[90s]" in adapter
assert "client.sh shortens this to 15s" in adapter
assert "stabilizationWindowSeconds=120" not in (chart / "scripts" / "hpa-common.sh").read_text()
hpa_common = (chart / "scripts" / "hpa-common.sh").read_text()
assert "hpa_common_append_helm_force_conflicts" in hpa_common
assert "Helm 3 remains supported" in hpa_common
upgrade = hpa_common.split("hpa_common_gpu_helm_upgrade()", 1)[1].split(
    "\nhpa_common_cleanup_load_test_resources()", 1
)[0]
assert upgrade.index("hpa_common_append_helm_force_conflicts helm_args") < upgrade.index(
    "kubectl delete hpa"
)
assert upgrade.index("kubectl delete hpa") < upgrade.index('helm "${helm_args[@]}"')
assert "hpa_common_legacy_agent_basename" not in hpa_common
assert "hpa_common_list_legacy_agent_deployments" not in hpa_common
assert "hpa_common_migrate_legacy_agent_resources" not in hpa_common
assert "hpa_common_gpu_recreate_stale_workload" not in hpa_common
assert "hpa_common_hpa_metric_display" not in hpa_common
assert "hpa_common_print_hpa_status" not in hpa_common
assert "hpa_common_migrate_pre_metrics_proxy_resources" in hpa_common
assert "finish_one_agent" not in (
    chart / "scripts" / "setup-openclaw-ollama-e2e-sandboxes.sh"
).read_text()
assert "./scripts/apply-local-secrets.sh --replace" in hpa_common
assert "Public vLLM (6b) does not create ngc-registry." in hpa_common
assert 'if [[ "${inference_runtime}" == "nim" ]]; then' in hpa_common
assert 'if [[ "${inference_runtime}" == "vllm" ]]; then' in hpa_common
assert "hpa_common_resolve_allow_insecure_http" not in hpa_common
assert "hpa_common_verify_insecure_ingress_isolation" not in hpa_common
assert "ingress.allowInsecureHttp" not in hpa_common
assert "ALLOW_INSECURE_HTTP" not in readme
assert "allowInsecureHttp" not in (chart / "values.yaml").read_text()
assert "tls: []" not in (chart / "values.yaml").read_text()
assert "TLS required by default" not in readme
assert "### TLS values" not in readme
assert "This recipe does not use Envoy TLS." not in readme
assert "copy the OpenShell gateway client certs" in readme
assert "`ALLOW_UNAUTHENTICATED_OPENSHELL=1` turns off OIDC" in readme
assert "dedicated evaluation cluster" in readme
assert "ClusterIP does not block in-cluster pods." in readme
assert "OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only" in readme
assert "not for Envoy" not in readme
assert "openshell-client-tls" in readme
assert "| Envoy load balancer | **443**" not in readme
gw = (chart / "templates" / "gateway.yaml").read_text()
assert "protocol: HTTPS" not in gw
assert "allowInsecureHttp" not in gw
assert "TLS is required when ENABLE_ENVOY_LB=1" not in (
    chart / "scripts" / "install-hpa.sh"
).read_text()
assert "ALLOW_INSECURE_HTTP" not in (chart / "scripts" / "agentscaling-common.sh").read_text()
assert "ALLOW_INSECURE_HTTP" not in (chart / "scripts" / "agentscaling-hermes-common.sh").read_text()
assert "ALLOW_INSECURE_HTTP" not in (chart / "scripts" / "agentscaling-deepagents-common.sh").read_text()
assert "ingress.allowInsecureHttp" not in dgx
assert "ingress.allowInsecureHttp" not in (chart / "scripts" / "hpa-load-test-brev-4xl40s.sh").read_text()
for name, main_fn in (
    ("agentscaling-common.sh", "agentscaling_common_main()"),
    ("agentscaling-hermes-common.sh", "agentscaling_hermes_common_main()"),
    ("agentscaling-deepagents-common.sh", "agentscaling_deepagents_common_main()"),
):
    main = (chart / "scripts" / name).read_text().split(main_fn, 1)[1]
    before, after = main.split('case "${cmd}" in', 1)
    assert "hpa_common_verify_target_node" not in before, name
    assert "hpa_common_verify_target_node" in after, name
deep_common = (chart / "scripts" / "agentscaling-deepagents-common.sh").read_text()
pin = deep_common.split("agentscaling_deepagents_common_pin()")[1].split(
    "agentscaling_deepagents_common_main()"
)[0]
assert "hpa_common_require_nim_credentials" not in pin
assert "hpa_common_require_nim_credentials" in deep_common.split(
    "agentscaling_deepagents_common_main()"
)[1]
hold_disp = hpa_common.split("def hold_display_current")[1].split("def gpu_display_current")[0]
assert "if pods:" in hold_disp
assert "age > 45" not in hold_disp
assert "int(replicas) > 1" not in hold_disp
assert "int(replicas) <= 1" in hold_disp
assert 'hold_display_current("gpu_utilization_percent"' in hpa_common
assert 'hold_display_current("nemoclaw_llm_latency_avg_milliseconds"' in hpa_common
assert "fmt_ms(latency_display_current" in hpa_common
fmt_ms = hpa_common.split("def fmt_ms")[1].split("def fmt_rate")[0]
assert 'return "?"' not in fmt_ms
assert 'return "0"' in fmt_ms
assert "0.0 if value is None else value" in hpa_common
gateway = (chart / "templates" / "gateway.yaml").read_text()
assert "maxRequestsPerConnection: 1" in gateway
assert "hpa_common_set_dcgm_peak_window" in hpa_common
assert "sys.exit(2)" in hpa_common
assert "hpa_common_set_dcgm_peak_window 90" in client
assert "hpa_common_set_dcgm_peak_window 15" in client
assert "Restarting OpenClaw so max_tokens=" not in client
assert "hold_hpa_until_client" not in client
assert "hold_hpa_until_client" not in hermes
assert "hold_hpa_until_client" not in deep
assert "pause_hpa_scale_down" not in hermes
assert "pause_hpa_scale_down" not in deep
assert "kubectl cp" not in hermes_load
assert "e2e-sandbox-saturate" not in hermes_load
assert "e2e-openclaw-load" not in hermes_load
assert "does not copy a load helper into the sandbox" in hermes_load
deep_load = (chart / "scripts" / "e2e-deepagents-load-test.py").read_text()
assert "kubectl cp" not in deep_load
assert "e2e-sandbox-saturate" not in deep_load
assert "e2e-openclaw-load" not in deep_load
assert "does not copy a load helper into the sandbox" in deep_load
assert hermes_load.count("stop_sandbox_chats(") >= 3
assert "[h]ermes.real -m .* -z" in hermes_load
assert "[h]ermes -z'" not in hermes_load
assert deep_load.count("stop_sandbox_chats(") >= 3
assert "`INFLIGHT=1`, `MAX_TOKENS=2048`" in readme
assert "OpenClaw latency defaults:" not in readme
assert "Do not set `INFLIGHT` or `MAX_TOKENS`." not in readme
assert "mean of **completed** samples in the last **30s**" in readme
assert "no new completed sample for 15s" in readme
assert "OpenClaw, Hermes, and Deep Agents share this metric" in readme
assert "That 0 lets HPA scale down. It does not mean chat latency was 0 ms." in readme
assert "Hermes latency is `INFLIGHT=1`, `MAX_TOKENS=2048` in the code" in readme
assert "Do not add those flags." not in readme
assert "INFLIGHT=1 MAX_TOKENS=2048" in hermes
assert "INFLIGHT=2 MAX_TOKENS=1024" in hermes
assert "INFLIGHT=2 MAX_TOKENS=1024" in readme
assert "INFLIGHT=4 MAX_TOKENS=2048" in readme
assert "INFLIGHT=4 MAX_TOKENS=2048" in client
assert "openclaw) INFLIGHT=4 ;;" in agent_common
assert 'export E2E_USERS="${E2E_USERS:-10}"' in hermes
assert 'parser.add_argument("--users", type=int, required=True)' in hermes_load
assert 'parser.add_argument("--users", type=int, required=True)' in SCRIPT.read_text()
assert 'parser.add_argument("--users", type=int, required=True)' in deep_load
assert 'default=int(os.environ.get("E2E_USERS"' not in hermes_load
assert 'default=int(os.environ.get("E2E_USERS"' not in SCRIPT.read_text()
assert 'default=int(os.environ.get("E2E_USERS"' not in deep_load
assert 'export E2E_USERS="${E2E_USERS:-10}"' in (chart / "scripts" / "agentscaling-hermes-common.sh").read_text()
assert 'export E2E_USERS="${E2E_USERS:-10}"' in publish_hermes
assert 'export E2E_USERS="${E2E_USERS:-5}"' in client
assert "10 end users send requests to 10 Hermes agents" in readme
assert "5 end users send requests to 5 OpenClaw agents" in readme
assert "10 end users send requests to 10 Deep Agents" in readme
assert 'export E2E_USERS="${E2E_USERS:-10}"' in (chart / "scripts" / "agentscaling-deepagents-common.sh").read_text()
assert 'export E2E_USERS="${E2E_USERS:-10}"' in deep
assert "`E2E_USERS=10`" in readme
assert "`8642+i`" in readme
assert "`18789+i`" in readme
assert "Last ports are `8642+N-1`" in readme
assert ":8642 … :8646" not in readme
assert "INFLIGHT=1 MAX_TOKENS=1024" in readme
assert "INFLIGHT=1 MAX_TOKENS=1024" in deep
assert "INFLIGHT=1 MAX_TOKENS=1024" not in hermes
assert "INFLIGHT=3 MAX_TOKENS=64" not in readme
assert "**GPU Utilization.** (target 40%). Default is `INFLIGHT=1 MAX_TOKENS=1024`." in readme
assert "**LLM latency.** Same default. `client_deepagents.sh` sends `dcode -n`." in readme
assert "INFLIGHT=1 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client_deepagents.sh" not in readme
assert "INFLIGHT=1 MAX_TOKENS=2048 E2E_USERS=5 ./scripts/client_deepagents.sh" not in readme
assert "E2E_USERS=5 ./scripts/client_deepagents.sh" not in readme
for line in readme.splitlines():
    stripped = line.lstrip()
    if stripped.startswith("#") or not stripped.startswith(
        ("INFLIGHT=", "MAX_TOKENS=", "E2E_USERS=", "E2E_CLIENT_HOST=")
    ):
        continue
    if "client_deepagents.sh" not in stripped:
        continue
    assert "INFLIGHT=" not in stripped, stripped
    assert "MAX_TOKENS=" not in stripped, stripped
assert "deepagents) INFLIGHT=1 ;;" in agent_common
assert "Set those flags on the client." in readme
assert "[user {uid} sandbox {uid}]" in hermes
assert "thread.join(timeout=2)" not in hermes
assert "already-sent chats finished" in hermes
assert "already-sent chats finished" in hermes_load
assert "already-sent chats finished" in deep_load
assert "Do not drain in-flight" not in client
assert 'E2E_DRAIN_SEC:-${E2E_PROMPT_TIMEOUT_SEC' in client
assert "INFLIGHT=${INFLIGHT} MAX_TOKENS=${MAX_TOKENS}" in agent_common
assert "Restarting idle OpenClaw" not in client
assert "MAX_REPLICAS_HOLD_SEC:-0" in client
assert "E2E_CHAT_PAUSE_SEC:-0" in client
assert "agent_common_export_demo_workload" in client
assert '--scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"' in client
assert "--scale-down-wait-loops 0" not in client
assert "Successful chats = chats that got a reply" in SCRIPT.read_text()
assert "resume_hpa_scale_down_for_demo" in SCRIPT.read_text()
assert "wait_sec=float(timeout_sec) + 5.0" not in SCRIPT.read_text()
assert "join_deadline = time.monotonic() + max(0.0, drain)" in helper
assert "max(timeout, drain)" not in helper
assert 'stabilizationWindowSeconds","value":0' in hpa_common.replace(" ", "")
assert "--chats" not in client
assert "E2E_CHATS_PER_USER" not in client
assert "E2E_CHATS_PER_USER" not in common
assert "E2E_USER_STAGGER_SEC:-0" in client
assert "*latency*" in client
assert '"maxReplicas":1' not in client.split("_client_finish")[1].split("trap ")[0]
finish = client.split("_client_finish")[1].split("trap ")[0]
assert "setup-openclaw-ollama-e2e-sandboxes.sh\" stop" not in finish
assert "SKIP_WAIT_INFERENCE_LOCAL=1" not in finish
assert "uninstall-e2e.sh" in client
assert "SKIP_WAIT_INFERENCE_LOCAL" in (chart / "scripts" / "setup-openclaw-ollama-e2e-sandboxes.sh").read_text()
for name, text in (
    ("client.sh", client),
    ("client_hermes.sh", hermes),
    ("client_deepagents.sh", deep),
):
    assert "e2e-sandboxes.sh" not in text, name
    assert "Restarting idle" not in text, name
    assert "uninstall-e2e.sh" in text, name
assert 'os.environ.get("INFLIGHT")' in hermes
assert "inflight=inflight" in hermes
assert "MAX_REPLICAS_HOLD_SEC:-0" in hermes
class _DiscoveryResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(
            {
                "users": [
                    {
                        "user_id": 0,
                        "sandbox": "openclaw-ollama-e2e-0000",
                        "ws_host": "10.184.164.109",
                        "ws_port": 18789,
                    }
                ]
            }
        ).encode()


_real_urlopen = mod.urllib.request.urlopen
mod.urllib.request.urlopen = lambda *_args, **_kwargs: _DiscoveryResponse()
try:
    rewritten_users = mod.users_from_http_host("127.0.0.1", 1, 18788)
finally:
    mod.urllib.request.urlopen = _real_urlopen
assert rewritten_users[0]["ws_host"] == "127.0.0.1"
assert rewritten_users[0]["ws_port"] == 18789
assert "10.184.164.109" not in str(rewritten_users[0]["ws_host"])
print("OK: HPA helper reports the 8 GPU target without treating a failed poll as 8")
print("OK: same-DGX OpenClaw client uses --host, not the discovery node IP")
print("OK: OpenClaw client requires --host and does not start in-sandbox helpers")
print("OK: client stop kills leftover helpers and leaves agents running")
print("OK: WS helper counts a reply as ok and a sent chat with no reply as err")
assert "e2e_timeline" in (chart / "scripts" / "e2e-openclaw-ollama-load-test.py").read_text()
assert "client-timeline.jsonl" in (chart / "scripts" / "e2e-openclaw-ollama-load-test.py").read_text()
assert "e2e-hpa-timeline.py" in (chart / "scripts" / "agent-common.sh").read_text()
timeline_src = (chart / "scripts" / "e2e_timeline.py").read_text()
assert "except Exception:" not in timeline_src
assert "except OSError:" in timeline_src
assert 'text[-1] in "kK"' in timeline_src
print("OK: inner forwards bind 127.0.0.1; remote publish binds 0.0.0.0 unless E2E_PUBLISH_BIND is set")
print("OK: published HTTP and argv do not include gateway tokens or API keys")
print("OK: client cleanup, Hermes Bearer, pairings, and Helm restore match review fixes")
