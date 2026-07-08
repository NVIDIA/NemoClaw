// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { TOKEN_PREFIX_PATTERNS } from "../src/lib/security/secret-patterns.ts";
import { cloudExperimentalChecksForOnboarding } from "./e2e/live/cloud-experimental-check-list.ts";
import {
  ANALYTICS_DISABLE_ENV_NAMES,
  DCODE_CANONICAL_PATH,
  headlessCheckPath,
  makeStartScriptFixture as makeHeadlessStartScriptFixture,
  NO_PROXY_ENV_NAMES,
  PROXY_URL_ENV_NAMES,
  runHeadlessCheckHelper,
  runStartScriptProxyProbe,
  TRACING_ENABLE_ENV_NAMES,
} from "./helpers/langchain-deepagents-code-headless.ts";
import {
  makeWrapperFixture,
  readAgentFile,
  runWrapper,
} from "./helpers/langchain-deepagents-code-image.ts";
import { makeStartScriptFixture as makeIdentityStartScriptFixture } from "./support/dcode-start-script-fixture.ts";

function containsTokenShapedSecret(value: string): boolean {
  return TOKEN_PREFIX_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const tuiStartupCheckPath = path.join(
  repoRoot,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "10-deepagents-code-tui-startup.sh",
);

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
    expect(dockerfile).toContain("ARG NEMOCLAW_MODEL=nvidia/nemotron-3-ultra-550b-a55b");
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
    const inheritedAnalyticsFlags = Object.fromEntries(
      ANALYTICS_DISABLE_ENV_NAMES.map((name) => [name, "0"]),
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
      ...inheritedAnalyticsFlags,
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
    for (const name of ANALYTICS_DISABLE_ENV_NAMES) {
      expect(outputLines).toContain(`RUNTIME_${name}=1`);
      expect(outputLines).toContain(`SOURCED_${name}=1`);
      expect(envFileLines).toContain(`export ${name}=1`);
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
    expect(wrapper).toContain("deepagents-code==0.1.34");
    expect(wrapper).toContain("Schema pin");
    expect(wrapper).toContain("truthy top-level");
    expect(wrapper).toContain("unset PYTHONHOME PYTHONPATH");
    expect(wrapper).toContain('/opt/venv/bin/python3 -I - "$auth_file"');
    expect(wrapper).toContain("exec /opt/venv/bin/python3 -I -m deepagents_code");
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(wrapper).not.toContain("managed_mcp_config_path");
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
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
      "managed-dcode-runtime.py",
      "nemoclaw_observability.py",
      "patch-managed-deepagents-code.py",
      "validate-nemotron-ultra-profile.py",
      "DEEPAGENTS_CODE_LANGSMITH_TRACING=false",
      "LANGSMITH_TRACING=false",
      "DEEPAGENTS_CODE_OFFLINE=1",
      "DEEPAGENTS_CODE_RIPGREP_INSTALLER=system",
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/dcode.real",
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/deepagents-code",
      "install -o root -g root -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec",
      "test -f /usr/local/lib/nemoclaw/dcode-managed-exec",
      "test ! -L /usr/local/lib/nemoclaw/dcode-managed-exec",
      `test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-managed-exec)" = "0:0:755"`,
      "cmp -s /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec",
      "/usr/local/lib/nemoclaw/dcode-managed-exec /usr/bin/true",
      "/opt/venv/bin/pip3 install --no-index --no-cache-dir --no-deps --no-build-isolation /opt/nemoclaw-deepagents-profile-plugin",
      "find /opt/nemoclaw-deepagents-profile-plugin -type f -print | LC_ALL=C sort",
      "/opt/venv/bin/pip3 check",
      "/opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py",
    ]) {
      expect(dockerfile).toContain(s);
    }
    expect(
      dockerfile
        .split("\n")
        .filter((line) => line.startsWith("COPY agents/langchain-deepagents-code/profile-plugin")),
    ).toEqual([
      "COPY agents/langchain-deepagents-code/profile-plugin/pyproject.toml /opt/nemoclaw-deepagents-profile-plugin/",
      "COPY agents/langchain-deepagents-code/profile-plugin/src/nemoclaw_deepagents_profile/__init__.py /opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/",
    ]);
    expect(dockerfile).toContain(
      "rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code /opt/venv/bin/dcode /opt/venv/bin/deepagents-code",
    );
    expect(dockerfile).toContain(
      "COPY agents/langchain-deepagents-code/validate-progressive-tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "python3 /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "rm -f /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "rm -f /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py",
    );
    expect(dockerfile).not.toContain("patch-nemotron-ultra-profile.py");
    expect(dockerfile).not.toContain("nemotron-ultra-harness-profile.py");
    expect(dockerfile).not.toContain("LICENSE.langchain-deepagents");
    expect(dockerfile).not.toContain("langchain-deepagents-MIT.txt");
    expect(dockerfile).toContain("COPY agents/langchain-deepagents-code/validate-observability.py");
    expect(dockerfile).toContain(
      "/opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-observability.py",
    );
    expect(dockerfile).toContain("rm -f /opt/nemoclaw-deepagents-code/validate-observability.py");
    expect(dockerfile).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=progressive");
    expect(dockerfile).toContain("NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}");
    expect(dockerfile).toContain("progressive|direct)");
    expect(launcher).toContain('exec "$MANAGED_DCODE_WRAPPER" "$@"');
    expect(policy).not.toContain("/usr/local/bin/dcode.real");
    expect(policy).not.toContain("dcode.upstream");
  });

  it("exposes an exact managed MCP capability marker without starting dcode", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mcp-capability-"));
    try {
      const { wrapperPath, ranMarker, authFile, codexAuthFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(authFile, '{"api_key":"forbidden"}\n', "utf8");
      fs.writeFileSync(codexAuthFile, '{"access_token":"forbidden"}\n', "utf8");
      const result = runWrapper(wrapperPath, ["--nemoclaw-mcp-capability"], {
        OPENAI_API_KEY: "forbidden",
        NEMOCLAW_DEEPAGENTS_CODE_AUTH_MODE: "invalid",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n");
      expect(fs.existsSync(ranMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps NemoClaw MCP state separate from user discovery", () => {
    const requirements = readAgentFile("requirements.lock");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const managedRuntime = readAgentFile("managed-dcode-runtime.py");
    const patcher = readAgentFile("patch-managed-deepagents-code.py");
    const manifest = readAgentFile("manifest.yaml");
    const managedPath = "/sandbox/.deepagents/.nemoclaw-mcp.json";

    // The pinned release's user/project .mcp.json files remain user-authored.
    // Managed images suppress discovery and pass only an integrity-bound
    // snapshot of NemoClaw's dedicated projection.
    expect(requirements).toContain("deepagents-code==0.1.34");
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(managedRuntime).toContain(`_MCP_CONFIG_FILE = Path("${managedPath}")`);
    expect(patcher).toContain("managed_mcp_config = _nemoclaw_managed_mcp_config_path()");
    expect(patcher).toContain("_nemoclaw_skip_launch_model");
    expect(managedRuntime).toContain("if not servers:\n        return None");
    expect(managedRuntime).toContain("or descriptor != _MANAGED_MCP_FD");
    expect(patcher).toContain("def discover_mcp_configs(");
    expect(patcher).toContain("return []");
    expect(manifest).toContain("- .deepagents/.mcp.json");
    expect(manifest).toContain(".deepagents/.nemoclaw-mcp.json projection");
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
    expect(wrapper).not.toContain("managed_mcp_config_path");
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
    expect(policy).not.toContain("supabase.co");
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
      'DCODE_MANAGED_EXEC="/usr/local/lib/nemoclaw/dcode-managed-exec"',
      'local -a command_prefix=("${@:3}")',
      "printf -v remote_cmd '%q '",
      "base64 | tr -d",
      "base64 -d",
      'remote_cmd+="-c',
      "${url@Q}",
      'expect_reached "arbitrary Python" "GitHub" "https://api.github.com/"',
      'expect_reached "arbitrary Python" "PyPI" "https://pypi.org/"',
      '"direct managed-exec Python"',
      '"/opt/venv/bin/python3"',
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
      'NEMOCLAW_TUI_FIRST_RUN_PATTERN="$TUI_FIRST_RUN_PATTERN"',
      "-nocase -re $first_run_pattern",
      'append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"',
      "choose a recommended model",
      "exit 24",
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
      "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
      "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
      "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
      "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
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
      "NEMOCLAW_DCODE_EMPTY_EXIT",
      "login-shell dcode rejects an empty non-interactive prompt with exit 2",
      "direct-exec dcode rejects an empty non-interactive prompt with exit 2",
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
    expect(requirementsLock).toContain("deepagents-code==0.1.34 \\");
    expect(requirementsLock).toContain("deepagents==0.7.0a6 \\");
    expect(requirementsLock).toContain("langchain-google-genai==4.2.7 \\");
    expect(requirementsLock).toContain("nemo-relay==0.4.0 \\");
    expect(requirementsLock).toContain("langchain-nvidia-ai-endpoints==1.4.3 \\");
    expect(requirementsLock).toContain("aiohttp==3.14.1 \\");
    expect(requirementsLock).toContain("langchain-nvidia-ai-endpoints==");
    expect(requirementsLock).toMatch(/--hash=sha256:[a-f0-9]{64}/);
  });

  it("records dependency advisory review for the lockfile", () => {
    const review = readAgentFile("dependency-review.md");

    expect(review).toContain("requirements.lock");
    expect(review).toContain("d8b01f36a0f325f38d18b4dc2cfdf452125987571a86ca58d9c93e08b7b06a14");
    expect(review).toContain("Audit date: 2026-07-07");
    expect(review).toContain(
      "uv tool run --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip",
    );
    expect(review).toContain("No known vulnerabilities found");
    expect(review).toContain("75ff7e7a5142cad4305126ccb1b8fc756306e82d4c559ddbc624012fb54ebfc4");
    expect(review).toContain("7ba7b77bd6f889cc861eddbe3e38fc1f4433a85b7bc2a9b516e19a19a37a7686");
    expect(review).toContain("Adapter dependency audit result: `No known vulnerabilities found`");
    expect(review).toContain("Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`");
    expect(review).toContain("NemoClaw no longer vendors or overlays that source");
  });
});
