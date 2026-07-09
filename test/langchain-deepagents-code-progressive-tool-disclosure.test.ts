// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const middlewarePath = path.join(agentDir, "progressive_tool_disclosure.py");
const observabilityPath = path.join(agentDir, "nemoclaw_observability.py");
const patcherPath = path.join(agentDir, "patch-managed-deepagents-code.py");
const harnessPath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "deepagents-progressive-disclosure-harness.py",
);

const MAIN_ANCHOR = "    args = parser.parse_args()\n";
const ENTRYPOINT_ANCHOR = "from deepagents_code.main import cli_main\n";
const HARDENING_MARKER = "NemoClaw-managed Deep Agents Code hardening v2.";
const DISCLOSURE_MARKER = "NemoClaw-managed progressive tool disclosure.";
const OBSERVABILITY_MARKER = "NemoClaw-managed backend-neutral observability.";

const PACKAGE_SOURCES: Record<string, string> = {
  "__init__.py": `"""Deep Agents Code 0.1.34 test package."""`,
  "__main__.py": `from deepagents_code.main import cli_main

if __name__ == "__main__":
    cli_main()
`,
  "main.py": `from __future__ import annotations

import os
from types import SimpleNamespace

class Parser:
    def parse_args(self):
        return SimpleNamespace(command=None)

    def error(self, message):
        raise RuntimeError(message)

parser = Parser()

def parse_args():
    args = parser.parse_args()
    return args

def cli_main():
    return parse_args()
`,
  "app.py": fs
    .readFileSync(
      path.join(repoRoot, "test", "fixtures", "langchain-deepagents-code", "app.py"),
      "utf8",
    )
    .replace(
      "    async def _switch_model(self, model_spec, **kwargs):\n",
      `    async def _resume_thread(self, thread_id):
        del thread_id

    async def _restart_server_for_agent_swap(self, agent_name):
        del agent_name

    async def _switch_model(self, model_spec, **kwargs):
`,
    ),
  "auth_store.py": `from __future__ import annotations

class StoredCredential: pass
class WriteOutcome: pass

def load_credentials(): return {}
def set_stored_key(*args, **kwargs): return WriteOutcome()
`,
  "config.py": `from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

_dotenv_loaded_values = {}

def _get_provider_kwargs(provider, *, model_name=None): return {}
def _load_dotenv(*, start_path=None, refresh_loaded=False): return False
def _parse_interpreter_ptc(raw): return raw
def _preview_dotenv_environ(*, start_path=None): return {}
def _tracing_enabled(): return False
`,
  "tools.py": `from __future__ import annotations

_MAX_FETCH_REDIRECTS = 5

class _UrlValidationError(ValueError): pass

def _fetch_with_redirects(url, *, timeout):
    return url, timeout
`,
  "model_config.py": `from __future__ import annotations

class ModelConfigError(RuntimeError): pass

class ModelConfig:
    @classmethod
    def load(cls): return cls()
    def get_class_path(self, provider_name): return None
`,
  "agent.py": `from __future__ import annotations

class FakeGraph:
    def __init__(self, main, subagents):
        self.main = main
        self.subagents = subagents
        self.config = {
            "tags": ["managed-tag"],
            "metadata": {"managed": "preserved"},
        }

    def with_config(self, config):
        merged = {**self.config, **config}
        existing_callbacks = self.config.get("callbacks")
        incoming_callbacks = config.get("callbacks")
        if existing_callbacks is not None and incoming_callbacks is not None:
            if isinstance(incoming_callbacks, list):
                if isinstance(existing_callbacks, list):
                    merged["callbacks"] = existing_callbacks + incoming_callbacks
                else:
                    manager = existing_callbacks.copy()
                    for callback in incoming_callbacks:
                        manager.add_handler(callback)
                    merged["callbacks"] = manager
            elif isinstance(existing_callbacks, list):
                manager = incoming_callbacks.copy()
                for callback in existing_callbacks:
                    manager.add_handler(callback)
                merged["callbacks"] = manager
            else:
                merged["callbacks"] = existing_callbacks.merge(incoming_callbacks)
        self.config = merged
        return self

def create_deep_agent(*args, **kwargs):
    del args
    main = list(kwargs.get("middleware") or ())
    subagents = [
        list(subagent.get("middleware") or ())
        for subagent in kwargs.get("subagents") or ()
    ]
    return FakeGraph(main, subagents)

def _resolve_ptc_option(*args, **kwargs): return None
def load_async_subagents(config_path=None): return []
def build_model_identity_section(name, provider=None, context_limit=None, unsupported_modalities=frozenset()): return name

def create_cli_agent(model, assistant_id, *args, **kwargs):
    del model, assistant_id, args
    kwargs.pop("mcp_server_info", None)
    kwargs.pop("rubric_model", None)
    kwargs.pop("async_subagents", None)
    graph_config = kwargs.pop("graph_config", None)
    graph = create_deep_agent(
        middleware=[],
        subagents=[{"name": "first", "middleware": []}, {"name": "second", "middleware": []}],
        **kwargs,
    )
    if graph_config is not None:
        graph.config = {**graph.config, **graph_config}
    return graph, "fixture-backend"
`,
  "update_check.py": `from __future__ import annotations

async def _run_install_subprocess(*args, **kwargs): return True, "spawned"
def set_auto_update(enabled): return enabled
async def _one(): return await _run_install_subprocess("one")
async def _two(): return await _run_install_subprocess("two")
async def _three(): return await _run_install_subprocess("three")
async def _four(): return await _run_install_subprocess("four")
async def _five(): return await _run_install_subprocess("five")
`,
  "integrations/__init__.py": `"""Test integrations."""`,
  "integrations/openai_codex.py": `from __future__ import annotations

from pathlib import Path

class CodexAuthStatus:
    def __init__(self, *, logged_in, store_path):
        self.logged_in = logged_in
        self.store_path = store_path

def default_store_path(): return Path("/sandbox/.deepagents/.state/chatgpt-auth.json")
def get_status(*, store_path=None): return CodexAuthStatus(logged_in=False, store_path=store_path)
async def run_browser_login(*args, **kwargs): return get_status()
def build_chat_model(*args, **kwargs): return object()
`,
  "client/__init__.py": `"""Test client."""`,
  "client/launch/__init__.py": `"""Test launch client."""`,
  "tui/__init__.py": `"""Test TUI."""`,
  "tui/widgets/__init__.py": `"""Test widgets."""`,
  "tui/widgets/auth.py": `from __future__ import annotations

class Static:
    def __init__(self, value): self.value = value

class AuthResult:
    CANCELLED = "cancelled"

class AuthPromptScreen:
    def compose(self): return []
    def on_mount(self): pass

class AuthManagerScreen:
    def compose(self): return []
    def on_mount(self): pass
`,
  "tui/widgets/codex_auth.py": `from __future__ import annotations

class Static:
    def __init__(self, value): self.value = value

class CodexAuthScreen:
    def compose(self): return []
    def on_mount(self): pass
`,
  "tui/widgets/model_selector.py": `from __future__ import annotations

class ModelSelectorScreen:
    def _select_with_auth_check(self, model_spec, provider): pass
`,
  "onboarding.py": `from __future__ import annotations

def should_run_onboarding(state_dir=None): return True
`,
  "tui/widgets/approval.py": `from __future__ import annotations

class ApprovalMenu:
    def _handle_selection(self, option, *, reject_message=None): pass
`,
  "tui/widgets/status.py": `from __future__ import annotations

class StatusBar:
    def set_model(self, *, provider, model, effort=""): pass
`,
  "tui/widgets/welcome.py": `from __future__ import annotations

class WelcomeBanner:
    def update_model(self, *, provider, model): pass
`,
  "client/launch/server.py": fs.readFileSync(
    path.join(repoRoot, "test", "fixtures", "langchain-deepagents-code", "server.py"),
    "utf8",
  ),
  "_server_config.py": `from __future__ import annotations

from pathlib import Path

def _normalize_path(raw_path, project_context, label):
    if not raw_path:
        return None
    if project_context is not None:
        return str(project_context.resolve_user_path(raw_path))
    return str(Path(raw_path).expanduser().resolve())
`,
  "mcp_tools.py": fs.readFileSync(
    path.join(repoRoot, "test", "fixtures", "langchain-deepagents-code", "mcp_tools.py"),
    "utf8",
  ),
  "subagents.py": `from __future__ import annotations

def list_subagents(*args, **kwargs): return []
`,
  "hooks.py": `from __future__ import annotations

from typing import Any

_hooks_config = None

def _load_hooks(): return []
def _run_single_hook(command, event, payload_bytes): return None
`,
  "client/non_interactive.py": `from __future__ import annotations

async def run_non_interactive(*args, **kwargs): return kwargs
async def _run_startup_command(command, console, *, quiet): return command
`,
};

interface PatchFixture {
  root: string;
  packageDir: string;
  entrypointPath: string;
  mainPath: string;
  agentPath: string;
  modulePath: string;
  observabilityModulePath: string;
  helperPath: string;
  sourcePaths: string[];
}

function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${content.trim()}\n`, "utf8");
  return target;
}

function makePatchFixture(version = "0.1.34"): PatchFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-disclosure-"));
  const packageDir = path.join(root, "deepagents_code");
  const sourcePaths = Object.entries(PACKAGE_SOURCES).map(([relativePath, source]) =>
    writeFixtureFile(packageDir, relativePath, source),
  );
  writeFixtureFile(
    root,
    `deepagents_code-${version}.dist-info/METADATA`,
    `Metadata-Version: 2.1\nName: deepagents-code\nVersion: ${version}`,
  );
  const entrypointPath = path.join(packageDir, "__main__.py");
  const mainPath = path.join(packageDir, "main.py");
  const agentPath = path.join(packageDir, "agent.py");
  const modulePath = path.join(packageDir, "progressive_tool_disclosure.py");
  const observabilityModulePath = path.join(packageDir, "nemoclaw_observability.py");
  const helperPath = path.join(packageDir, "_nemoclaw_managed.py");
  return {
    root,
    packageDir,
    entrypointPath,
    mainPath,
    agentPath,
    modulePath,
    observabilityModulePath,
    helperPath,
    sourcePaths,
  };
}

function runPatcher(fixture: PatchFixture) {
  return spawnSync("python3", [patcherPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: fixture.root },
  });
}

function snapshot(paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((file) => [file, fs.readFileSync(file, "utf8")]));
}

function runWiring(fixture: PatchFixture): Record<string, unknown> {
  const script = `import importlib
import importlib.util
import json
import os
import sys
import types

spec = importlib.util.spec_from_file_location("disclosure_harness", ${JSON.stringify(harnessPath)})
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
harness._install_stubs()
sys.path.insert(0, ${JSON.stringify(fixture.root)})

observability = types.ModuleType("deepagents_code.nemoclaw_observability")

class RelayMiddleware:
    pass

class MetadataOnlyCallback:
    pass

class MetadataOnlyCallbackManager:
    def __init__(self):
        self.handlers = [MetadataOnlyCallback()]

    def copy(self):
        return self

    def add_handler(self, handler):
        del handler

    def merge(self, other):
        del other
        return self

class HostileCallback:
    pass

class NormalCallbackManager:
    def __init__(self, handlers):
        self.handlers = handlers

    def copy(self):
        return NormalCallbackManager(list(self.handlers))

    def add_handler(self, handler):
        self.handlers.append(handler)

    def merge(self, other):
        return NormalCallbackManager([*self.handlers, *other.handlers])

observability.initialize_observability = lambda: os.environ.get("NEMOCLAW_OBSERVABILITY") == "1"
observability.new_relay_middleware = RelayMiddleware
observability.new_metadata_only_callback_manager = MetadataOnlyCallbackManager
sys.modules["deepagents_code.nemoclaw_observability"] = observability

agent = importlib.import_module("deepagents_code.agent")
middleware = importlib.import_module("deepagents_code.progressive_tool_disclosure")

class Info:
    def __init__(self, tools, name="fixture"):
        self.tools = tools
        self.name = name

class NamedTool:
    def __init__(self, name):
        self.name = name

def counts(result):
    graph, backend = result
    assert backend == "fixture-backend"
    main, subagents = graph.main, graph.subagents
    middleware_type = middleware.ProgressiveToolDisclosureMiddleware
    instances = [item for item in main if isinstance(item, middleware_type)]
    instances.extend(
        item for stack in subagents for item in stack if isinstance(item, middleware_type)
    )
    return len(instances), len({id(item) for item in instances})

def observability_counts(result):
    graph, backend = result
    assert backend == "fixture-backend"
    instances = [item for item in graph.main if isinstance(item, RelayMiddleware)]
    instances.extend(
        item
        for stack in graph.subagents
        for item in stack
        if isinstance(item, RelayMiddleware)
    )
    callback_manager = graph.config.get("callbacks")
    callbacks = callback_manager.handlers if callback_manager is not None else []
    return {
        "instances": len(instances),
        "distinct": len({id(item) for item in instances}),
        "callbacks": len(callbacks),
        "callback_manager": isinstance(
            callback_manager, MetadataOnlyCallbackManager
        ) if callback_manager is not None else False,
        "metadata_only_callback": all(
            isinstance(callback, MetadataOnlyCallback) for callback in callbacks
        ),
        "tags": graph.config.get("tags"),
        "metadata": graph.config.get("metadata"),
    }

os.environ.pop("NEMOCLAW_TOOL_DISCLOSURE", None)
no_mcp = counts(agent.create_cli_agent(None, "assistant"))
empty_mcp = counts(agent.create_cli_agent(None, "assistant", mcp_server_info=[Info(())]))
active = counts(agent.create_cli_agent(None, "assistant", mcp_server_info=[Info(("mcp_echo",))]))
os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = "direct"
direct = counts(agent.create_cli_agent(None, "assistant", mcp_server_info=[Info(("mcp_echo",))]))

os.environ["NEMOCLAW_OBSERVABILITY"] = "true"
observability_noncanonical = observability_counts(
    agent.create_cli_agent(None, "assistant")
)
os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
observability_active = observability_counts(
    agent.create_cli_agent(None, "assistant")
)
observability_prebound_list = observability_counts(
    agent.create_cli_agent(
        None,
        "assistant",
        graph_config={"callbacks": [HostileCallback()]},
    )
)
observability_prebound_manager = observability_counts(
    agent.create_cli_agent(
        None,
        "assistant",
        graph_config={"callbacks": NormalCallbackManager([HostileCallback()])},
    )
)
os.environ.pop("NEMOCLAW_OBSERVABILITY", None)

original_factory = agent._nemoclaw_original_create_cli_agent
reached_original = []

def forbidden_original(*args, **kwargs):
    del args, kwargs
    reached_original.append("called")
    raise AssertionError("callable namespace validation ran too late")

def reject(tools, info=()):
    try:
        agent.create_cli_agent(
            None,
            "assistant",
            tools=tools,
            mcp_server_info=list(info),
        )
    except RuntimeError as exc:
        return str(exc)
    raise AssertionError("ambiguous callable tool namespace was accepted")

agent._nemoclaw_original_create_cli_agent = forbidden_original
try:
    os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = "progressive"
    progressive_collisions = {
        "regular_regular": reject([NamedTool("duplicate"), NamedTool("duplicate")]),
        "regular_mcp": reject(
            [NamedTool("mcp_echo"), NamedTool("mcp_echo")],
            [Info(("mcp_echo",), name="mcp")],
        ),
        "cross_mcp": reject(
            [NamedTool("alpha_beta_echo"), NamedTool("alpha_beta_echo")],
            [
                Info(("alpha_beta_echo",), name="alpha"),
                Info(("alpha_beta_echo",), name="alpha_beta"),
            ],
        ),
        "reserved_regular": reject([NamedTool("read_file")]),
        "reserved_mcp": reject(
            [NamedTool("search_tools")],
            [Info(("search_tools",), name="search")],
        ),
    }
    os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = "direct"
    direct_collisions = {
        "duplicate": reject([NamedTool("direct_dup"), NamedTool("direct_dup")]),
        "reserved": reject([NamedTool("execute")]),
    }
finally:
    agent._nemoclaw_original_create_cli_agent = original_factory

os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = "invalid"
try:
    agent.create_cli_agent(None, "assistant", mcp_server_info=[Info(("mcp_echo",))])
except RuntimeError as exc:
    invalid = str(exc)
else:
    raise AssertionError("invalid disclosure mode was accepted")

print(json.dumps({
    "no_mcp": no_mcp,
    "empty_mcp": empty_mcp,
    "active": active,
    "progressive_collisions": progressive_collisions,
    "direct_collisions": direct_collisions,
    "reached_original": reached_original,
    "direct": direct,
    "observability_noncanonical": observability_noncanonical,
    "observability_active": observability_active,
    "observability_prebound_list": observability_prebound_list,
    "observability_prebound_manager": observability_prebound_manager,
    "invalid": invalid,
}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: fixture.root },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runHarness(
  scenario: "behavior" | "overflow" | "persistence" | "isolation" | "namespace",
  target = middlewarePath,
) {
  const result = spawnSync("python3", [harnessPath, scenario, target], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Deep Agents progressive tool disclosure", () => {
  it("keeps only core tools visible and discovers name/description matches cumulatively", () => {
    const result = runHarness("behavior");
    expect(result.initial).toEqual(["ls", "search_tools", "read_file"]);
    expect(result.discovered).toEqual(["Weather_Forecast", "query_database"]);
    expect(result.async).toEqual([
      "Weather_Forecast",
      "ls",
      "query_database",
      "search_tools",
      "read_file",
    ]);
    expect(result.max_query_length).toBe(256);
    expect(result.provider_native_preserved).toBe(true);
  });

  it("bounds broad catalog output, persisted discovery, and visible schemas deterministically", () => {
    const result = runHarness("overflow");
    expect(result.result_limit).toBe(20);
    expect(result.description_chars).toBe(256);
    expect(result.output_bytes_limit).toBe(8192);
    expect(result.output_bytes).toBeLessThanOrEqual(8192);
    expect(result.discovered_count).toBe(20);
    expect(result.discovery_limit).toBe(64);
    expect(result.discovery_name_bytes).toBe(120);
    expect(result.discovery_state_bytes_limit).toBe(8192);
    expect(result.discovery_state_bytes).toBeLessThanOrEqual(8192);
    expect(result.long_state_count).toBe(64);
    expect(result.state_count).toBe(64);
    expect(result.single_schema_bytes_limit).toBe(16384);
    expect(result.visible_schema_bytes_limit).toBe(131072);
    expect(result.visible_schema_count).toBeGreaterThan(0);
    expect(result.visible_schema_count).toBeLessThan(64);
    expect(result.oversized_schema_omitted).toBe(true);
    expect(result.state_blocked).toBe(true);
    expect(result.schema_blocked).toBe(true);
    expect(result.search_to_request_consistent).toBe(true);
    expect(result.core_schema_limits_exempt).toBe(true);
    expect(result.reducer_associative).toBe(true);
    expect(result.concurrent_response_bounded).toBe(true);
    expect(result.sequential_visibility_monotonic).toBe(true);
    expect(result.duplicate_first_wins).toBe(true);
    expect(result.empty_names_preserved).toBe(true);
    expect(result.provider_native_preserved).toBe(true);
  });

  it("restores discovered tools after compaction and session reconstruction", () => {
    const result = runHarness("persistence");
    expect(result.resumed).toContain("Weather_Forecast");
    expect(result.unknown).not.toContain("Weather_Forecast");
  });

  it("isolates graph threads and local-subagent middleware instances", () => {
    const result = runHarness("isolation");
    expect(result.thread_a).toContain("Weather_Forecast");
    expect(result.thread_b).not.toContain("Weather_Forecast");
  });

  it("rejects duplicate callable names and non-managed reserved-name owners", () => {
    const result = runHarness("namespace");
    expect(result.safe_mcp).toBe(true);
    expect(result.regular_regular).toContain("multiple registered implementations");
    expect(result.regular_mcp).toContain("MCP metadata owners");
    expect(result.cross_mcp).toContain("multiple MCP owners");
    expect(result.reserved_regular).toContain("non-managed owner of reserved name 'read_file'");
    expect(result.reserved_mcp).toContain("non-managed owner of reserved name 'search_tools'");
  });
});

describe("Deep Agents 0.1.34 progressive-disclosure build patch", () => {
  it("patches the complete package and isolated main/subagent wiring idempotently", () => {
    const fixture = makePatchFixture();
    const first = runPatcher(fixture);
    expect(first.status, first.stderr).toBe(0);

    const managedPaths = [
      ...fixture.sourcePaths,
      fixture.modulePath,
      fixture.observabilityModulePath,
      fixture.helperPath,
    ];
    const firstBytes = snapshot(managedPaths);
    const second = runPatcher(fixture);
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot(managedPaths)).toEqual(firstBytes);

    for (const file of fixture.sourcePaths.filter(
      (sourcePath) =>
        !sourcePath.endsWith("/__init__.py") && !sourcePath.endsWith("/onboarding.py"),
    )) {
      expect(
        firstBytes[file].match(new RegExp(HARDENING_MARKER.replaceAll(".", "\\."), "g")),
      ).toHaveLength(1);
    }
    expect(
      firstBytes[fixture.agentPath].match(/NemoClaw-managed progressive tool disclosure\./g),
    ).toHaveLength(1);
    // Retain onboarding in the full-package snapshot to prove it stays untouched and idempotent.
    expect(firstBytes[path.join(fixture.packageDir, "onboarding.py")]).not.toContain(
      HARDENING_MARKER,
    );
    expect(
      firstBytes[fixture.agentPath].match(/ProgressiveToolDisclosureMiddleware\(\)/g),
    ).toHaveLength(2);
    expect(firstBytes[fixture.modulePath]).toBe(fs.readFileSync(middlewarePath, "utf8"));
    expect(firstBytes[fixture.observabilityModulePath]).toBe(
      fs.readFileSync(observabilityPath, "utf8"),
    );
    expect(firstBytes[fixture.agentPath]).toContain(
      '"callbacks": new_metadata_only_callback_manager()',
    );
    expect(firstBytes[fixture.agentPath]).toContain("agent.config = {");
    expect(firstBytes[fixture.agentPath]).not.toContain(
      'with_config({"callbacks": new_metadata_only_callback_manager()})',
    );

    const wiring = runWiring(fixture);
    expect(wiring).toMatchObject({
      no_mcp: [0, 0],
      empty_mcp: [0, 0],
      active: [3, 3],
      direct: [0, 0],
      reached_original: [],
      invalid: "NEMOCLAW_TOOL_DISCLOSURE must be 'progressive' or 'direct'",
    });
    expect(wiring.observability_noncanonical).toEqual({
      instances: 0,
      distinct: 0,
      callbacks: 0,
      callback_manager: false,
      metadata_only_callback: true,
      tags: ["managed-tag"],
      metadata: { managed: "preserved" },
    });
    expect(wiring.observability_active).toEqual({
      instances: 3,
      distinct: 3,
      callbacks: 1,
      callback_manager: true,
      metadata_only_callback: true,
      tags: ["managed-tag"],
      metadata: { managed: "preserved" },
    });
    expect(wiring.observability_prebound_list).toEqual(wiring.observability_active);
    expect(wiring.observability_prebound_manager).toEqual(wiring.observability_active);
    expect(wiring.progressive_collisions).toEqual({
      regular_regular: expect.stringContaining("multiple registered implementations"),
      regular_mcp: expect.stringContaining("MCP metadata owners"),
      cross_mcp: expect.stringContaining("multiple MCP owners"),
      reserved_regular: expect.stringContaining("non-managed owner of reserved name 'read_file'"),
      reserved_mcp: expect.stringContaining("non-managed owner of reserved name 'search_tools'"),
    });
    expect(wiring.direct_collisions).toEqual({
      duplicate: expect.stringContaining("multiple registered implementations"),
      reserved: expect.stringContaining("non-managed owner of reserved name 'execute'"),
    });
  });

  it("fails closed on the pinned package version before changing source", () => {
    const fixture = makePatchFixture("0.1.31");
    const before = snapshot(fixture.sourcePaths);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected deepagents-code==0.1.34");
    expect(snapshot(fixture.sourcePaths)).toEqual(before);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it.each([
    ["parser", "mainPath", MAIN_ANCHOR],
    ["entrypoint", "entrypointPath", ENTRYPOINT_ANCHOR],
  ] as const)("fails closed when the exact %s anchor is missing or duplicated", (label, pathKey, anchor) => {
    for (const mode of ["missing", "duplicate"] as const) {
      const fixture = makePatchFixture();
      const target = fixture[pathKey];
      const original = fs.readFileSync(target, "utf8");
      fs.writeFileSync(
        target,
        mode === "missing"
          ? original.replace(anchor, "")
          : original.replace(anchor, anchor + anchor),
        "utf8",
      );
      const before = snapshot(fixture.sourcePaths);
      const result = runPatcher(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Expected one Deep Agents Code ${label} marker`);
      expect(snapshot(fixture.sourcePaths)).toEqual(before);
      expect(fs.existsSync(fixture.modulePath)).toBe(false);
    }
  });

  it("fails closed when the required progressive agent source shape drifts", () => {
    const fixture = makePatchFixture();
    const original = fs.readFileSync(fixture.agentPath, "utf8");
    fs.writeFileSync(
      fixture.agentPath,
      original.replace("def create_cli_agent(", "def renamed_create_cli_agent("),
      "utf8",
    );
    const before = snapshot(fixture.sourcePaths);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Required upstream functions missing");
    expect(result.stderr).toContain("create_cli_agent");
    expect(snapshot(fixture.sourcePaths)).toEqual(before);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it("rejects a partial progressive sentinel without changing package source", () => {
    const fixture = makePatchFixture();
    fs.appendFileSync(fixture.agentPath, `\n# ${DISCLOSURE_MARKER}\n`, "utf8");
    const before = snapshot(fixture.sourcePaths);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("progressive-disclosure patch is partial");
    expect(snapshot(fixture.sourcePaths)).toEqual(before);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it.each([
    ["progressive-disclosure", DISCLOSURE_MARKER],
    ["observability", OBSERVABILITY_MARKER],
  ])("rejects a fully installed package missing its %s marker", (boundary, marker) => {
    const fixture = makePatchFixture();
    const first = runPatcher(fixture);
    expect(first.status, first.stderr).toBe(0);
    fs.writeFileSync(
      fixture.agentPath,
      fs.readFileSync(fixture.agentPath, "utf8").replace(`# ${marker}`, "# marker removed"),
      "utf8",
    );
    const before = snapshot([
      ...fixture.sourcePaths,
      fixture.modulePath,
      fixture.observabilityModulePath,
      fixture.helperPath,
    ]);

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Managed package ${boundary} patch is partial`);
    expect(
      snapshot([
        ...fixture.sourcePaths,
        fixture.modulePath,
        fixture.observabilityModulePath,
        fixture.helperPath,
      ]),
    ).toEqual(before);
  });

  it("rejects a partial package install with the middleware missing", () => {
    const fixture = makePatchFixture();
    const first = runPatcher(fixture);
    expect(first.status, first.stderr).toBe(0);
    fs.rmSync(fixture.modulePath);
    const before = snapshot([...fixture.sourcePaths, fixture.helperPath]);

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Managed package patch is partial: middleware is missing");
    expect(snapshot([...fixture.sourcePaths, fixture.helperPath])).toEqual(before);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it("rejects a partial package install with the observability module missing", () => {
    const fixture = makePatchFixture();
    const first = runPatcher(fixture);
    expect(first.status, first.stderr).toBe(0);
    fs.rmSync(fixture.observabilityModulePath);
    const before = snapshot([...fixture.sourcePaths, fixture.modulePath, fixture.helperPath]);

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Managed package patch is partial: observability module is missing",
    );
    expect(snapshot([...fixture.sourcePaths, fixture.modulePath, fixture.helperPath])).toEqual(
      before,
    );
    expect(fs.existsSync(fixture.observabilityModulePath)).toBe(false);
  });

  it("refuses to overwrite a conflicting installed middleware module", () => {
    const fixture = makePatchFixture();
    fs.writeFileSync(fixture.modulePath, "# unexpected module\n", "utf8");
    const before = snapshot(fixture.sourcePaths);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite unexpected middleware");
    expect(snapshot(fixture.sourcePaths)).toEqual(before);
    expect(fs.readFileSync(fixture.modulePath, "utf8")).toBe("# unexpected module\n");
  });

  it("refuses to overwrite a conflicting installed observability module", () => {
    const fixture = makePatchFixture();
    fs.writeFileSync(fixture.observabilityModulePath, "# unexpected module\n", "utf8");
    const before = snapshot(fixture.sourcePaths);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite unexpected observability module");
    expect(snapshot(fixture.sourcePaths)).toEqual(before);
    expect(fs.readFileSync(fixture.observabilityModulePath, "utf8")).toBe("# unexpected module\n");
  });
});
