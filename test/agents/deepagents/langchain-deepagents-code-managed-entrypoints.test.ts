// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const TRACING_ENABLE_ENV_NAMES = [
  "DEEPAGENTS_CODE_LANGSMITH_TRACING",
  "DEEPAGENTS_CODE_LANGSMITH_TRACING_V2",
  "DEEPAGENTS_CODE_LANGCHAIN_TRACING",
  "DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
  "OTEL_ENABLED",
] as const;

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

const MANAGED_MCP_VALIDATOR_INVOCATION = [
  'managed_mcp_config="$(',
  "  /opt/venv/bin/python3 -I -c \\",
  "    'from deepagents_code._nemoclaw_managed import managed_mcp_config_path; print(managed_mcp_config_path() or \"\")'",
  ')"',
].join("\n");

function writeAutoApprovalCapability(path: string, content?: string): void {
  const configuredContents = content === undefined ? [] : [content];
  for (const configuredContent of configuredContents) {
    fs.writeFileSync(path, configuredContent, { mode: 0o444 });
    fs.chmodSync(path, 0o444);
  }
}

function makeWrapperFixture(
  tempDir: string,
  autoApprovalContent?: string,
): { wrapperPath: string; ranMarker: string; autoApprovalPath: string } {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const autoApprovalPath = path.join(tempDir, "dcode-auto-approval");
  const envFile = path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const source = readAgentFile("dcode-wrapper.sh");
  expect(
    source,
    "managed MCP descriptors must be opened by the long-lived Python process",
  ).not.toContain(MANAGED_MCP_VALIDATOR_INVOCATION);
  const fixture = source
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_AUTH_FILE="/sandbox/.deepagents/.state/auth.json"',
      `readonly DEEPAGENTS_AUTH_FILE="${authFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_CODEX_AUTH_FILE="/sandbox/.deepagents/.state/chatgpt-auth.json"',
      `readonly DEEPAGENTS_CODEX_AUTH_FILE="${codexAuthFile}"`,
    )
    .replace(
      'readonly MANAGED_DCODE_AUTO_APPROVAL_FILE="/usr/local/share/nemoclaw/dcode-auto-approval"',
      `readonly MANAGED_DCODE_AUTO_APPROVAL_FILE="${autoApprovalPath}"`,
    )
    .replace(
      "readonly MANAGED_DCODE_AUTO_APPROVAL_OWNER_UID=0",
      `readonly MANAGED_DCODE_AUTO_APPROVAL_OWNER_UID=${process.getuid?.() ?? 0}`,
    )
    .replace('/opt/venv/bin/python3 -I - "$auth_file"', 'python3 -I - "$auth_file"')
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `touch "${ranMarker}"; printf 'dcode-tracing=%s,%s,%s,%s,%s,%s,%s,%s,%s analytics=%s openai-proxy=%s\\n' "$DEEPAGENTS_CODE_LANGSMITH_TRACING" "$DEEPAGENTS_CODE_LANGSMITH_TRACING_V2" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2" "$LANGSMITH_TRACING" "$LANGSMITH_TRACING_V2" "$LANGCHAIN_TRACING" "$LANGCHAIN_TRACING_V2" "$OTEL_ENABLED" "$LANGGRAPH_CLI_NO_ANALYTICS" "\${OPENAI_PROXY-__unset__}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  writeAutoApprovalCapability(autoApprovalPath, autoApprovalContent);
  fs.writeFileSync(wrapperPath, fixture, { mode: 0o755 });
  return { wrapperPath, ranMarker, autoApprovalPath };
}

describe("LangChain Deep Agents Code managed entrypoints", () => {
  it("uses loopback with a canonical DNS URL when the build validator has no route", () => {
    const validator = path.join(agentDir, "validate-read-only-mcp-call.py");
    const probe = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import errno, importlib.util, sys",
          'spec = importlib.util.spec_from_file_location("validator", sys.argv[1])',
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "class Probe:",
          "    def __enter__(self): return self",
          "    def __exit__(self, *_args): return False",
          "    def connect(self, _address): raise OSError(errno.ENETUNREACH, 'offline')",
          "module.socket.socket = lambda *_args: Probe()",
          "print(*module._validation_hosts())",
        ].join("\n"),
        validator,
      ],
      { encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe("127.0.0.1 localhost\n");
  });

  it("exposes only the fixed deterministic read-only MCP command (#9889)", () => {
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const command = readAgentFile("nemoclaw_read_only_mcp.py");
    const validator = readAgentFile("validate-read-only-mcp-call.py");

    expect(wrapper).toContain("list | call-read-only | help");
    expect(wrapper).toContain("dcode tools call-read-only TOOL --json");
    expect(wrapper).toContain(
      'exec /opt/venv/bin/python3 -I /usr/local/lib/nemoclaw/nemoclaw_read_only_mcp.py "$@" 2>/dev/null',
    );
    expect(wrapper).not.toContain("call-mutating");
    expect(command).toContain('_COMMAND = "tools call-read-only"');
    expect(validator).toContain("from mcp.server.fastmcp import FastMCP");
    expect(validator).toContain('"worker-broker_worker_task_context"');
    expect(validator).toContain('"output_attestation"');
    expect(validator).toContain('name="hanging"');
    expect(validator).toContain("openshell:resolve:env:v12_VALIDATION_MCP_TOKEN");
    expect(validator).not.toContain("unittest.mock");
  });

  it("keeps deterministic read-only MCP parsing bounded and structured (#9889)", () => {
    const commandPath = path.join(agentDir, "nemoclaw_read_only_mcp.py");
    const invalid = spawnSync("python3", [commandPath, "bad/tool", "--json"], {
      encoding: "utf8",
      input: "{}",
    });
    const help = spawnSync("python3", [commandPath, "--help"], { encoding: "utf8" });
    const oversized = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        'import importlib.util, sys; spec = importlib.util.spec_from_file_location("probe", sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); value = {"content": [{"nested": {"value": "x" * (module._MAX_OUTPUT_BYTES * 8)}}]};\ntry: module._redact_result(value)\nexcept module._CallError as exc: print(exc.code)',
        commandPath,
      ],
      { encoding: "utf8" },
    );
    const nonFinite = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        'import importlib.util, sys; spec = importlib.util.spec_from_file_location("probe", sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); codes = []\nfor value in (float("nan"), float("inf"), float("-inf")):\n try: module._redact_result({"value": value})\n except module._CallError as exc: codes.append(exc.code)\nassert codes == ["malformed_result"] * 3\nmodule._write_envelope({"ok": True, "value": float("nan")}, exit_code=0)',
        commandPath,
      ],
      { encoding: "utf8" },
    );

    expect(invalid.status, invalid.stderr).toBe(2);
    expect(invalid.stderr).toBe("");
    expect(JSON.parse(invalid.stdout)).toEqual({
      schema_version: 1,
      command: "tools call-read-only",
      data: {
        ok: false,
        status: "error",
        code: "invalid_tool_name",
        message: "The MCP tool name is invalid.",
      },
    });
    expect(Buffer.byteLength(invalid.stdout, "utf8")).toBeLessThanOrEqual(131_073);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("usage: dcode tools call-read-only TOOL --json");
    expect(oversized.status, oversized.stderr).toBe(0);
    expect(oversized.stdout.trim()).toBe("result_too_large");
    expect(nonFinite.status, nonFinite.stderr).toBe(1);
    expect(nonFinite.stderr).toBe("");
    expect(JSON.parse(nonFinite.stdout).data.code).toBe("malformed_result");
  });

  it.each(["dcode-launcher.sh", "dcode-wrapper.sh", "start.sh"])(
    "uses trusted privileged-mode Bash for every image entry script [case %#]",
    (name) => {
      const source = readAgentFile(name);
      expect(source.startsWith("#!/bin/bash -p\n"), name).toBe(true);
      expect(source).toContain("unset BASH_ENV ENV");
    },
  );

  it.each(TRACING_ENABLE_ENV_NAMES)(
    "forces every LangChain and LangSmith tracing flag off across image boundaries [case %#]",
    (name) => {
      const dockerfile = readAgentFile("Dockerfile");
      const start = readAgentFile("start.sh");
      const wrapper = readAgentFile("dcode-wrapper.sh");
      const patcher = readAgentFile("patch-managed-deepagents-code.py");

      expect(dockerfile).toContain(`${name}=false`);
      expect(start).toContain(`export ${name}=false`);
      expect(wrapper).toContain(`export ${name}=false`);
      expect(patcher).toContain(`os.environ["${name}"] = "false"`);

      expect(dockerfile).toContain("dcode-inference-base-url");
      expect(dockerfile).toContain("LANGGRAPH_NO_VERSION_CHECK=true");
      expect(dockerfile).toContain("LANGGRAPH_CLI_NO_ANALYTICS=1");
      expect(start).toContain("export LANGGRAPH_NO_VERSION_CHECK=true");
      expect(start).toContain("export LANGGRAPH_CLI_NO_ANALYTICS=1");
      expect(wrapper).toContain("export LANGGRAPH_NO_VERSION_CHECK=true");
      expect(wrapper).toContain("export LANGGRAPH_CLI_NO_ANALYTICS=1");
      expect(patcher).toContain('os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"');
      expect(patcher).toContain('env["LANGGRAPH_NO_VERSION_CHECK"] = "true"');
      expect(patcher).toContain('env["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"');
    },
  );

  it("does not serialize provider or optional-service secrets into the shell env file", () => {
    const start = readAgentFile("start.sh");
    expect(start).toContain('chmod 444 "$tmp"');
    expect(start).toContain("write_export_if_set HTTPS_PROXY");
    expect(start).not.toContain("write_proxy_export_pair");
    expect(start).toContain("export DEEPAGENTS_CODE_OFFLINE=1");
    expect(start).toContain("export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system");
    expect(start).not.toContain("write_export_if_set DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(start).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(start).not.toMatch(
      /write_export_if_set (?:NVIDIA_API_KEY|OPENAI_API_KEY|TAVILY_API_KEY|DEEPAGENTS_CODE_TAVILY_API_KEY|LANGSMITH_API_KEY|LANGSMITH_TRACING|LANGSMITH_PROJECT|DEEPAGENTS_CODE_LANGSMITH_PROJECT)\b/,
    );
  });

  it("overrides hostile tracing and analytics flags before the managed package starts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tracing-"));
    const { wrapperPath } = makeWrapperFixture(tempDir);
    const tracingEnv = Object.fromEntries(TRACING_ENABLE_ENV_NAMES.map((name) => [name, "true"]));
    const result = spawnSync("bash", [wrapperPath, "-n", "hi"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANGGRAPH_CLI_NO_ANALYTICS: "0",
        ...tracingEnv,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "dcode-tracing=false,false,false,false,false,false,false,false,false",
    );
    expect(result.stdout).toContain("analytics=1");
  });

  it.each([
    "LANGSMITH_RUNS_ENDPOINTS",
    "LANGCHAIN_RUNS_ENDPOINTS",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ])("rejects credential-bearing tracing replica configuration in %s", (name) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tracing-runs-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const result = spawnSync("bash", [wrapperPath, "-n", "hi"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        [name]: '{"https://trace.example":"opaque-key-value"}',
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { args: ["--model-params", '{"api_key":"secret"}'], posture: "model parameter" },
    { args: ['--model-p={"api_key":"secret"}'], posture: "model parameter" },
    { args: ["--rubric-model", "anthropic:test"], posture: "rubric model" },
    { args: ["--rubric-m=anthropic:test"], posture: "rubric model" },
    { args: ["--interpreter"], posture: "interpreter" },
    { args: ["--interpreter-tools", "execute"], posture: "interpreter" },
    { args: ["--interpreter-t=execute"], posture: "interpreter" },
    { args: ["-y"], posture: "tool approval" },
    { args: ["--auto-approve"], posture: "tool approval" },
    { args: ["--acp"], posture: "ACP approval" },
    { args: ["--startup-cmd", "touch /tmp/unsafe"], posture: "startup command" },
    { args: ["--startup-cmd=touch /tmp/unsafe"], posture: "startup command" },
  ])("rejects managed runtime override $args", ({ args, posture }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-override-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const result = spawnSync("bash", [wrapperPath, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(posture);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    "-y",
    "--auto-a",
    "--auto-ap",
    "--auto-app",
    "--auto-appr",
    "--auto-appro",
    "--auto-approv",
    "--auto-approve",
  ])(
    "allows explicit thread auto-approval through %s only in thread-opt-in mode (#6478)",
    (arg) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auto-opt-in-"));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir, "thread-opt-in\n");
      const result = spawnSync("bash", [wrapperPath, arg], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NEMOCLAW_DCODE_AUTO_APPROVAL: "disabled",
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(ranMarker)).toBe(true);
    },
  );

  it("keeps non-interactive argument scanning fail-closed around auto-approval (#6478)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auto-headless-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir, "thread-opt-in\n");
    const enabled = spawnSync("bash", [wrapperPath, "-n", "hi", "--auto-approve"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });

    expect(enabled.status, enabled.stderr).toBe(0);
    expect(fs.existsSync(ranMarker)).toBe(true);

    const disabledTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-dcode-auto-headless-disabled-"),
    );
    const disabledFixture = makeWrapperFixture(disabledTempDir);
    const disabled = spawnSync(
      "bash",
      [disabledFixture.wrapperPath, "-n", "hi", "--auto-approve"],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      },
    );

    expect(disabled.status).not.toBe(0);
    expect(disabled.stderr).toContain("tool approval");
    expect(fs.existsSync(disabledFixture.ranMarker)).toBe(false);
  });

  it.each([
    { label: "ambient only", prepare: (_path: string) => undefined },
    {
      label: "malformed",
      prepare: (capabilityPath: string) => {
        fs.writeFileSync(capabilityPath, "thread-opt-in");
        fs.chmodSync(capabilityPath, 0o444);
      },
    },
    {
      label: "writable",
      prepare: (capabilityPath: string) => {
        fs.writeFileSync(capabilityPath, "thread-opt-in\n");
        fs.chmodSync(capabilityPath, 0o644);
      },
    },
    {
      label: "symlinked",
      prepare: (capabilityPath: string) => {
        const target = `${capabilityPath}-target`;
        fs.writeFileSync(target, "thread-opt-in\n", { mode: 0o444 });
        fs.symlinkSync(target, capabilityPath);
      },
    },
  ])(
    "fails closed for ambient, malformed, symlinked, and writable auto-approval state [$label] (#6478)",
    ({ label, prepare }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auto-unsafe-"));
      const { wrapperPath, ranMarker, autoApprovalPath } = makeWrapperFixture(tempDir);
      prepare(autoApprovalPath);
      const result = spawnSync("bash", [wrapperPath, "-y"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NEMOCLAW_DCODE_AUTO_APPROVAL: "thread-opt-in",
          NEMOCLAW_DCODE_AUTO_APPROVAL_ENABLED: "1",
        },
        encoding: "utf8",
      });

      expect(result.status, `${label}: ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain("tool approval posture");
      expect(fs.existsSync(ranMarker)).toBe(false);
    },
  );

  it("removes an inherited OpenAI-specific proxy before the managed package starts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-openai-proxy-"));
    const { wrapperPath } = makeWrapperFixture(tempDir);
    const result = spawnSync("bash", [wrapperPath, "-n", "hi"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OPENAI_PROXY: "http://user:password@attacker.example:8080",
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("openai-proxy=__unset__");
  });

  it("ignores hostile PATH and BASH_ENV before wrapper normalization", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-shell-entry-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeBin = path.join(tempDir, "fake-bin");
    const fakeBashMarker = path.join(tempDir, "fake-bash-ran");
    const bashEnvMarker = path.join(tempDir, "bash-env-ran");
    const bashEnv = path.join(tempDir, "hostile-bash-env.sh");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "bash"),
      `#!/bin/sh\ntouch ${JSON.stringify(fakeBashMarker)}\nexit 91\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(bashEnv, `touch ${JSON.stringify(bashEnvMarker)}\nexit 92\n`, "utf8");

    const result = spawnSync(wrapperPath, ["-n", "hi"], {
      env: { PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`, BASH_ENV: bashEnv },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ranMarker)).toBe(true);
    expect(fs.existsSync(fakeBashMarker)).toBe(false);
    expect(fs.existsSync(bashEnvMarker)).toBe(false);
  });
});
