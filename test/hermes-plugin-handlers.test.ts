// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PLUGIN_PATH = path.join(import.meta.dirname, "..", "agents", "hermes", "plugin", "__init__.py");

function runPython(script: string): string {
  return execFileSync("python3", ["-c", script, PLUGIN_PATH], {
    encoding: "utf-8",
  });
}

describe("Hermes NemoClaw plugin handlers", () => {
  it("accepts Hermes dispatch kwargs for status, info, and reload handlers", () => {
    const output = runPython(`
import importlib.util
import json
import pathlib
import sys
import types

plugin_path = pathlib.Path(sys.argv[1])
yaml_stub = types.ModuleType("yaml")
yaml_stub.safe_load = lambda *_args, **_kwargs: {}
sys.modules.setdefault("yaml", yaml_stub)
spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

module._get_sandbox_info = lambda: {
    "agent": "hermes",
    "model": "nemotron",
    "provider": "nvidia",
    "base_url": "http://localhost:8642/v1",
    "gateway": "running",
    "port": 8642,
}
module._reload_skills = lambda: {
    "alpha": {"description": "First skill"},
    "beta": {"description": "Second skill"},
}

result = {
    "status": module._handle_status({}, None, task_id="t-123", session_id="s-456"),
    "info": json.loads(module._handle_info({}, None, task_id="t-123", user_task="inspect")),
    "reload": module._handle_reload_skills({}, None, task_id="t-123", session_id="s-456"),
}
print(json.dumps(result))
`);

    const result = JSON.parse(output) as {
      status: string;
      info: Record<string, unknown>;
      reload: string;
    };

    expect(result.status).toContain("NemoClaw Sandbox Status (Hermes)");
    expect(result.status).toContain("Gateway:  running");
    expect(result.info).toMatchObject({
      agent: "hermes",
      model: "nemotron",
      provider: "nvidia",
      gateway: "running",
      port: 8642,
    });
    expect(result.reload).toContain("Skill reload complete. 2 skill(s) discovered:");
    expect(result.reload).toContain("alpha: First skill");
    expect(result.reload).toContain("beta: Second skill");
  });

  it("patches Hermes managed-tool modules for NemoClaw broker mode", () => {
    const output = runPython(`
import importlib.util
import json
import os
import pathlib
import sys
import types

plugin_path = pathlib.Path(sys.argv[1])
yaml_stub = types.ModuleType("yaml")
yaml_stub.safe_load = lambda *_args, **_kwargs: {}
sys.modules.setdefault("yaml", yaml_stub)

os.environ["NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER"] = "1"
os.environ["TOOL_GATEWAY_USER_TOKEN"] = "broker-token"
os.environ["FAL_QUEUE_GATEWAY_URL"] = "http://host.openshell.internal:11436/fal-queue"
os.environ["FIRECRAWL_GATEWAY_URL"] = "http://host.openshell.internal:11436/firecrawl"
os.environ["OPENAI_AUDIO_GATEWAY_URL"] = "http://host.openshell.internal:11436/openai-audio"

def add_module(name, module):
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent:
        parent_module = sys.modules.setdefault(parent, types.ModuleType(parent))
        setattr(parent_module, child, module)
    return module

hermes_config = add_module("hermes_cli.config", types.ModuleType("hermes_cli.config"))
hermes_config.get_env_value = lambda key: os.environ.get(key)
hermes_config.load_config = lambda: {
    "tts": {"use_gateway": True},
    "stt": {"use_gateway": True},
}

managed = add_module("tools.managed_tool_gateway", types.ModuleType("tools.managed_tool_gateway"))
managed.managed_nous_tools_enabled = lambda: False
managed.build_vendor_gateway_url = lambda vendor: "direct"
managed.read_nous_access_token = lambda: None
managed.resolve_managed_tool_gateway = lambda vendor: types.SimpleNamespace(
    nous_user_token="broker-token",
    gateway_origin=f"http://host.openshell.internal:11436/{vendor}",
)

web = add_module("tools.web_tools", types.ModuleType("tools.web_tools"))
web.managed_nous_tools_enabled = lambda: False
web.build_vendor_gateway_url = lambda vendor: "direct"
web._read_nous_access_token = lambda: None
web.resolve_managed_tool_gateway = lambda vendor: None

helpers = add_module("tools.tool_backend_helpers", types.ModuleType("tools.tool_backend_helpers"))
helpers.managed_nous_tools_enabled = lambda: False
helpers.resolve_openai_audio_api_key = lambda: "direct-openai-key"

transcription = add_module("tools.transcription_tools", types.ModuleType("tools.transcription_tools"))
transcription.resolve_managed_tool_gateway = managed.resolve_managed_tool_gateway
transcription._resolve_openai_audio_client_config = lambda: ("direct-openai-key", "https://api.openai.com/v1")
transcription._has_openai_audio_backend = lambda: False

image = add_module("tools.image_generation_tool", types.ModuleType("tools.image_generation_tool"))
class ManagedFalSyncClient:
    def __init__(self):
        self._queue_url_format = os.environ["FAL_QUEUE_GATEWAY_URL"]
    def submit(self):
        return types.SimpleNamespace(
            request_id="req-1",
            response_url="https://fal-queue-gateway.nousresearch.com/result/req-1",
            status_url="https://fal-queue-gateway.nousresearch.com/status/req-1",
            cancel_url="https://fal-queue-gateway.nousresearch.com/cancel/req-1",
            client="client",
        )
image._ManagedFalSyncClient = ManagedFalSyncClient

browser = add_module("tools.browser_tool", types.ModuleType("tools.browser_tool"))
browser._cached_cloud_provider = "local"
browser._cloud_provider_resolved = True
browser._active_sessions = {"default": {"features": {"local": True}}}
browser._session_last_activity = {"default": 1}
browser._recording_sessions = set(["default"])
browser._get_session_info = lambda task_id=None: {"task_id": task_id or "default"}
browser._resolve_cdp_override = lambda cdp_url: cdp_url

firecrawl_client = types.ModuleType("firecrawl.v2.utils.http_client")
class HttpClient:
    def __init__(self):
        self.api_url = os.environ["FIRECRAWL_GATEWAY_URL"]
    def _build_url(self, endpoint):
        return "http://host.openshell.internal:11436/v2/search"
firecrawl_client.HttpClient = HttpClient
add_module("firecrawl.v2.utils.http_client", firecrawl_client)

spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
patched = plugin._install_nous_tool_broker_patch()
fal_handle = image._ManagedFalSyncClient().submit()
firecrawl_url = firecrawl_client.HttpClient()._build_url("/v2/search")

result = {
    "patched": patched,
    "managed_enabled": managed.managed_nous_tools_enabled(),
    "web_enabled": web.managed_nous_tools_enabled(),
    "web_url": web.build_vendor_gateway_url("firecrawl"),
    "web_token": web._read_nous_access_token(),
    "audio_key": helpers.resolve_openai_audio_api_key(),
    "stt_config": transcription._resolve_openai_audio_client_config(),
    "fal_status_url": fal_handle.status_url,
    "browser_cache": [browser._cached_cloud_provider, browser._cloud_provider_resolved],
    "browser_sessions": browser._active_sessions,
    "firecrawl_url": firecrawl_url,
}
print(json.dumps(result))
`);

    const result = JSON.parse(output) as {
      patched: boolean;
      managed_enabled: boolean;
      web_enabled: boolean;
      web_url: string;
      web_token: string;
      audio_key: string;
      stt_config: [string, string];
      fal_status_url: string;
      browser_cache: [unknown, boolean];
      browser_sessions: Record<string, unknown>;
      firecrawl_url: string;
    };

    expect(result.patched).toBe(true);
    expect(result.managed_enabled).toBe(true);
    expect(result.web_enabled).toBe(true);
    expect(result.web_url).toBe("http://host.openshell.internal:11436/firecrawl");
    expect(result.web_token).toBe("broker-token");
    expect(result.audio_key).toBe("");
    expect(result.stt_config).toEqual([
      "broker-token",
      "http://host.openshell.internal:11436/openai-audio/v1",
    ]);
    expect(result.fal_status_url).toBe(
      "http://host.openshell.internal:11436/fal-queue/status/req-1",
    );
    expect(result.browser_cache).toEqual([null, false]);
    expect(result.browser_sessions).toEqual({});
    expect(result.firecrawl_url).toBe(
      "http://host.openshell.internal:11436/firecrawl/v2/search",
    );
  });
});
