// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDarwinFcntlSealConstants } from "./helpers/darwin-fcntl-seal-fixture";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patcher,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

const progressiveDisclosureHarness = path.join(
  process.cwd(),
  "test",
  "fixtures",
  "deepagents-progressive-disclosure-harness.py",
);

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed package patch", () => {
  it("fails fast when the Darwin fcntl seal injection anchor is missing", () => {
    expect(() => addDarwinFcntlSealConstants("from pathlib import Path\n", "darwin")).toThrow(
      "Darwin fcntl seal shim injection point not found in helper module",
    );
  });

  it("patches every 0.1.34 mutation and credential boundary idempotently", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    patchFixture(tempDir);

    const packageDir = path.join(tempDir, "deepagents_code");
    for (const relativePath of [
      "main.py",
      "__main__.py",
      "app.py",
      "auth_store.py",
      "config.py",
      "model_config.py",
      "agent.py",
      "update_check.py",
      "integrations/openai_codex.py",
      "tui/widgets/auth.py",
      "tui/widgets/codex_auth.py",
      "tui/widgets/model_selector.py",
      "tui/widgets/approval.py",
      "tui/widgets/status.py",
      "tui/widgets/welcome.py",
      "client/launch/server.py",
      "_server_config.py",
      "mcp_tools.py",
      "subagents.py",
      "hooks.py",
      "client/non_interactive.py",
      "_nemoclaw_managed.py",
    ]) {
      const source = fs.readFileSync(path.join(packageDir, relativePath), "utf8");
      expect(source.match(/NemoClaw-managed Deep Agents Code hardening v2\./g)).toHaveLength(1);
    }
    const main = fs.readFileSync(path.join(packageDir, "main.py"), "utf8");
    for (const expected of [
      'args.sandbox = "none"',
      "args.no_mcp = not has_managed_mcp",
      "args.mcp_config = managed_mcp_config if has_managed_mcp else None",
      "args.shell_allow_list = None",
      'getattr(args, "update", False)',
      'getattr(args, "auto_update", False)',
      'getattr(args, "install", None)',
      'getattr(args, "model_params", None)',
      'getattr(args, "interpreter_tools", None)',
      'getattr(args, "auto_approve", False)',
      "_nemoclaw_assert_safe_runtime()",
      'os.environ.pop("PYTHONPATH", None)',
    ]) {
      expect(main).toContain(expected);
    }
  });

  it.each([
    [
      "agent",
      "agent.py",
      "_nemoclaw_original_build_model_identity_section = build_model_identity_section",
    ],
    [
      "status",
      "tui/widgets/status.py",
      "_nemoclaw_original_status_bar_set_model = StatusBar.set_model",
    ],
    [
      "welcome",
      "tui/widgets/welcome.py",
      "_nemoclaw_original_welcome_banner_update_model = WelcomeBanner.update_model",
    ],
  ])("rejects a fully marked package with a corrupt %s patch", (boundary, relativePath, anchor) => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const target = path.join(tempDir, "deepagents_code", relativePath);
    const corrupted = fs.readFileSync(target, "utf8").replace(anchor, `${anchor}  # corrupt`);
    fs.writeFileSync(target, corrupted, "utf8");

    const result = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Managed package ${boundary} patch is incomplete`);
    expect(fs.readFileSync(target, "utf8")).toBe(corrupted);
  });

  it("preserves upstream MCP JSON diagnostics around the managed descriptor loader", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const invalidConfig = path.join(tempDir, "invalid-mcp.json");
    fs.writeFileSync(invalidConfig, '{"mcpServers": }\n', "utf8");

    const result = spawnSync(
      "python3",
      [
        "-c",
        `import json
from deepagents_code.mcp_tools import load_mcp_config

try:
    load_mcp_config(${JSON.stringify(invalidConfig)})
except json.JSONDecodeError as exc:
    print(str(exc))
else:
    raise AssertionError("invalid JSON unexpectedly loaded")
`,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Invalid JSON in MCP config file");
    expect(result.stdout).toContain("Check the JSON syntax.");
    expect(result.stdout).toContain("^");
    const patchedLoader = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "mcp_tools.py"),
      "utf8",
    );
    expect(patchedLoader).toContain("return json.loads(managed_payload)");
    expect(patchedLoader).toContain("return json.load(file_obj)");
  });

  it.each([
    ["update"],
    ["auth"],
    ["install"],
    ["mcp"],
    ["tools", "install"],
    ["--update"],
    ["--upd"],
    ["--auto-update"],
    ["--auto-upd"],
    ["--install", "nvidia"],
    ["--inst", "nvidia"],
    ["--model-params", '{"api_key":"secret"}'],
    ['--model-p={"api_key":"secret"}'],
    ["--rubric-model", "anthropic:test"],
    ["--rubric-m=anthropic:test"],
    ["--interpreter"],
    ["--interpreter-tools", "execute"],
    ["--interpreter-t=execute"],
    ["-y"],
    ["--auto-approve"],
    ["--acp"],
    ["--startup-cmd", "touch /tmp/unsafe"],
    ["--startup-cmd=touch /tmp/unsafe"],
  ])("rejects direct-module mutation arguments: %s", (...args) => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync("python3", ["-m", "deepagents_code", ...args], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("disabled in NemoClaw-managed");
  });

  it("preserves ordinary direct-module and read-only tools execution", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    for (const args of [[], ["tools", "list"], ["tools", "help"]]) {
      const result = spawnSync("python3", ["-m", "deepagents_code", ...args], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      });
      expect(result.status, `${args.join(" ")} failed: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("managed-posture-ok");
    }
  });

  it("rejects direct-module runtime credentials before settings bootstrap", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    for (const [name, value] of [
      ["OPENAI_API_KEY", "sk-TEST-FAKE-DO-NOT-USE-000000000000"],
      ["NOTES", "metadata API_KEY=ABCDEFGHIJKL"],
      ["SLACK_BOT_TOKEN", "xoxb-sk-abcdefghijklmnopqrstuv"],
      ["LANGSMITH_RUNS_ENDPOINTS", '{"https://trace.example":"opaque-key-value"}'],
      ["LANGCHAIN_RUNS_ENDPOINTS", '{"https://trace.example":"opaque-key-value"}'],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.example/v1/traces"],
      ["OTEL_EXPORTER_OTLP_HEADERS", "authorization=opaque-value"],
    ]) {
      const result = spawnSync("python3", ["-m", "deepagents_code"], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir, [name]: value },
        encoding: "utf8",
      });

      expect(result.status, `${name} was allowed`).not.toBe(0);
      expect(result.stderr).toContain(`runtime environment variable ${name}`);
    }
  });

  it("allows only scoped managed credential-shaped runtime values", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync("python3", ["-m", "deepagents_code"], {
      env: {
        PATH: process.env.PATH,
        PYTHONPATH: tempDir,
        DEEPAGENTS_CODE_OPENAI_API_KEY: "nemoclaw-managed-inference",
        SLACK_BOT_TOKEN: ["xoxb", "1234567890abcdef"].join("-"),
        DEEPAGENTS_CODE_LANGSMITH_TRACING: "true",
        DEEPAGENTS_CODE_LANGSMITH_TRACING_V2: "true",
        DEEPAGENTS_CODE_LANGCHAIN_TRACING: "true",
        DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2: "true",
        LANGSMITH_TRACING: "true",
        LANGSMITH_TRACING_V2: "true",
        LANGCHAIN_TRACING: "true",
        LANGCHAIN_TRACING_V2: "true",
        OTEL_ENABLED: "true",
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("managed-posture-ok");
  });

  it("accepts only exact same-name OpenShell credential placeholders", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const run = (name: string, value: string) =>
      spawnSync("python3", ["-m", "deepagents_code"], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir, [name]: value },
        encoding: "utf8",
      });

    for (const value of [
      "openshell:resolve:env:GITHUB_MCP_TOKEN",
      "openshell:resolve:env:v0_GITHUB_MCP_TOKEN",
      `openshell:resolve:env:v${"1".repeat(20)}_GITHUB_MCP_TOKEN`,
    ]) {
      const result = run("GITHUB_MCP_TOKEN", value);
      expect(result.status, result.stderr).toBe(0);
    }

    for (const [name, value] of [
      ["GITHUB_MCP_TOKEN", "prefix-openshell:resolve:env:GITHUB_MCP_TOKEN"],
      ["GITHUB_MCP_TOKEN", "openshell:resolve:env:OTHER_TOKEN"],
      ["GITHUB_MCP_TOKEN", `openshell:resolve:env:v${"1".repeat(21)}_GITHUB_MCP_TOKEN`],
      ["OPENSHELL_TLS_KEY", "openshell:resolve:env:OPENSHELL_TLS_KEY"],
    ]) {
      const result = run(name, value);
      expect(result.status, `${name}=${value} was allowed`).not.toBe(0);
      expect(result.stderr).toContain("invalid OpenShell credential placeholder");
    }
  });

  it("loads only strict HTTPS-only managed MCP configuration", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const configPath = path.join(tempDir, ".mcp.json");
    const validate = (config: unknown, mode = 0o600) => {
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode });
      fs.chmodSync(configPath, mode);
      return spawnSync(
        "python3",
        [
          "-c",
          [
            "import sys",
            "from pathlib import Path",
            "from deepagents_code import _nemoclaw_managed as managed",
            "managed._MCP_CONFIG_FILE = Path(sys.argv[1])",
            "snapshot = managed.managed_mcp_config_path() if sys.platform == 'linux' else None",
            "canonical = managed.managed_mcp_config_bytes(snapshot) if snapshot else managed._canonicalize_managed_mcp_config(managed._read_managed_mcp_config() or b'')",
            "print(canonical.decode() if canonical else 'absent', end='')",
          ].join("; "),
          configPath,
        ],
        {
          env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
          encoding: "utf8",
        },
      );
    };
    const validServer = {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer openshell:resolve:env:v20_GITHUB_MCP_TOKEN",
      },
    };

    const valid = validate({ mcpServers: { github: validServer } });
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual({ mcpServers: { github: validServer } });

    for (const config of [
      { mcpServers: { github: { command: "bash", args: ["-c", "id"] } } },
      { mcpServers: { github: validServer }, ui: { theme: "dark" } },
      {
        mcpServers: {
          github: { ...validServer, headers: { "X-Test": "value" } },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, headers: { Authorization: "Bearer raw-secret-value" } },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://127.0.0.1/mcp/" },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://2130706433/mcp/" },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://0177.0.0.1/mcp/" },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://api.githubcopilot.com:443/mcp/" },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://api.githubcopilot.com/a/../mcp/" },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://api.githubcopilot.com/mcp path/" },
        },
      },
      ...[
        "mcp_bad.example.test",
        "-mcp.example.test",
        "mcp-.example.test",
        "mcp..example.test",
        `${"a".repeat(64)}.example.test`,
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
      ].map((hostname) => ({
        mcpServers: {
          github: { ...validServer, url: `https://${hostname}/mcp/` },
        },
      })),
      {
        mcpServers: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`server${index}`, validServer]),
        ),
      },
    ]) {
      const result = validate(config);
      expect(result.status, JSON.stringify(config)).not.toBe(0);
    }

    const badMode = validate({ mcpServers: { github: validServer } }, 0o644);
    expect(badMode.status).not.toBe(0);
    expect(badMode.stderr).toContain("unsafe ownership or mode");
  });

  it("rejects duplicate keys and configs beyond the 256 KiB cap", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const configPath = path.join(tempDir, ".mcp.json");
    const run = () =>
      spawnSync(
        "python3",
        [
          "-c",
          [
            "import sys",
            "from pathlib import Path",
            "from deepagents_code import _nemoclaw_managed as managed",
            "managed._MCP_CONFIG_FILE = Path(sys.argv[1])",
            "managed.managed_mcp_config_path()",
          ].join("; "),
          configPath,
        ],
        {
          env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
          encoding: "utf8",
        },
      );

    fs.writeFileSync(
      configPath,
      '{"mcpServers":{"github":{"type":"http","type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer openshell:resolve:env:GITHUB_MCP_TOKEN"}}}}\n',
      { mode: 0o600 },
    );
    const duplicate = run();
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate JSON key");

    fs.writeFileSync(configPath, " ".repeat(262_145), { mode: 0o600 });
    const oversized = run();
    expect(oversized.status).not.toBe(0);
    expect(oversized.stderr).toContain("invalid size");

    const targetPath = path.join(tempDir, "symlink-target.json");
    fs.writeFileSync(targetPath, '{"mcpServers":{}}\n', { mode: 0o600 });
    fs.rmSync(configPath);
    fs.symlinkSync(targetPath, configPath);
    const symlinked = run();
    expect(symlinked.status).not.toBe(0);
  });

  it.runIf(process.platform === "linux")(
    "passes sealed and anonymous MCP snapshots through ServerProcess restart",
    () => {
      const tempDir = createPackageFixture();
      patchFixture(tempDir);
      const configPath = path.join(tempDir, ".nemoclaw-mcp.json");
      const managedConfig = {
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer openshell:resolve:env:GITHUB_MCP_TOKEN",
            },
          },
        },
      };
      for (const snapshotKind of ["sealed-memfd", "anonymous-otmpfile"] as const) {
        fs.writeFileSync(configPath, `${JSON.stringify(managedConfig)}\n`, { mode: 0o600 });

        const result = spawnSync(
          "python3",
          [
            "-c",
            `
import asyncio
import errno
import fcntl
import json
import os
import sys
from pathlib import Path

from deepagents_code import _nemoclaw_managed as managed
from deepagents_code import _server_config, app, mcp_tools
from deepagents_code.client.launch.server import ServerProcess

real_memfd_create = os.memfd_create
if sys.argv[2] == "anonymous-otmpfile":
    def blocked_memfd(*_args, **_kwargs):
        raise PermissionError(errno.EPERM, "blocked by seccomp")
    managed.os.memfd_create = blocked_memfd
managed._MCP_CONFIG_FILE = Path(sys.argv[1])
snapshot_path = managed.managed_mcp_config_path()
assert snapshot_path is not None
descriptor = int(snapshot_path.removeprefix("/proc/self/fd/"))
binding = managed._MANAGED_MCP_BINDING
assert binding is not None
required_seals = (
    fcntl.F_SEAL_WRITE
    | fcntl.F_SEAL_GROW
    | fcntl.F_SEAL_SHRINK
    | fcntl.F_SEAL_SEAL
)
if binding["kind"] == managed._MCP_SEALED_KIND:
    assert fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) == required_seals
else:
    assert binding["kind"] == managed._MCP_ANONYMOUS_KIND
    assert fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY
assert managed.managed_mcp_config_bytes(snapshot_path) == managed.managed_mcp_config_bytes(snapshot_path)
assert _server_config._normalize_path(snapshot_path, None, "MCP config") == snapshot_path
assert app.DeepAgentsApp._absolutize_launch_relative_path(
    snapshot_path, Path.cwd()
) == snapshot_path
assert mcp_tools.discover_mcp_configs() == []
expected_config = json.loads(managed.managed_mcp_config_bytes(snapshot_path))

class RejectingProjectContext:
    def resolve_user_path(self, _path):
        raise AssertionError("managed descriptor path must not be resolved")

child = (
    "import json, os; from deepagents_code.mcp_tools import load_mcp_config; "
    "config = load_mcp_config(os.environ['DEEPAGENTS_CODE_SERVER_MCP_CONFIG_PATH']); "
    "assert 'NEMOCLAW_DCODE_MCP_BINDING' not in os.environ; "
    "print(json.dumps(config), end='')"
)
def server_for_path(config_path):
    env = os.environ.copy()
    env["DEEPAGENTS_CODE_SERVER_MCP_CONFIG_PATH"] = config_path
    env["NEMOCLAW_DCODE_MCP_BINDING"] = "hostile-binding"
    return ServerProcess([sys.executable, "-c", child], os.getcwd(), env)

def make_descriptor_server(name, payload, seals):
    descriptor = real_memfd_create(name, flags=os.MFD_ALLOW_SEALING)
    os.write(descriptor, payload)
    fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, seals)
    return descriptor, server_for_path(f"/proc/self/fd/{descriptor}")

server = server_for_path(snapshot_path)
unsealed_descriptor, unsealed_server = make_descriptor_server(
    "unsealed-dcode-mcp", b"{}", 0
)
empty_descriptor, empty_server = make_descriptor_server(
    "empty-dcode-mcp", b"", required_seals
)
oversized_descriptor, oversized_server = make_descriptor_server(
    "oversized-dcode-mcp", b"x" * 262_145, required_seals
)

async def exercise():
    resolved_configs = await mcp_tools.resolve_and_load_mcp_tools(
        explicit_config_path=snapshot_path,
        project_context=RejectingProjectContext(),
    )
    assert resolved_configs == [expected_config]
    await server.start()
    Path(sys.argv[1]).write_text(
        json.dumps({
            "mcpServers": {
                "attacker": {
                    "type": "http",
                    "url": "https://attacker.example/mcp/",
                    "headers": {
                        "Authorization": "Bearer openshell:resolve:env:ATTACKER_TOKEN"
                    },
                }
            }
        }),
        encoding="utf-8",
    )
    await server.restart()
    for invalid_server in (unsealed_server, empty_server, oversized_server):
        try:
            await invalid_server.start()
        except RuntimeError as exc:
            assert "not process-local" in str(exc)
            assert not hasattr(invalid_server, "_log_file")
        else:
            raise AssertionError("invalid MCP descriptor was inherited")

asyncio.run(exercise())
for descriptor in (unsealed_descriptor, empty_descriptor, oversized_descriptor):
    os.close(descriptor)
print(json.dumps({
    "path": snapshot_path,
    "kind": binding["kind"],
    "outputs": [json.loads(output) for output in server.outputs],
}))
`,
            configPath,
            snapshotKind,
          ],
          {
            cwd: tempDir,
            env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
            encoding: "utf8",
          },
        );

        expect(result.status, result.stderr).toBe(0);
        const proof = JSON.parse(result.stdout) as {
          path: string;
          kind: string;
          outputs: unknown[];
        };
        expect(proof.path).toMatch(/^\/proc\/self\/fd\/[0-9]+$/);
        expect(proof.kind).toBe(snapshotKind);
        expect(proof.outputs).toEqual([managedConfig, managedConfig]);
        expect(result.stdout).not.toContain("attacker");
      }
    },
  );

  it("blocks TUI commands, credential screens, dotenv, OAuth, and install backends", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const managedMcpPath = path.join(tempDir, "managed-mcp.json");
    fs.writeFileSync(
      managedMcpPath,
      `${JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer openshell:resolve:env:GITHUB_MCP_TOKEN",
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const validation = `
import asyncio
import importlib.util
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "progressive_disclosure_harness",
    ${JSON.stringify(progressiveDisclosureHarness)},
)
assert spec is not None and spec.loader is not None
progressive_disclosure_harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progressive_disclosure_harness)
progressive_disclosure_harness._install_stubs()

from deepagents_code import agent, app, auth_store, config, hooks, main as dcode_main, model_config, subagents, update_check
from deepagents_code import _nemoclaw_managed, nemoclaw_observability
from deepagents_code import config_manifest
from deepagents_code.client import non_interactive
from deepagents_code.client.launch import server
from deepagents_code.integrations import openai_codex
from deepagents_code.tui.widgets.auth import AuthManagerScreen, AuthPromptScreen, AuthResult
from deepagents_code.tui.widgets.codex_auth import CodexAuthScreen
from deepagents_code.tui.widgets import model_selector
from deepagents_code.tui.widgets.approval import ApprovalMenu
from types import SimpleNamespace


async def validate():
    assert nemoclaw_observability.initialize_observability() is False
    instance = app.DeepAgentsApp()
    for command in (
        "/update",
        "/install nvidia",
        "/auto-update",
        "/auth",
        "/connect",
        "/mcp login server",
        '/model openai:test --model-params {"api_key":"secret"}',
        "/rubric model anthropic:test",
        "/criteria model anthropic:test",
        "/goal model anthropic:test",
    ):
        await instance._handle_command(command)
    assert len(instance.original_commands) == 0, instance.original_commands
    await instance._handle_command("/help")
    assert instance.original_commands == ["/help"], instance.original_commands
    await instance._check_for_updates()
    assert instance._update_check_done.was_set
    await instance._handle_update_command()
    await instance._handle_install_command("/install nvidia")
    assert await instance._install_extra("nvidia") is False
    await instance._handle_install_package("package", force=True)
    await instance._handle_auto_update_toggle()
    await instance._switch_model(
        "openai:test", extra_kwargs={"api_key": "secret"}
    )
    assert instance.original_switch_kwargs is None
    instance._auto_approve = True
    await instance._on_auto_approve_enabled()
    assert instance._auto_approve is False
    instance._auto_approve = True
    await instance.action_toggle_auto_approve()
    assert instance._auto_approve is False
    await instance._set_rubric_model("anthropic:test")
    assert instance._rubric_model is None
    assert instance._server_kwargs["rubric_model"] is None
    await instance._prompt_launch_tavily()
    dep_continued, dep_result = await instance._prompt_launch_dependencies_then_model()
    assert dep_continued is False
    assert dep_result is None
    dep_screen, dep_future = instance._build_launch_dependencies_prompt()
    assert dep_screen is None
    assert dep_future.done()
    assert dep_future.result() == (False, None)
    assert await instance._prompt_model_auth_if_needed("provider:model") is False
    await instance._show_auth_manager(initial_provider="provider")
    await instance._enter_service_api_key(None, None)
    await instance._handle_update_action(None, None, None)
    instance._start_mcp_login("server")
    assert not instance.original_tavily
    assert not instance.original_auth_manager
    assert not instance.original_service_key
    assert not instance.original_update_action
    assert not instance.original_mcp_login
    assert instance.notifications

    approval = ApprovalMenu()
    approval._handle_selection(1)
    approval.action_select_auto()
    assert approval.decisions == []
    assert len(approval.notifications) == 2
    approval._handle_selection(0)
    assert approval.decisions == [("approve", None)]

    prompt = AuthPromptScreen()
    prompt.on_mount()
    assert prompt.dismissed == AuthResult.CANCELLED
    assert list(prompt.compose())[0].value.startswith("Credential entry is disabled")

    manager = AuthManagerScreen()
    manager.on_mount()
    assert manager.dismissed is None

    codex = CodexAuthScreen()
    codex.on_mount()
    assert codex.dismissed is False
    assert not codex.worker_started

    assert auth_store.load_credentials() == {}
    try:
        auth_store.set_stored_key("openai", "secret")
    except RuntimeError as exc:
        assert "credential storage is disabled" in str(exc)
    else:
        raise AssertionError("credential write was not blocked")

    success, message = await update_check._run_install_subprocess("uv", progress=None, log_path=None)
    assert success is False and "managed by NemoClaw" in message
    try:
        update_check.set_auto_update(True)
    except RuntimeError as exc:
        assert "managed by NemoClaw" in str(exc)
    else:
        raise AssertionError("auto-update write was not blocked")

    try:
        await openai_codex.run_browser_login()
    except RuntimeError as exc:
        assert "OAuth is disabled" in str(exc)
    else:
        raise AssertionError("OAuth login was not blocked")
    assert openai_codex.get_status().logged_in is False
    try:
        openai_codex.build_chat_model("gpt")
    except RuntimeError as exc:
        assert "OAuth is disabled" in str(exc)
    else:
        raise AssertionError("OAuth token use was not blocked")

    selector_notices = []
    selector = model_selector.ModelSelectorScreen()
    selector.app = SimpleNamespace(
        notify=lambda *args, **kwargs: selector_notices.append((args, kwargs))
    )
    model_selector.get_provider_auth_status = lambda provider: SimpleNamespace(blocks_start=True)
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection is None
    assert selector_notices
    model_selector.get_provider_auth_status = lambda provider: SimpleNamespace(blocks_start=False)
    config_manifest.INSTALL_EXTRA = "provider"
    config_manifest.PROVIDER_INSTALLED = False
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection is None
    config_manifest.INSTALL_EXTRA = None
    config_manifest.PROVIDER_INSTALLED = True
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection == ("openai:model", "openai")
    selector.original_selection = None
    selector._select_with_auth_check("anthropic:model", "anthropic")
    assert selector.original_selection is None

    assert config._parse_interpreter_ptc(["execute"]) is False
    assert agent._resolve_ptc_option(
        ["execute"], tools=[], acknowledge_unsafe=True, auto_approve=True
    ) is None
    assert agent.load_async_subagents(Path("/tmp/attacker-config.toml")) == []
    graph_kwargs = agent.create_cli_agent(
        object(),
        "assistant",
        rubric_model="anthropic:attacker",
        async_subagents=[{"url": "https://attacker.example"}],
    )
    assert graph_kwargs["rubric_model"] is None
    assert graph_kwargs["async_subagents"] is None
    assert subagents.list_subagents()[0]["model"] is None
    hook_marker = Path(${JSON.stringify(path.join(tempDir, "hook-ran"))})
    assert hooks._load_hooks() == []
    hooks._run_single_hook(["touch", str(hook_marker)], "session.start", b"{}")
    assert not hook_marker.exists()
    headless_kwargs = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        startup_cmd="touch /tmp/unsafe",
        model_params={"api_key": "secret"},
        profile_override={"attacker": True},
        sandbox_type="modal",
        mcp_config_path="mcp.json",
        no_mcp=False,
        trust_project_mcp=True,
        enable_interpreter=True,
        interpreter_ptc=["execute"],
        rubric_model="anthropic:attacker",
    )
    assert headless_kwargs["startup_cmd"] is None
    assert headless_kwargs["model_params"] is None
    assert headless_kwargs["profile_override"] is None
    assert headless_kwargs["sandbox_type"] == "none"
    assert headless_kwargs["mcp_config_path"] is None
    assert headless_kwargs["no_mcp"] is True
    assert headless_kwargs["trust_project_mcp"] is False
    assert headless_kwargs["enable_interpreter"] is False
    assert headless_kwargs["interpreter_ptc"] is None
    assert headless_kwargs["rubric_model"] is None
    assert non_interactive.settings.shell_allow_list is None
    if sys.platform == "linux":
        _nemoclaw_managed._MCP_CONFIG_FILE = Path(${JSON.stringify(managedMcpPath)})
    else:
        _nemoclaw_managed._MCP_CONFIG_FILE = Path(${JSON.stringify(
          path.join(tempDir, "absent-managed-mcp.json"),
        )})
    _nemoclaw_managed._MANAGED_MCP_FD = _nemoclaw_managed._MANAGED_MCP_BINDING = None
    _nemoclaw_managed._MANAGED_MCP_READY = False
    managed_args = dcode_main.parse_args()
    snapshot_mcp_path = managed_args.mcp_config
    if sys.platform == "linux":
        assert snapshot_mcp_path.startswith("/proc/self/fd/")
        assert Path(snapshot_mcp_path).is_file()
        assert instance._absolutize_launch_relative_path(
            snapshot_mcp_path, Path.cwd()
        ) == snapshot_mcp_path
        assert managed_args.no_mcp is False
    else:
        assert snapshot_mcp_path is None
        assert managed_args.no_mcp is True
    assert managed_args.trust_project_mcp is False
    managed_headless_kwargs = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        mcp_config_path="attacker.json",
        no_mcp=True,
        trust_project_mcp=True,
    )
    assert managed_headless_kwargs["mcp_config_path"] == snapshot_mcp_path
    assert managed_headless_kwargs["no_mcp"] is (sys.platform != "linux")
    assert managed_headless_kwargs["trust_project_mcp"] is False
    assert model_config.ModelConfig().get_class_path("openai") is None
    managed_kwargs = config._get_provider_kwargs("openai")
    assert managed_kwargs == {
        "api_key": "nemoclaw-managed-inference",
        "base_url": "https://inference.local/v1",
        "use_responses_api": False,
    }
    model_config.ModelConfig.base_url = "https://attacker.example/v1"
    assert config._get_provider_kwargs("openai")["base_url"] == "https://inference.local/v1"
    try:
        config._get_provider_kwargs("anthropic")
    except model_config.ModelConfigError as exc:
        assert "managed OpenAI-compatible provider" in str(exc)
    else:
        raise AssertionError("non-managed model provider was allowed")
    child_env = server._build_server_env()
    assert child_env["LANGGRAPH_NO_VERSION_CHECK"] == "true"
    assert child_env["OTEL_ENABLED"] == "false"
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" not in child_env
    assert "OTEL_EXPORTER_OTLP_HEADERS" not in child_env

    os.environ["OPENAI_BASE_URL"] = "https://attacker.example/v1"
    os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "false"
    os.environ["OTEL_ENABLED"] = "true"
    _nemoclaw_managed.assert_safe_runtime()
    assert os.environ["OPENAI_BASE_URL"] == "https://inference.local/v1"
    assert os.environ["LANGGRAPH_NO_VERSION_CHECK"] == "true"
    assert os.environ["OTEL_ENABLED"] == "false"

    project = Path(${JSON.stringify(tempDir)}) / "project"
    project.mkdir()
    (project / ".env").write_text("PROJECT_API_KEY=should-not-load\\n", encoding="utf-8")
    os.chdir(project)
    assert config._load_dotenv() is False
    assert "PROJECT_API_KEY" not in os.environ
    assert "PROJECT_API_KEY" not in config._preview_dotenv_environ()
    for name in (
        "LANGSMITH_TRACING",
        "LANGSMITH_TRACING_V2",
        "LANGCHAIN_TRACING",
        "LANGCHAIN_TRACING_V2",
    ):
        os.environ[name] = "true"
    assert config._tracing_enabled() is False

    state_dir = Path(${JSON.stringify(tempDir)}) / "state"
    state_dir.mkdir()
    _nemoclaw_managed._AUTH_FILE = state_dir / "auth.json"
    _nemoclaw_managed._CODEX_AUTH_FILE = state_dir / "chatgpt-auth.json"
    _nemoclaw_managed._AUTH_FILE.write_text(
        '{"version": 1, "credentials": {"openai": {"key": "secret"}}}',
        encoding="utf-8",
    )
    try:
        _nemoclaw_managed._assert_safe_auth_state()
    except RuntimeError as exc:
        assert "auth.json contains credentials" in str(exc)
    else:
        raise AssertionError("preexisting auth.json was not blocked")
    _nemoclaw_managed._AUTH_FILE.write_text(
        '{"version": 1, "credentials": {}}', encoding="utf-8"
    )
    _nemoclaw_managed._assert_safe_auth_state()
    _nemoclaw_managed._CODEX_AUTH_FILE.write_text("{}", encoding="utf-8")
    try:
        _nemoclaw_managed._assert_safe_auth_state()
    except RuntimeError as exc:
        assert "chatgpt-auth.json" in str(exc)
    else:
        raise AssertionError("preexisting ChatGPT OAuth store was not blocked")


asyncio.run(validate())
print("managed-boundaries-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-boundaries-ok");
  });

  it("fails closed when the installed version or required source shape drifts", () => {
    const wrongVersion = createPackageFixture("0.1.31");
    const versionResult = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: wrongVersion },
      encoding: "utf8",
    });
    expect(versionResult.status).not.toBe(0);
    expect(versionResult.stderr).toContain("Expected deepagents-code==0.1.34");

    const missingMethod = createPackageFixture();
    const appPath = path.join(missingMethod, "deepagents_code", "app.py");
    fs.writeFileSync(
      appPath,
      fs.readFileSync(appPath, "utf8").replace("_prompt_launch_tavily", "_renamed_tavily"),
      "utf8",
    );
    const shapeResult = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: missingMethod },
      encoding: "utf8",
    });
    expect(shapeResult.status).not.toBe(0);
    expect(shapeResult.stderr).toContain("_prompt_launch_tavily");
  });
});
