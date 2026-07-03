// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { CONTEXT_PATTERNS, TOKEN_PREFIX_PATTERNS } from "../src/lib/security/secret-patterns.ts";
import { cloudExperimentalChecksForOnboarding } from "./e2e/live/cloud-experimental-check-list.ts";
import {
  DCODE_CANONICAL_PATH,
  headlessCheckPath,
  makeStartScriptFixture as makeHeadlessStartScriptFixture,
  NO_PROXY_ENV_NAMES,
  PROXY_URL_ENV_NAMES,
  runHeadlessCheckHelper,
  runStartScriptProxyProbe,
  TRACING_ENABLE_ENV_NAMES,
} from "./helpers/langchain-deepagents-code-headless.ts";
import { makeStartScriptFixture as makeIdentityStartScriptFixture } from "./support/dcode-start-script-fixture.ts";

function fingerprint(patterns: readonly RegExp[]): string[] {
  return patterns.map((re) => `${re.source}::${re.flags}`);
}

function containsTokenShapedSecret(value: string): boolean {
  return TOKEN_PREFIX_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

function fakePrivateKeyBlock(type = "", newline = "\\n"): string {
  const label = type ? `${type} PRIVATE KEY-----` : "PRIVATE KEY-----";
  return `-----BEGIN ${label} ${newline}opaque-test-body${newline}-----END ${label}`;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const tuiStartupCheckPath = path.join(
  repoRoot,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "10-deepagents-code-tui-startup.sh",
);

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

const MANAGED_MCP_VALIDATOR_INVOCATION = [
  'managed_mcp_config="$(',
  "  /opt/venv/bin/python3 -I -c \\",
  "    'from deepagents_code._nemoclaw_managed import managed_mcp_config_path; print(managed_mcp_config_path() or \"\")'",
  ')"',
].join("\n");

function stubManagedMcpValidator(source: string): string {
  expect(source).toContain(MANAGED_MCP_VALIDATOR_INVOCATION);
  return source.replace(MANAGED_MCP_VALIDATOR_INVOCATION, 'managed_mcp_config=""');
}

function makeWrapperFixture(
  tempDir: string,
  envFileOverride?: string,
): {
  wrapperPath: string;
  ranMarker: string;
  envFile: string;
  authFile: string;
  codexAuthFile: string;
} {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const envFile = envFileOverride ?? path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const fixture = stubManagedMcpValidator(readAgentFile("dcode-wrapper.sh"))
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
      `touch "${ranMarker}"; echo dcode-stub-ran; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, ranMarker, envFile, authFile, codexAuthFile };
}

function makeNetworkSimulatingFixture(tempDir: string): {
  wrapperPath: string;
  networkLog: string;
  envFile: string;
} {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const networkLog = path.join(tempDir, "network.log");
  const envFile = path.join(tempDir, ".env");
  const fixture = stubManagedMcpValidator(readAgentFile("dcode-wrapper.sh"))
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `printf 'NET:OPEN inference.local/v1/chat\\nNET:OPEN pypi.org/simple\\nNET:OPEN api.openai.com/v1\\n' > "${networkLog}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, networkLog, envFile };
}

function runWrapper(
  wrapperPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [wrapperPath, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
}

function policyBinaryPaths(policyText: string, policyName: string): string[] {
  const parsed = YAML.parse(policyText) as {
    network_policies?: Record<string, { binaries?: Array<{ path?: unknown }> }>;
  };
  const binaries = parsed.network_policies?.[policyName]?.binaries;
  expect(Array.isArray(binaries), `${policyName} policy must declare binary-scoped egress`).toBe(
    true,
  );
  return (binaries ?? []).map((entry, index) => {
    expect(typeof entry.path, `${policyName} binary #${index} must declare a string path`).toBe(
      "string",
    );
    return entry.path as string;
  });
}

describe("LangChain Deep Agents Code image contracts", () => {
  it("hardens copied NemoClaw blueprints against sandbox-user mutation", () => {
    const dockerfile = readAgentFile("Dockerfile");

    expect(dockerfile).toContain("ARG BASE_IMAGE\n");
    expect(dockerfile).not.toContain("langchain-deepagents-code-sandbox-base:latest");
    expect(dockerfile).toContain("chown root:root /sandbox/.nemoclaw");
    expect(dockerfile).toContain("chmod 1755 /sandbox/.nemoclaw");
    expect(dockerfile).toContain("chown -R root:root /sandbox/.nemoclaw/blueprints");
    expect(dockerfile).toContain("chmod -R 755 /sandbox/.nemoclaw/blueprints");
    expect(dockerfile.indexOf("cp -r /opt/nemoclaw-blueprint/*")).toBeLessThan(
      dockerfile.indexOf("chown -R root:root /sandbox/.nemoclaw/blueprints"),
    );
    expect(dockerfile.trimEnd()).toMatch(
      /USER sandbox\nENTRYPOINT \["\/usr\/local\/bin\/nemoclaw-start"\]\nCMD \["\/bin\/bash"\]$/,
    );
  });

  it("does not wire unsupported messaging artifacts into the DeepAgents image", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const startScript = readAgentFile("start.sh");

    expect(dockerfile).not.toContain("NEMOCLAW_MESSAGING_PLAN_B64");
    expect(dockerfile).not.toContain("messaging-build-applier.mts");
    expect(startScript).toContain("Setting up NemoClaw Deep Agents Code runtime");
    expect(startScript).not.toContain("load_messaging_env");
    expect(startScript).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(startScript).not.toContain("DISCORD_BOT_TOKEN");
    expect(startScript).not.toContain("SLACK_BOT_TOKEN");
  });

  it("prints NemoClaw setup output before idling as a terminal runtime", () => {
    const startScript = readAgentFile("start.sh");

    expect(startScript).toContain("Setting up NemoClaw Deep Agents Code runtime");
    expect(startScript).toContain("exec tail -f /dev/null");
    expect(startScript).not.toContain("exec sleep infinity");
  });

  it("sources the managed runtime environment in interactive and login shells (#6191)", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const sourceLine = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";

    expect(baseDockerfile.split(sourceLine)).toHaveLength(3);
    expect(baseDockerfile).toContain("> /sandbox/.bashrc");
    expect(baseDockerfile).toContain("> /sandbox/.profile");
  });

  it("serializes the sandbox name into the shell env file for in-sandbox identity", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    try {
      const { envFile, scriptPath } = makeIdentityStartScriptFixture(tempDir);

      execFileSync("bash", [scriptPath, "sh", "-c", ":"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NEMOCLAW_SANDBOX_NAME: "dcode-demo",
        },
        encoding: "utf8",
      });

      expect(fs.readFileSync(envFile, "utf8")).toContain("export NEMOCLAW_SANDBOX_NAME=dcode-demo");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces inherited host proxy values with the managed runtime proxy (#6191)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, scriptPath } = makeHeadlessStartScriptFixture(
      tempDir,
      readAgentFile("start.sh"),
    );
    const inheritedSecrets = {
      NVIDIA_API_KEY: `nvapi-${"A".repeat(10)}`,
      OPENAI_API_KEY: `sk-${"B".repeat(20)}`,
      LANGSMITH_API_KEY: `lsv2_pt_${"C".repeat(36)}_${"D".repeat(10)}`,
      LANGSMITH_TRACING: `lsv2_sk_${"I".repeat(36)}_${"J".repeat(10)}`,
      LANGSMITH_PROJECT: `lsv2_pt_${"E".repeat(36)}_${"F".repeat(10)}`,
      DEEPAGENTS_CODE_LANGSMITH_PROJECT: `lsv2_sk_${"G".repeat(36)}_${"H".repeat(10)}`,
    };
    const inheritedTracingFlags = Object.fromEntries(
      TRACING_ENABLE_ENV_NAMES.map((name) => [name, "true"]),
    );
    const { envFileText, output } = runStartScriptProxyProbe(scriptPath, envFile, {
      HTTP_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      HTTPS_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      NO_PROXY: "corp.internal,inference.local",
      http_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      https_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      no_proxy: "corp.internal,inference.local",
      ALL_PROXY: "socks5://all-user:all-password@all-proxy.example:1080",
      all_proxy: "socks5://lower-all-user:lower-all-password@lower-all-proxy.example:1080",
      OPENAI_PROXY: "http://openai-user:openai-password@attacker.example:8080",
      ...inheritedSecrets,
      ...inheritedTracingFlags,
    });
    const managedProxy = "http://10.200.0.1:3128";
    const managedNoProxy = "localhost,127.0.0.1,::1,10.200.0.1";
    const outputLines = output.trimEnd().split("\n");
    const envFileLines = envFileText.trimEnd().split("\n");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o444);
    expect(envFileText).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    for (const name of PROXY_URL_ENV_NAMES) {
      expect(outputLines).toContain(`RUNTIME_${name}=${managedProxy}`);
      expect(outputLines).toContain(`SOURCED_${name}=${managedProxy}`);
      expect(envFileLines).toContain(`export ${name}=${managedProxy}`);
    }
    for (const name of NO_PROXY_ENV_NAMES) {
      expect(outputLines).toContain(`RUNTIME_${name}=${managedNoProxy}`);
      expect(outputLines).toContain(`SOURCED_${name}=${managedNoProxy}`);
      expect(envFileLines).toContain(`export ${name}=${managedNoProxy.replaceAll(",", "\\,")}`);
    }
    for (const name of TRACING_ENABLE_ENV_NAMES) {
      expect(outputLines).toContain(`RUNTIME_${name}=false`);
      expect(outputLines).toContain(`SOURCED_${name}=false`);
      expect(envFileLines).toContain(`export ${name}=false`);
    }
    expect(envFileLines).toContain("unset ALL_PROXY all_proxy OPENAI_PROXY");
    expect(
      outputLines.filter((line) => /^(?:RUNTIME|SOURCED)_(?:NO_PROXY|no_proxy)=/.test(line)),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("inference.local")]));
    expect(envFileLines.filter((line) => /^export (?:NO_PROXY|no_proxy)=/.test(line))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("inference.local")]),
    );
    const combined = `${output}\n${envFileText}`;
    expect(containsTokenShapedSecret(inheritedSecrets.LANGSMITH_API_KEY)).toBe(true);
    expect(containsTokenShapedSecret(envFileText)).toBe(false);
    for (const secret of Object.values(inheritedSecrets)) {
      expect(envFileText).not.toContain(secret);
    }
    expect(combined).not.toContain("proxy.example");
    expect(combined).not.toContain("user");
    expect(combined).not.toContain("password");
    expect(combined).not.toContain("corp.internal");
  });

  it("keeps all Deep Agents Code entry points behind the managed wrapper boundary", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const launcher = readAgentFile("dcode-launcher.sh");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const policy = readAgentFile("policy-additions.yaml");

    expect(dockerfile).not.toContain("NEMOCLAW_WEB_SEARCH_ENABLED");
    expect(dockerfile).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(dockerfile).not.toContain("dcode.upstream");
    expect(wrapper).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(wrapper).toContain("unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(wrapper).toContain("deepagents-code==0.1.30");
    expect(wrapper).toContain("Schema pin");
    expect(wrapper).toContain("truthy top-level");
    expect(wrapper).toContain("unset PYTHONHOME PYTHONPATH");
    expect(wrapper).toContain('/opt/venv/bin/python3 -I - "$auth_file"');
    expect(wrapper).toContain("exec /opt/venv/bin/python3 -I -m deepagents_code");
    expect(wrapper).toContain("extra_args=(--sandbox none)");
    expect(wrapper).toContain('extra_args+=(--mcp-config "$managed_mcp_config")');
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
    expect(wrapper).toContain("extra_args+=(--no-mcp)");
    expect(wrapper).toContain("assert_no_auth_store_credentials");
    expect(wrapper).toContain("assert_no_codex_auth_credentials");
    for (const s of [
      "export DEEPAGENTS_CODE_LANGSMITH_TRACING=false",
      "export LANGSMITH_TRACING=false",
      "export DEEPAGENTS_CODE_OFFLINE=1",
      "export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system",
      'reject_managed_override "dependency update posture"',
      'reject_managed_override "credential posture"',
      'reject_managed_override "managed tool set posture"',
      'reject_managed_override "sandbox isolation"',
      'reject_managed_override "MCP posture"',
      'reject_managed_override "shell allow-list posture"',
    ]) {
      expect(wrapper).toContain(s);
    }
    for (const s of [
      "patch-managed-deepagents-code.py",
      "DEEPAGENTS_CODE_LANGSMITH_TRACING=false",
      "LANGSMITH_TRACING=false",
      "DEEPAGENTS_CODE_OFFLINE=1",
      "DEEPAGENTS_CODE_RIPGREP_INSTALLER=system",
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/dcode.real",
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/deepagents-code",
    ]) {
      expect(dockerfile).toContain(s);
    }
    expect(dockerfile).toContain(
      "rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code /opt/venv/bin/dcode /opt/venv/bin/deepagents-code",
    );
    expect(launcher).toContain('exec "$MANAGED_DCODE_WRAPPER" "$@"');
    expect(policy).not.toContain("/usr/local/bin/dcode.real");
    expect(policy).not.toContain("dcode.upstream");
  });

  it("exposes an exact managed MCP capability marker without starting dcode", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mcp-capability-"));
    try {
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["--nemoclaw-mcp-capability"], {});

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n");
      expect(fs.existsSync(ranMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the pinned Deep Agents Code user-level MCP discovery path", () => {
    const requirements = readAgentFile("requirements.lock");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const patcher = readAgentFile("patch-managed-deepagents-code.py");
    const manifest = readAgentFile("manifest.yaml");
    const userLevelPath = "/sandbox/.deepagents/.mcp.json";

    // The pinned Deep Agents Code release discovers ~/.deepagents/.mcp.json as user-level
    // config. /sandbox/.mcp.json is project-level and headless `dcode -n`
    // rejects it unless the project trust gate has been satisfied.
    expect(requirements).toContain("deepagents-code==0.1.30");
    expect(wrapper).toContain("managed_mcp_config_path");
    expect(patcher).toContain(`_MCP_CONFIG_FILE = Path("${userLevelPath}")`);
    expect(patcher).toContain("managed_mcp_config = _nemoclaw_managed_mcp_config_path()");
    expect(manifest).toContain("- .deepagents/.mcp.json");
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
    expect(patcher).not.toContain('managed_mcp_config = "/sandbox/.mcp.json"');
  });

  it("puts the managed Python venv before system Python in every dcode entry path", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const dockerfile = readAgentFile("Dockerfile");
    const startScript = readAgentFile("start.sh");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const pathContractFiles = [baseDockerfile, dockerfile, startScript, wrapper].join("\n");

    expect(baseDockerfile).toContain("VIRTUAL_ENV=/opt/venv");
    expect(dockerfile).toContain("VIRTUAL_ENV=/opt/venv");
    expect(baseDockerfile).toContain(`PATH="${DCODE_CANONICAL_PATH}"`);
    expect(dockerfile).toContain(`PATH="${DCODE_CANONICAL_PATH}"`);
    expect(startScript).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expect(startScript).toContain(`printf '%s\\n' 'export PATH="${DCODE_CANONICAL_PATH}"'`);
    expect(wrapper).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expect(pathContractFiles).not.toContain('PATH="/usr/local/bin:${PATH}"');
  });

  it("keeps optional service egress out of the default policy and requires Landlock", () => {
    const policy = readAgentFile("policy-additions.yaml");

    expect(policy).not.toContain("api.tavily.com");
    expect(policy).not.toContain("api.smith.langchain.com");
    expect(policy).toContain("    - /usr\n");
    expect(policy).toContain("    - /opt/venv\n");
    expect(policy).toContain("    - /etc\n");
    expect(policy).toContain("compatibility: strict");
    expect(policy).not.toContain("compatibility: best_effort");
    expect(policy).toContain("fail closed when Landlock cannot be applied");
    expect(policy).toContain("silently degrading");
    expect(policy).toContain("observes Python module traffic from dcode as the Python");
    expect(policy).toContain("process-wide only for the read-only PyPI hosts");
    expect(policy).toContain(
      "Tavily, LangSmith, MCP, and arbitrary hosts are intentionally absent",
    );

    const githubBinaries = policyBinaryPaths(policy, "github");
    expect(githubBinaries).toEqual(
      expect.arrayContaining(["/usr/bin/git", "/usr/local/bin/dcode", "/opt/venv/bin/python3*"]),
    );
    expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/bin/python3*"]));
    expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/python3*"]));
    expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/local/lib/python3.13/**"]));

    const pypiBinaries = policyBinaryPaths(policy, "pypi");
    expect(pypiBinaries).toEqual(
      expect.arrayContaining([
        "/opt/venv/bin/pip3",
        "/sandbox/**/bin/pip3",
        "/opt/venv/bin/python3*",
        "/sandbox/**/bin/python3*",
        "/usr/local/bin/dcode",
      ]),
    );
    expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/bin/python3*"]));
    expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/python3*"]));
    expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/pip3"]));
    expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/lib/python3.13/**"]));
  });

  it("ships live policy behavior checks for Deep Agents Code", () => {
    const landlockCheck = fs.readFileSync(
      path.join(
        process.cwd(),
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "05-deepagents-code-landlock-readonly.sh",
      ),
      "utf8",
    );
    const pythonEgressCheck = fs.readFileSync(
      path.join(
        process.cwd(),
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "06-deepagents-code-python-egress.sh",
      ),
      "utf8",
    );
    const secretBoundaryCheck = fs.readFileSync(
      path.join(
        process.cwd(),
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "08-deepagents-code-secret-boundary.sh",
      ),
      "utf8",
    );
    const tuiStartupCheck = fs.readFileSync(tuiStartupCheckPath, "utf8");

    for (const expected of [
      "test -d /sandbox/.deepagents && command -v dcode",
      "touch /sandbox/.deepagents/deepagents-landlock-test",
      "touch /usr/deepagents-landlock-test",
      "touch /opt/venv/deepagents-landlock-test",
      "touch /etc/deepagents-landlock-test",
      "touch /tmp/deepagents-landlock-test",
      "/usr is Landlock read-only for Deep Agents Code",
      "/opt/venv is Landlock read-only for Deep Agents Code",
      "/etc is Landlock read-only for Deep Agents Code",
    ]) {
      expect(landlockCheck).toContain(expected);
    }
    expect(pythonEgressCheck).toContain(`DCODE_CANONICAL_PATH="${DCODE_CANONICAL_PATH}"`);
    expect(pythonEgressCheck).not.toContain("mktemp");
    for (const expected of [
      'grep -Fxq "PATH=${DCODE_CANONICAL_PATH}"',
      'printf "PYTHON_REAL=%s\\n"',
      "^PYTHON=/opt/venv/bin/python3$",
      "^PIP=/opt/venv/bin/pip3$",
      "^USRLOCAL_COUNT=1$",
      "import urllib.error",
      "except urllib.error.HTTPError as exc:",
      "except urllib.error.URLError as exc:",
      "ERROR:URLError",
      "lacked denial evidence",
      "python_probe_source",
      "base64 | tr -d",
      "base64 -d",
      "${python_bin@Q} -c",
      "${url@Q}",
      'expect_reached "arbitrary Python" "GitHub" "https://api.github.com/"',
      'expect_reached "arbitrary Python" "PyPI" "https://pypi.org/"',
      'PROJECT_VENV="/sandbox/.nemoclaw-e2e-project-venv"',
      "python3 -m venv --copies",
      'expect_reached "project venv Python under /sandbox" "PyPI" "https://pypi.org/" "$PROJECT_PYTHON"',
      'expect_reached "project venv Python under /sandbox" "files.pythonhosted.org" "https://files.pythonhosted.org/" "$PROJECT_PYTHON"',
      'expect_blocked "project venv Python under /sandbox" "Tavily" "https://api.tavily.com/" "$PROJECT_PYTHON"',
      "https://api.tavily.com/",
      "https://api.smith.langchain.com/",
      "https://modelcontextprotocol.io/",
      "https://example.com/",
      "${actor} cannot reach ${label} without explicit policy",
    ]) {
      expect(pythonEgressCheck).toContain(expected);
    }
    for (const expected of [
      "Case: Deep Agents Code dcode secret boundary",
      "env OPENAI_API_KEY=",
      "dcode -n 'Reply with the single word PING'",
      "dcode_secret_probe_runtime_env",
      "dcode_secret_probe_env_file",
      "remote_cmd=",
      "LOG_MARKER_FOUND:%s",
      "OpenShell rejects newline-bearing exec",
      "NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST",
      "NO_NEWLINE_IN_COMMAND",
      "DCODE_EXIT:%s\\\\n",
      "DCODE_EXIT:0",
      "refusing to start",
      "NETWORK_LOG_PATTERN=",
      "AUDIT_NETWORK_LOG_PATTERN=",
      "NET:OPEN|inference\\\\.local|pypi\\\\.org",
      "integrate\\\\.api\\\\.nvidia\\\\.com",
      "/tmp/gateway.log",
      "/tmp/nemoclaw-start.log",
      "ocsf_json_enabled",
      'openshell logs "$SANDBOX_NAME" -n 500 --source all --since 2m',
      "AUDIT_LOG_READ:1",
      "LOG_MARKER_FOUND:1",
      "assert_no_rejected_interval_audit_logs",
      "assert_no_rejected_interval_network_logs",
      "sha256sum ${DEEPAGENTS_ENV_FILE@Q}",
    ]) {
      expect(secretBoundaryCheck).toContain(expected);
    }
    expect(tuiStartupCheck).toContain("Case: Deep Agents Code interactive TUI startup");
    expect(tuiStartupCheck).not.toContain("-nocase -re {(deep agents|");
    expect(tuiStartupCheck.indexOf("local expect_rc")).toBeLessThan(
      tuiStartupCheck.indexOf('run_tui_expect "$raw_capture_file"'),
    );
    for (const expected of [
      "test -d /sandbox/.deepagents && command -v dcode",
      "expect <<'EXPECT'",
      "set cmd [list openshell sandbox exec --name $sandbox --tty -- sh -lc",
      "spawn {*}$cmd",
      "NEMOCLAW_DCODE_PROBE:deepagents",
      "NEMOCLAW_DCODE_PROBE:other",
      "unable to probe sandbox",
      "unexpected sandbox probe output",
      "cd /sandbox; dcode",
      'NEMOCLAW_TUI_ONBOARDING_PATTERN="$TUI_ONBOARDING_PATTERN"',
      "-nocase -re $onboarding_pattern",
      'append_marker $markers "NEMOCLAW_TUI_ONBOARDING_SKIPPED"',
      'send -- "\\033"',
      "if {$saw_onboarding}",
      'send -- "\\003"\nafter 250\ncatch {send -- "\\003"}',
      'append_marker $markers "$expect_out(0,string)"',
      'append_marker $markers "NEMOCLAW_TUI_READY"',
      'append_marker $markers "NEMOCLAW_TUI_TIMEOUT"',
      'append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_READY"',
      'append_marker $markers "NEMOCLAW_TUI_EXIT_CAPTURED:$expect_out(1,string)"',
      'append_marker $markers "NEMOCLAW_TUI_EXIT_TIMEOUT"',
      'append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_EXIT"',
      'NEMOCLAW_TUI_MARKERS="$marker_capture_file"',
      'cat "$raw_capture_file" "$expect_log_file" "$marker_capture_file"',
      'print_sanitized_capture_excerpt "$plain_capture_file"',
      "DEEPAGENTS_TUI_TIMEOUT must be a positive integer",
      "strip_terminal_control_sequences",
      "is_tui_ready_capture",
      "redact_secrets_in_file",
      "trap cleanup_sensitive_captures EXIT",
      "cleanup_sensitive_captures",
      "${PREFIX}.sanitized.log",
      "secret-shaped value found in sanitized TUI capture",
      "nvapi-",
      "sk-",
    ]) {
      expect(tuiStartupCheck).toContain(expected);
    }
    const tavilyOptInCheck = fs.readFileSync(
      path.join(
        process.cwd(),
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "09-deepagents-code-tavily-opt-in.sh",
      ),
      "utf8",
    );
    for (const expected of [
      "policy-add tavily --dry-run",
      "policy-add tavily --yes",
      /urllib\.request\.Request[\s\S]*method='POST'/,
      "python_probe_source",
      "base64 | tr -d",
      "${python_bin@Q} -c",
      "NEMOCLAW_E2E_TAVILY_SELF_TEST",
      "/opt/venv/",
      "managed Deep Agents Code python can reach Tavily",
      /python_probe .*api\.tavily\.com\/search.*python3/,
      "system Python remains blocked from Tavily after policy-add",
      "/sandbox/.nemoclaw-e2e-project-venv",
      "project venv Python under /sandbox remains blocked from Tavily after policy-add",
    ]) {
      expect(tavilyOptInCheck).toMatch(expected);
    }
    expect(cloudExperimentalChecksForOnboarding("cloud-langchain-deepagents-code")).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
      "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
    ]);
  });

  it("ships a headless inference acceptance check for Deep Agents Code", () => {
    const headlessCheck = fs.readFileSync(headlessCheckPath, "utf8");

    for (const expected of [
      'sandbox_exec "test -d /sandbox/.deepagents"',
      "command -v dcode",
      "dcode -n 'Reply with exactly one word: PONG'",
      "sandbox_login_exec",
      "sandbox_login_proxy_contract",
      "-u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY",
      "-u ALL_PROXY -u all_proxy",
      "-u http_proxy -u https_proxy -u no_proxy",
      'HOME=/sandbox bash -lc "$1"',
      'bash -lc "$1"',
      "NEMOCLAW_DCODE_PROXY_ENV_OK",
      "local contract_command",
      'sandbox_login_exec "$contract_command"',
      "sandbox_direct_dcode",
      '-- dcode "$@"',
      "sandbox_dcode_wrapper_contract",
      "NEMOCLAW_DCODE_WRAPPER_CHAIN_OK",
      "nemoclaw_connect_probe",
      "${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}",
      "connect --probe-only 2>&1",
      "direct-exec dcode -n reached managed inference",
      "connect --probe-only accepted the managed inference route",
      'sandbox_login_exec "cd /sandbox',
      "https://inference.local/v1/models",
      "HTTP_CODE:%{http_code}",
      '[ "$route_code" = "200" ]',
      "https://inference\\.local(/v1)?",
      "references_managed_placeholder_key",
      'api_key_env[[:space:]]*=[[:space:]]*"DEEPAGENTS_CODE_OPENAI_API_KEY"',
      "classify_headless_output",
      "NEMOCLAW_DCODE_DNS_PROBE_MISSING_GETENT",
      "required DNS diagnostic tool getent is unavailable",
      "NEMOCLAW_DCODE_DNS_PROBE_MISSING_TIMEOUT",
      "required DNS diagnostic tool timeout is unavailable",
      "DEEPAGENTS_HEADLESS_TIMEOUT must be a positive integer",
      "nvapi-",
      "nvcf-",
      "ghp_",
      "github_pat_",
      "sk-proj-",
      "sk-ant-",
      "xapp",
      "A(K|S)IA",
      "lsv2_(pt|sk)",
      "/tmp/nemoclaw-proxy-env.sh",
      "sandbox_artifact_scan_command",
      'cat /sandbox/.deepagents/config.toml 2>/dev/null" || true',
      "find /sandbox/.deepagents -maxdepth 3 -type f",
      '-name "*.log"',
    ]) {
      expect(headlessCheck).toContain(expected);
    }
    expect(headlessCheck).not.toContain('sandbox_login_exec ". /tmp/nemoclaw-proxy-env.sh');
    expect(headlessCheck).not.toContain("config_output:0:200");
    expect(headlessCheck).toMatch(/headless_output=.*sandbox_login_exec.*\|\| true\)"/);
  });

  it("requires the managed inference route and placeholder key in Deep Agents Code config", () => {
    expect(
      runHeadlessCheckHelper("managed-route", {
        CONFIG: 'base_url = "https://inference.local/v1"',
      }),
    ).toBe("route");
    expect(
      runHeadlessCheckHelper("managed-placeholder", {
        CONFIG: 'api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"',
      }),
    ).toBe("key");
  });

  it("rejects unsafe headless timeout values before sandbox execution", () => {
    const validate = (timeout: string) =>
      runHeadlessCheckHelper("positive-integer", { DEEPAGENTS_HEADLESS_TIMEOUT: timeout });

    expect(validate("120")).toBe("valid");
    expect(validate("0")).toBe("invalid");
    expect(validate("1; touch /tmp/nemoclaw-timeout-injection")).toBe("invalid");
  });

  it("detects representative secret families in headless inference artifacts", () => {
    const detectsSecret = (token: string) =>
      runHeadlessCheckHelper("contains-secret", { TOKEN: token });
    const secretSamples = [
      "nvapi-" + "A".repeat(10),
      "nvcf-" + "A".repeat(10),
      "ghp_" + "A".repeat(10),
      "github_pat_" + "A".repeat(30),
      "sk-proj-" + "A".repeat(10),
      "sk-ant-" + "A".repeat(10),
      "sk-" + "A".repeat(20),
      "xapp-" + "A".repeat(10),
      "ASIA" + "A".repeat(16),
    ];

    for (const sample of secretSamples) {
      expect(detectsSecret(sample)).toBe("secret");
    }
    expect(detectsSecret("managed-placeholder-key")).toBe("clean");
  });

  it("hash-locks Deep Agents Code base image PyPI installs", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const manifest = readAgentFile("manifest.yaml");
    const requirementsLock = readAgentFile("requirements.lock");

    expect(baseDockerfile).toContain("COPY agents/langchain-deepagents-code/requirements.lock");
    expect(baseDockerfile).toContain('python3 -m venv --copies "$VIRTUAL_ENV"');
    expect(baseDockerfile).toContain(
      '"$VIRTUAL_ENV/bin/pip3" install --no-cache-dir --require-hashes',
    );
    expect(baseDockerfile).toContain("--require-hashes");
    expect(baseDockerfile).toContain("-r /tmp/deepagents-code-requirements.lock");
    expect(baseDockerfile).not.toContain("--break-system-packages");
    expect(baseDockerfile).not.toContain("--ignore-installed");
    expect(manifest).toContain("binary: /opt/venv/bin/pip3");
    expect(manifest).not.toContain("binary: /usr/local/bin/pip3");
    expect(baseDockerfile).not.toContain(
      'pip3 install --no-cache-dir --break-system-packages \\"uv==',
    );
    expect(baseDockerfile).not.toContain("deepagents-code[nvidia]==${DEEPAGENTS_CODE_VERSION}");
    expect(requirementsLock).toContain("uv==0.11.15 \\");
    expect(requirementsLock).toContain("deepagents-code==0.1.30 \\");
    expect(requirementsLock).toContain("langchain-nvidia-ai-endpoints==1.4.3 \\");
    expect(requirementsLock).toContain("aiohttp==3.14.1 \\");
    expect(requirementsLock).toContain("langchain-nvidia-ai-endpoints==");
    expect(requirementsLock).toMatch(/--hash=sha256:[a-f0-9]{64}/);
  });

  it("records dependency advisory review for the lockfile", () => {
    const review = readAgentFile("dependency-review.md");

    expect(review).toContain("requirements.lock");
    expect(review).toContain("229efec862ec10e6b128525e95c8fb8b44cdef8285a6cee78e3a7c73af780a9b");
    expect(review).toContain("Audit date: 2026-07-03");
    expect(review).toContain(
      "uvx --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off",
    );
    expect(review).toContain("No known vulnerabilities found");
  });

  it("rejects runtime-injected secret-shaped env vars before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stderr).toContain("nemoclaw credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects secret-shaped values written to the deepagents env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const envFileBefore = `OPENAI_API_KEY=${fakeSecret}\n`;
    fs.writeFileSync(envFile, envFileBefore, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stderr).toContain("nemoclaw credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.readFileSync(envFile, "utf8")).toBe(envFileBefore);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("allows only exact same-name OpenShell env placeholders in runtime and dotenv inputs", () => {
    const name = "GITHUB_MCP_TOKEN";
    const validPlaceholders = [
      `openshell:resolve:env:${name}`,
      `openshell:resolve:env:v0_${name}`,
      `openshell:resolve:env:v1442987827285932589_${name}`,
    ];

    for (const [index, placeholder] of validPlaceholders.entries()) {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-runtime-${index}-`),
      );
      const runtimeFixture = makeWrapperFixture(runtimeDir);
      const runtimeResult = runWrapper(runtimeFixture.wrapperPath, ["-n", "hi"], {
        [name]: placeholder,
      });
      expect(runtimeResult.status, placeholder).toBe(0);
      expect(runtimeResult.stdout).toContain("dcode-stub-ran");
      expect(fs.existsSync(runtimeFixture.ranMarker)).toBe(true);

      const dotenvDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-dotenv-${index}-`),
      );
      const dotenvFixture = makeWrapperFixture(dotenvDir);
      fs.writeFileSync(dotenvFixture.envFile, `${name}="${placeholder}"\n`, "utf8");
      const dotenvResult = runWrapper(dotenvFixture.wrapperPath, ["-n", "hi"], {});
      expect(dotenvResult.status, placeholder).toBe(0);
      expect(dotenvResult.stdout).toContain("dcode-stub-ran");
      expect(fs.existsSync(dotenvFixture.ranMarker)).toBe(true);
    }
  });

  it("rejects mismatched, malformed, wrapped, and raw credential placeholders", () => {
    const invalidCases = [
      { name: "MODEL_NAME", value: "openshell:resolve:env:OTHER_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12_OTHER_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v_MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12x_MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12__MODEL_NAME" },
      { name: "MODEL_NAME", value: "Bearer openshell:resolve:env:MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:MODEL_NAME:suffix" },
      { name: "MODEL-NAME", value: "openshell:resolve:env:MODEL-NAME" },
      { name: "OPENSHELL_TLS_KEY", value: "openshell:resolve:env:OPENSHELL_TLS_KEY" },
      { name: "OPENSHELL_TLS_KEY", value: "openshell:resolve:env:v12_OPENSHELL_TLS_KEY" },
      { name: "GITHUB_MCP_TOKEN", value: "opaqueRawCredentialValue12345" },
    ];

    for (const [index, { name, value }] of invalidCases.entries()) {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-invalid-runtime-${index}-`),
      );
      const runtimeFixture = makeWrapperFixture(runtimeDir);
      const runtimeResult = runWrapper(runtimeFixture.wrapperPath, ["-n", "hi"], {
        [name]: value,
      });
      expect(runtimeResult.status, `runtime accepted ${value}`).not.toBe(0);
      expect(runtimeResult.stderr).toContain(name);
      expect(runtimeResult.stderr).not.toContain(value);
      expect(fs.existsSync(runtimeFixture.ranMarker)).toBe(false);

      const dotenvDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-invalid-dotenv-${index}-`),
      );
      const dotenvFixture = makeWrapperFixture(dotenvDir);
      fs.writeFileSync(dotenvFixture.envFile, `${name}=${value}\n`, "utf8");
      const dotenvResult = runWrapper(dotenvFixture.wrapperPath, ["-n", "hi"], {});
      expect(dotenvResult.status, `dotenv accepted ${value}`).not.toBe(0);
      expect(dotenvResult.stderr).toContain(name);
      expect(dotenvResult.stderr).not.toContain(value);
      expect(fs.existsSync(dotenvFixture.ranMarker)).toBe(false);
    }
  });

  it("allows nemoclaw-managed messaging tokens whose values are intentionally credential-shaped", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      SLACK_BOT_TOKEN: ["xoxb", "1234567890", "abcdefghij"].join("-"),
      SLACK_APP_TOKEN: ["xapp", "1", "A1B2C3", "1234567890", "abcdefghij"].join("-"),
      TELEGRAM_BOT_TOKEN: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678",
      DISCORD_BOT_TOKEN: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects managed Slack runtime env vars that wrap non-Slack secret values", () => {
    const cases: Array<{ name: string; value: string }> = [
      { name: "SLACK_BOT_TOKEN", value: "xoxb-sk-abcdefghijklmnopqrstuvwx" },
      { name: "SLACK_APP_TOKEN", value: "xapp-ghp_abcdefghijklmnopqr" },
      { name: "SLACK_BOT_TOKEN", value: "xoxb-API_KEY=opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: "xapp-TOKEN:opaquevalue12345" },
      { name: "SLACK_BOT_TOKEN", value: `xoxb-lsv2_pt_${"a".repeat(36)}_${"b".repeat(10)}` },
      { name: "SLACK_APP_TOKEN", value: `xapp-${fakePrivateKeyBlock()}` },
    ];

    for (const { name, value } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-slack-wrap-"));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: value });

      expect(result.status, `${name} wrapping non-Slack secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(value);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("rejects managed Slack env-file values that wrap non-Slack secret values", () => {
    const cases: Array<{ name: string; value: string }> = [
      { name: "SLACK_BOT_TOKEN", value: "xoxb-nvapi-abcdefghijklmnop" },
      { name: "SLACK_APP_TOKEN", value: "xapp-pypi-abcdefghijklmnop" },
      { name: "SLACK_BOT_TOKEN", value: "xoxb-PASSWORD opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: "xapp-CREDENTIAL=opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: `xapp-lsv2_sk_${"a".repeat(36)}_${"b".repeat(10)}` },
      { name: "SLACK_BOT_TOKEN", value: `xoxb-${fakePrivateKeyBlock("RSA")}` },
    ];

    for (const { name, value } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-slack-wrap-file-"));
      const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(envFile, `${name}=${value}\n`, "utf8");
      const result = runWrapper(wrapperPath, ["-n", "hi"], {});

      expect(result.status, `${name} wrapping non-Slack secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain(envFile);
      expect(result.stderr).not.toContain(value);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it.each([
    {
      label: "Telegram",
      name: "STRAY_TG_TOKEN",
      token: "987654321:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    },
    {
      label: "Discord",
      name: "STRAY_DISCORD",
      token: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    },
  ])("rejects unmanaged runtime env vars holding $label-shaped bot tokens", ({ name, token }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: token });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain(token);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    {
      label: "Telegram",
      name: "OTHER_BOT",
      token: "111222333:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    },
    {
      label: "Discord",
      name: "STRAY_DISCORD_FILE",
      token: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    },
  ])("rejects $label-shaped tokens written to the deepagents env file", ({ name, token }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `${name}=${token}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(token);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("does not bypass classification when env-file values have surrounding whitespace", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `  OPENAI_API_KEY   =   ${fakeSecret}   \n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("recovers after the secret-bearing line is removed from the same env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const secretLine = `OPENAI_API_KEY=${fakeSecret}`;
    const cleanLine = "DISCORD_ALLOWED_USERS=alice,bob";
    fs.writeFileSync(envFile, [secretLine, cleanLine].join("\n") + "\n", "utf8");

    const rejected = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(rejected.status).not.toBe(0);
    expect(fs.existsSync(ranMarker)).toBe(false);

    const remaining = fs
      .readFileSync(envFile, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("OPENAI_API_KEY="))
      .join("\n");
    fs.writeFileSync(envFile, remaining, "utf8");

    const recovered = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("prevents the dcode entry path from running when a runtime secret is rejected", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);

    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
    expect(fs.readFileSync(envFile, "utf8")).toBe("");
  });

  it("rejects a caller-supplied DEEPAGENTS_ENV_FILE override and scans only the hardcoded path", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");
    const decoy = path.join(tempDir, "decoy.env");
    fs.writeFileSync(decoy, "", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], { DEEPAGENTS_ENV_FILE: decoy });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(decoy);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("passes through when no secret-shaped value is present in env, env file, or auth store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile, authFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(
      envFile,
      ["# comment", "DISCORD_ALLOWED_USERS=alice,bob", "MODEL_NAME=gpt-4"].join("\n"),
      "utf8",
    );
    fs.writeFileSync(authFile, JSON.stringify({ version: 1, credentials: {} }), "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects stored Deep Agents Code credentials before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-store-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        version: 1,
        credentials: {
          langsmith: { type: "api_key", key: fakeSecret, added_at: "2026-06-30T00:00:00Z" },
        },
      }),
      "utf8",
    );

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "malformed JSON", content: "{not valid json at all" },
    { label: "present but unreadable", content: '{"credentials": null}', unreadable: true },
  ])("refuses to launch when auth.json is $label (fail-closed)", ({ content, unreadable }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-edge-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(authFile, content, "utf8");
    fs.chmodSync(authFile, unreadable ? 0o000 : 0o644);
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
    fs.chmodSync(authFile, 0o644);
  });

  it("allows launch when auth.json is absent (fresh sandbox)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-absent-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    expect(fs.existsSync(authFile)).toBe(false);
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects the separate ChatGPT OAuth token store before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-codex-auth-"));
    const { wrapperPath, ranMarker, codexAuthFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(codexAuthFile, "{}", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("chatgpt-auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { args: ["update"], posture: "dependency update posture" },
    { args: ["install", "anthropic"], posture: "dependency update posture" },
    { args: ["auth", "set", "langsmith"], posture: "credential posture" },
    { args: ["tools", "install"], posture: "managed tool set posture" },
    { args: ["tools", "add"], posture: "managed tool set posture" },
    { args: ["mcp"], posture: "MCP posture" },
  ])("rejects upstream managed-mutation command $args", ({ args, posture }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-command-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(posture);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    ["--update"],
    ["--upd"],
    ["--auto-update"],
    ["--auto-upd"],
    ["--install", "nvidia"],
    ["--install=nvidia"],
    ["--inst", "nvidia"],
    ["--install", "provider-package", "--package", "--yes"],
  ])("rejects upstream global mutation flags before dcode runs: %s", (...args) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-global-flag-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dependency update posture");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { args: ["tools", "list"] },
    { args: ["tools", "--help"] },
    { args: ["tools"] },
  ])("passes through read-only tools subcommand $args", ({ args }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tools-readonly-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects non-messaging secret shapes carried by managed runtime env names", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "SLACK_BOT_TOKEN", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "SLACK_APP_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "TELEGRAM_BOT_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "DISCORD_BOT_TOKEN", sample: ["AK", "IAABCDEFGHIJKLMNOP"].join("") },
    ];
    for (const { name, sample } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mgmix-"));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: sample });
      expect(result.status, `${name} carrying non-platform secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(sample);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("rejects non-messaging secret shapes carried by managed env-file names", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "SLACK_BOT_TOKEN", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "TELEGRAM_BOT_TOKEN", sample: "nvapi-abcdefghijklmnop" },
      { name: "DISCORD_BOT_TOKEN", sample: "hf_abcdefghijklmnopq" },
    ];
    for (const { name, sample } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mgfile-"));
      const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(envFile, `${name}=${sample}\n`, "utf8");
      const result = runWrapper(wrapperPath, ["-n", "hi"], {});
      expect(result.status, `${name} carrying non-platform secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain(envFile);
      expect(result.stderr).not.toContain(sample);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("emits no NET:OPEN, inference.local, or pypi.org log entries when a runtime secret triggers rejection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-netlog-"));
    const { wrapperPath, networkLog } = makeNetworkSimulatingFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(networkLog)).toBe(false);
    expect(result.stderr).not.toContain("NET:OPEN");
    expect(result.stderr).not.toContain("inference.local");
    expect(result.stderr).not.toContain("pypi.org");
  });

  it("emits no NET:OPEN, inference.local, or pypi.org log entries when an env-file secret triggers rejection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-netlog-env-"));
    const { wrapperPath, networkLog, envFile } = makeNetworkSimulatingFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(networkLog)).toBe(false);
    expect(result.stderr).not.toContain("NET:OPEN");
    expect(result.stderr).not.toContain("inference.local");
    expect(result.stderr).not.toContain("pypi.org");
  });

  it("rejects bearer-wrapped opaque secret values without a recognized token prefix", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-bearer-opaque-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueRandomSessionTokenZ1234567890";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      CUSTOM_HEADER: `Bearer ${opaque}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CUSTOM_HEADER");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects credential-name-context runtime env values with opaque payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueOpenAiCustomKeyMarker12345";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      OPENAI_API_KEY: opaque,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects credential-name-context env-file entries with opaque payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-file-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const opaque = "opaqueOpenAiCustomKeyMarker12345";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${opaque}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "opaque credential-name", value: "opaqueCredentialPayloadZ1234567890" },
    { label: "token-prefix", value: "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000" },
  ])("rejects export-prefixed env-file entries that carry $label secrets", ({ value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-export-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `export OPENAI_API_KEY=${value}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(value);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects lower-case credential-name-context env vars to mirror canonical case-insensitive matching", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-lower-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueLowerCasedCredentialPayload";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      openai_api_key: opaque,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openai_api_key");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects mixed-case credential-name-context env-file entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-file-case-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const opaque = "opaqueMixedCaseCredentialMarker12345";
    fs.writeFileSync(envFile, `LangSmith_Token=${opaque}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LangSmith_Token");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects exact canonical credential names KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL with opaque payloads", () => {
    const cases: string[] = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY"];
    const opaque = "opaqueCredentialPayloadZ1234567890";
    for (const name of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-dcode-exactctx-${name}-`));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: opaque });
      expect(result.status, `${name} with opaque value not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(opaque);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it.each([
    { label: "variable expansion", content: "MY_CRED=$OTHER_SECRET" },
    { label: "command substitution", content: "MY_CRED=$(whoami)" },
    { label: "backtick substitution", content: "MY_CRED=`whoami`" },
  ])("rejects dotenv $label in env-file entries", ({ content }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-dynamic-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `${content}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MY_CRED");
    expect(result.stderr).toContain("dynamic value");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "bearer-wrapped", name: "CUSTOM_HEADER", value: (s: string) => `Bearer ${s}` },
    { label: "embedded", name: "EMBEDDED_HOST_HEADER", value: (s: string) => `prefix-${s}` },
  ])("rejects $label secret values carried in runtime env vars", ({ name, value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-secret-wrap-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-abcdefghijklmnopqrstuvwx";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: value(fakeSecret) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects secret-shaped runtime env values whose names are not valid shell identifiers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-rawenv-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";

    const result = spawnSync(
      "env",
      [
        "-i",
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        `OPENAI-API-KEY=${fakeSecret}`,
        "bash",
        wrapperPath,
        "-n",
        "hi",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI-API-KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("pins the wrapper parity contract to the canonical TOKEN_PREFIX_PATTERNS fingerprint to surface drift", () => {
    expect(fingerprint(TOKEN_PREFIX_PATTERNS)).toEqual([
      "nvapi-[A-Za-z0-9_-]{10,}::g",
      "nvcf-[A-Za-z0-9_-]{10,}::g",
      "ghp_[A-Za-z0-9_-]{10,}::g",
      "(?:github_pat_)[A-Za-z0-9_]{30,}::g",
      "sk-proj-[A-Za-z0-9_-]{10,}::g",
      "sk-ant-[A-Za-z0-9_-]{10,}::g",
      "sk-[A-Za-z0-9_-]{20,}::g",
      "(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}::g",
      "A(?:K|S)IA[A-Z0-9]{16}::g",
      "hf_[A-Za-z0-9]{10,}::g",
      "glpat-[A-Za-z0-9_-]{10,}::g",
      "gsk_[A-Za-z0-9]{10,}::g",
      "pypi-[A-Za-z0-9_-]{10,}::g",
      "\\bbot\\d{8,10}:[A-Za-z0-9_-]{35}\\b::g",
      "\\b\\d{8,10}:[A-Za-z0-9_-]{35}\\b::g",
      "\\b[A-Za-z0-9]{24}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}\\b::g",
      "tvly-[A-Za-z0-9_-]{10,}::g",
      "lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*::g",
    ]);
  });

  it("pins the wrapper parity contract to the canonical CONTEXT_PATTERNS fingerprint to surface drift", () => {
    expect(fingerprint(CONTEXT_PATTERNS)).toEqual([
      "(?<=Bearer\\s+)[A-Za-z0-9_.+/=-]{10,}::gi",
      "(?<=(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]['\"]?)[A-Za-z0-9_.+/=-]{10,}::gi",
    ]);
  });

  it("rejects every canonical token shape declared by the secret-pattern contract", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "nvapi", sample: "nvapi-abcdefghijklmnop" },
      { name: "nvcf", sample: "nvcf-abcdefghijklmnopq" },
      { name: "ghp", sample: "ghp_abcdefghijklmnopqr" },
      { name: "github_pat", sample: "github_pat_abcdefghijklmnopqrstuvwxyz0123" },
      { name: "sk_proj", sample: "sk-proj-abcdefghij" },
      { name: "sk_ant", sample: "sk-ant-abcdefghijk" },
      { name: "sk", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "xoxb", sample: "xoxb-1234567890" },
      { name: "xoxp", sample: "xoxp-1234567890" },
      { name: "xoxa", sample: ["xoxa", "1234567890"].join("-") },
      { name: "xoxs", sample: "xoxs-1234567890" },
      { name: "xapp", sample: ["xapp", "1", "A1B2C3", "12345", "abcde"].join("-") },
      { name: "akia", sample: ["AKIA", "ABCDEFGHIJKLMNOP"].join("") },
      { name: "asia", sample: ["ASIA", "ABCDEFGHIJKLMNOP"].join("") },
      { name: "hf", sample: "hf_abcdefghijklmnopq" },
      { name: "glpat", sample: "glpat-abcdefghijklmn" },
      { name: "gsk", sample: "gsk_abcdefghijklmnop" },
      { name: "pypi", sample: "pypi-abcdefghijklmnop" },
      { name: "tavily", sample: "tvly-abcdefghijklmnop" },
      { name: "telegram", sample: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      { name: "telegram_bot", sample: "bot123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      { name: "discord", sample: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
      { name: "langsmith_pt", sample: `lsv2_pt_${"a".repeat(36)}_${"b".repeat(10)}` },
      { name: "langsmith_sk", sample: `lsv2_sk_${"a".repeat(36)}_${"b".repeat(10)}` },
    ];
    for (const { name, sample } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-dcode-parity-${name}-`));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const varName = `NEMOCLAW_PARITY_${name.toUpperCase()}`;
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [varName]: sample });
      expect(result.status, `${name} via runtime env not rejected`).not.toBe(0);
      expect(result.stderr).toContain(varName);
      expect(result.stderr).not.toContain(sample);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });
});
