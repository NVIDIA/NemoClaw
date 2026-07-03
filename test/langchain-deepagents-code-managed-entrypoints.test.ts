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

function makeWrapperFixture(tempDir: string): { wrapperPath: string; ranMarker: string } {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const envFile = path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const fixture = readAgentFile("dcode-wrapper.sh")
    .replace(MANAGED_MCP_VALIDATOR_INVOCATION, 'managed_mcp_config=""')
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
    .replace('/opt/venv/bin/python3 -I - "$auth_file"', 'python3 -I - "$auth_file"')
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `touch "${ranMarker}"; printf 'dcode-tracing=%s,%s,%s,%s,%s,%s,%s,%s,%s openai-proxy=%s\\n' "$DEEPAGENTS_CODE_LANGSMITH_TRACING" "$DEEPAGENTS_CODE_LANGSMITH_TRACING_V2" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2" "$LANGSMITH_TRACING" "$LANGSMITH_TRACING_V2" "$LANGCHAIN_TRACING" "$LANGCHAIN_TRACING_V2" "$OTEL_ENABLED" "\${OPENAI_PROXY-__unset__}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, { mode: 0o755 });
  return { wrapperPath, ranMarker };
}

describe("LangChain Deep Agents Code managed entrypoints", () => {
  it("uses trusted privileged-mode Bash for every image entry script", () => {
    for (const name of ["dcode-launcher.sh", "dcode-wrapper.sh", "start.sh"]) {
      const source = readAgentFile(name);
      expect(source.startsWith("#!/bin/bash -p\n"), name).toBe(true);
      expect(source).toContain("unset BASH_ENV ENV");
    }
  });

  it("forces every LangChain and LangSmith tracing flag off across image boundaries", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const start = readAgentFile("start.sh");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const patcher = readAgentFile("patch-managed-deepagents-code.py");
    for (const name of TRACING_ENABLE_ENV_NAMES) {
      expect(dockerfile).toContain(`${name}=false`);
      expect(start).toContain(`export ${name}=false`);
      expect(wrapper).toContain(`export ${name}=false`);
      expect(patcher).toContain(`os.environ["${name}"] = "false"`);
    }
    expect(dockerfile).toContain("dcode-inference-base-url");
    expect(dockerfile).toContain("LANGGRAPH_NO_VERSION_CHECK=true");
    expect(start).toContain("export LANGGRAPH_NO_VERSION_CHECK=true");
    expect(wrapper).toContain("export LANGGRAPH_NO_VERSION_CHECK=true");
    expect(patcher).toContain('env["LANGGRAPH_NO_VERSION_CHECK"] = "true"');
  });

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

  it("overrides hostile tracing flags before the managed package starts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tracing-"));
    const { wrapperPath } = makeWrapperFixture(tempDir);
    const tracingEnv = Object.fromEntries(TRACING_ENABLE_ENV_NAMES.map((name) => [name, "true"]));
    const result = spawnSync("bash", [wrapperPath, "-n", "hi"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...tracingEnv },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "dcode-tracing=false,false,false,false,false,false,false,false,false",
    );
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
