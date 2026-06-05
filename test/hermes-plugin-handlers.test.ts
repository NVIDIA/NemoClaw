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
os.environ["NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN"] = "openshell:resolve:env:NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN"
os.environ["TOOL_GATEWAY_USER_TOKEN"] = "raw-legacy-token"
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
    expect(result.web_token).toBe(
      "openshell:resolve:env:NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
    );
    expect(result.audio_key).toBe("");
    expect(result.stt_config).toEqual([
      "openshell:resolve:env:NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
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

  it("normalizes raw messaging pseudo-tool responses before delivery", () => {
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

run_agent = types.ModuleType("run_agent")
class AIAgent:
    @staticmethod
    def _strip_think_blocks(content):
        return content
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

patched = plugin._install_messaging_response_patch()

# Same-platform: normalizes
plugin._set_current_messaging_platform("telegram")
class_patch_same = run_agent.AIAgent._strip_think_blocks(
    'send_message: "to telegram: Hello from the first message."'
)

# Cross-platform (telegram chat, slack target): MUST NOT normalize (#4175 review)
class_patch_cross = run_agent.AIAgent._strip_think_blocks(
    'send_message: "to slack: should not leak to telegram"'
)

# Unknown current platform: MUST NOT normalize even when target is valid (#4175 review)
plugin._set_current_messaging_platform(None)
class_patch_unknown = run_agent.AIAgent._strip_think_blocks(
    'send_message: "to telegram: should not normalize without context"'
)

result = {
    "patched": patched,
    "targeted": plugin._normalize_raw_messaging_tool_response(
        'send_message: "to telegram: Hello! I am Hermes."',
        current_platform="telegram",
    ),
    "untargeted": plugin._normalize_raw_messaging_tool_response(
        "send_message: this is documentation, not a delivery target",
        current_platform="telegram",
    ),
    "cross_platform_blocked": plugin._normalize_raw_messaging_tool_response(
        'send_message: "to slack: leaked into telegram chat"',
        current_platform="telegram",
    ),
    "unknown_platform_blocked": plugin._normalize_raw_messaging_tool_response(
        'send_message: "to telegram: should not normalize without context"',
        current_platform=None,
    ),
    "class_patch": class_patch_same,
    "class_patch_cross": class_patch_cross,
    "class_patch_unknown": class_patch_unknown,
}
print(json.dumps(result))
`);

    const result = JSON.parse(output) as {
      patched: boolean;
      targeted: string;
      untargeted: string;
      cross_platform_blocked: string;
      unknown_platform_blocked: string;
      class_patch: string;
      class_patch_cross: string;
      class_patch_unknown: string;
    };

    expect(result.patched).toBe(true);
    // Same-platform: normalizer extracts the body
    expect(result.targeted).toBe("Hello! I am Hermes.");
    expect(result.class_patch).toBe("Hello from the first message.");
    // No-platform body: original send_message: text is left intact
    expect(result.untargeted).toBe(
      "send_message: this is documentation, not a delivery target",
    );
    // Cross-platform target (telegram chat, slack target): must NOT be
    // silently delivered into the telegram chat. The raw send_message: text
    // is preserved so dispatch / error surfaces upstream. (#4175 review.)
    expect(result.cross_platform_blocked).toBe(
      'send_message: "to slack: leaked into telegram chat"',
    );
    expect(result.class_patch_cross).toBe(
      'send_message: "to slack: should not leak to telegram"',
    );
    // Unknown current-platform context: refuse to normalize even when the
    // target platform is valid, so a stray pseudo-call outside a known
    // messaging session doesn't get delivered into the wrong chat.
    expect(result.unknown_platform_blocked).toBe(
      'send_message: "to telegram: should not normalize without context"',
    );
    expect(result.class_patch_unknown).toBe(
      'send_message: "to telegram: should not normalize without context"',
    );
  });

  it("preserves instance-method strip_think_blocks binding", () => {
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

run_agent = types.ModuleType("run_agent")
class AIAgent:
    def __init__(self):
        self.calls = 0

    def _strip_think_blocks(self, content):
        self.calls += 1
        return content
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

patched = plugin._install_messaging_response_patch()
plugin._set_current_messaging_platform("telegram")
agent = AIAgent()
normalized = agent._strip_think_blocks(
    'send_message: "to telegram: Hello from an instance method."'
)
plain = agent._strip_think_blocks("plain response")

print(json.dumps({
    "patched": patched,
    "normalized": normalized,
    "plain": plain,
    "calls": agent.calls,
}))
`);

    const result = JSON.parse(output) as {
      patched: boolean;
      normalized: string;
      plain: string;
      calls: number;
    };

    expect(result.patched).toBe(true);
    expect(result.normalized).toBe("Hello from an instance method.");
    expect(result.plain).toBe("plain response");
    expect(result.calls).toBe(2);
  });

  it("anchors the strip_think_blocks patch via _pre_llm_call gateway hook", () => {
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

run_agent = types.ModuleType("run_agent")
class AIAgent:
    @staticmethod
    def _strip_think_blocks(content):
        return content
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

plugin._get_sandbox_info = lambda: {
    "agent": "hermes",
    "model": "n",
    "provider": "p",
    "base_url": "b",
    "gateway": "g",
    "port": 1,
}

# Simulate the first Telegram turn arriving via the gateway hook chain.
# _pre_llm_call should set the platform anchor AND install the patch on the
# stubbed run_agent.AIAgent so the subsequent _strip_think_blocks call goes
# through the platform-aware wrapper. This is the integration shape of the
# Hermes gateway first-message path (#4175 review feedback from @cv).
plugin._pre_llm_call(user_message="hello", is_first_turn=True, platform="telegram")
on_telegram_same = AIAgent._strip_think_blocks(
    'send_message: "to telegram: Hello from gateway."'
)
on_telegram_cross = AIAgent._strip_think_blocks(
    'send_message: "to slack: leaked into telegram chat"'
)

# Simulate the next first-turn message on a different platform (Discord). The
# patch is already installed; only the platform anchor should follow the new
# turn so the wrapper re-evaluates target_platform against current_platform.
plugin._pre_llm_call(user_message="hi", is_first_turn=True, platform="discord")
on_discord_same = AIAgent._strip_think_blocks(
    'send_message: "to discord: Hello from gateway."'
)
on_discord_stale_target = AIAgent._strip_think_blocks(
    'send_message: "to telegram: should not normalize on discord"'
)

print(json.dumps({
    "telegram_same": on_telegram_same,
    "telegram_cross": on_telegram_cross,
    "discord_same": on_discord_same,
    "discord_stale_target": on_discord_stale_target,
}))
`);

    const result = JSON.parse(output) as {
      telegram_same: string;
      telegram_cross: string;
      discord_same: string;
      discord_stale_target: string;
    };

    // First-turn Telegram hook path: body extracted via the patched chain.
    expect(result.telegram_same).toBe("Hello from gateway.");
    // Cross-platform target on the same Telegram session: preserved verbatim
    // — proves the anchor refuses to silently deliver into the wrong chat.
    expect(result.telegram_cross).toBe(
      'send_message: "to slack: leaked into telegram chat"',
    );
    // Subsequent Discord-turn hook path: anchor follows the new platform.
    expect(result.discord_same).toBe("Hello from gateway.");
    // Stale-target after platform switch (telegram body on a discord turn):
    // also preserved, pinning that the anchor refreshes per-turn.
    expect(result.discord_stale_target).toBe(
      'send_message: "to telegram: should not normalize on discord"',
    );
  });

  it("grounds first Telegram turns to reply directly instead of spelling tool calls", () => {
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

context = module._pre_llm_call(
    user_message="hello",
    is_first_turn=True,
    platform="telegram",
)["context"]
print(json.dumps({"context": context}))
`);

    const { context } = JSON.parse(output) as { context: string };

    expect(context).toContain("Current Hermes messaging platform: telegram");
    expect(context).toContain("Reply to the current telegram chat by returning normal assistant text");
    expect(context).toContain("never write raw text such as `send_message:");
  });
});
