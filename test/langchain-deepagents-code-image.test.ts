// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { CONTEXT_PATTERNS, TOKEN_PREFIX_PATTERNS } from "../src/lib/security/secret-patterns.ts";
import { cloudExperimentalChecksForOnboarding } from "./e2e-scenario/live/cloud-experimental-check-list.ts";

function fingerprint(patterns: readonly RegExp[]): string[] {
  return patterns.map((re) => `${re.source}::${re.flags}`);
}

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const headlessCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "07-deepagents-code-headless-inference.sh",
);
const DCODE_CANONICAL_PATH =
  "/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function makeWrapperFixture(
  tempDir: string,
  envFileOverride?: string,
): { wrapperPath: string; ranMarker: string; envFile: string } {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const envFile = envFileOverride ?? path.join(tempDir, ".env");
  const fixture = readAgentFile("dcode-wrapper.sh")
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      "exec python3 -m deepagents_code",
      `touch "${ranMarker}"; echo dcode-stub-ran; exit 0; : python3 -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, ranMarker, envFile };
}

function makeNetworkSimulatingFixture(tempDir: string): {
  wrapperPath: string;
  networkLog: string;
  envFile: string;
} {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const networkLog = path.join(tempDir, "network.log");
  const envFile = path.join(tempDir, ".env");
  const fixture = readAgentFile("dcode-wrapper.sh")
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      "exec python3 -m deepagents_code",
      `printf 'NET:OPEN inference.local/v1/chat\\nNET:OPEN pypi.org/simple\\nNET:OPEN api.openai.com/v1\\n' > "${networkLog}"; exit 0; : python3 -m deepagents_code`,
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

function makeStartScriptFixture(tempDir: string): {
  envFile: string;
  scriptPath: string;
} {
  const envFile = path.join(tempDir, "proxy-env.sh");
  const scriptPath = path.join(tempDir, "start.sh");
  const fixture = readAgentFile("start.sh")
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`,
    );
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, scriptPath };
}

function runHeadlessCheckHelper(snippet: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("bash", ["-c", `source "$1"; ${snippet}`, "bash", headlessCheckPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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

  it("does not serialize provider or optional service secrets into the shell env file", () => {
    const startScript = readAgentFile("start.sh");

    expect(startScript).toContain('chmod 400 "$tmp"');
    expect(startScript).toContain("write_proxy_export_pair HTTPS_PROXY https_proxy");
    expect(startScript).not.toContain("write_export_if_set DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(startScript).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(startScript).not.toMatch(
      /write_export_if_set (?:NVIDIA_API_KEY|OPENAI_API_KEY|TAVILY_API_KEY|DEEPAGENTS_CODE_TAVILY_API_KEY|LANGSMITH_API_KEY)\b/,
    );
  });

  it("serializes non-credential proxy URLs into the shell env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, scriptPath } = makeStartScriptFixture(tempDir);

    execFileSync("bash", [scriptPath, "sh", "-c", 'cat "$NEMOCLAW_TEST_PROXY_ENV"'], {
      env: {
        NEMOCLAW_TEST_PROXY_ENV: envFile,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HTTP_PROXY: "http://proxy.example:8080",
        https_proxy: "https://safe-proxy.example:8443",
      },
      encoding: "utf8",
    });

    const envFileText = fs.readFileSync(envFile, "utf8");
    expect(envFileText).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expect(envFileText.match(/\/usr\/local\/bin/g)).toHaveLength(1);
    expect(envFileText).toContain("export HTTP_PROXY=http://proxy.example:8080");
    expect(envFileText).toContain("export https_proxy=https://safe-proxy.example:8443");
  });

  it("omits and unsets credential-bearing proxy URLs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, scriptPath } = makeStartScriptFixture(tempDir);

    const output = execFileSync(
      "bash",
      [
        scriptPath,
        "sh",
        "-c",
        [
          'cat "$NEMOCLAW_TEST_PROXY_ENV"',
          'printf "\\nENV_HTTP_PROXY=%s\\n" "${HTTP_PROXY-__unset__}"',
          'printf "ENV_http_proxy=%s\\n" "${http_proxy-__unset__}"',
          'printf "ENV_HTTPS_PROXY=%s\\n" "${HTTPS_PROXY-__unset__}"',
          'printf "ENV_https_proxy=%s\\n" "${https_proxy-__unset__}"',
        ].join("; "),
      ],
      {
        env: {
          NEMOCLAW_TEST_PROXY_ENV: envFile,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HTTP_PROXY: "http://proxy.example:8080",
          HTTPS_PROXY: "https://user:pass@proxy.example:8443",
          http_proxy: "http://user:pass@proxy.example:8080",
          https_proxy: "https://safe-proxy.example:8443",
          NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST: "all",
        },
        encoding: "utf8",
      },
    );

    const envFileText = fs.readFileSync(envFile, "utf8");
    expect(envFileText).not.toContain("HTTP_PROXY");
    expect(envFileText).not.toContain("HTTPS_PROXY");
    expect(envFileText).not.toContain("http_proxy");
    expect(envFileText).not.toContain("https_proxy");
    expect(envFileText).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(envFileText).not.toContain("DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(output).toContain("ENV_HTTP_PROXY=__unset__");
    expect(output).toContain("ENV_http_proxy=__unset__");
    expect(output).toContain("ENV_HTTPS_PROXY=__unset__");
    expect(output).toContain("ENV_https_proxy=__unset__");
    expect(envFileText).not.toContain("user:pass");
    expect(envFileText).not.toContain("user:pass@proxy.example:8443");
    expect(envFileText).not.toContain("user:pass@proxy.example:8080");
  });

  it("keeps all Deep Agents Code entry points behind the managed wrapper boundary", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const wrapper = readAgentFile("dcode-wrapper.sh");
    const policy = readAgentFile("policy-additions.yaml");

    expect(dockerfile).toContain(
      "rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code /opt/venv/bin/dcode /opt/venv/bin/deepagents-code",
    );
    expect(dockerfile).toContain("patch-managed-deepagents-code.py");
    expect(dockerfile).not.toContain("NEMOCLAW_WEB_SEARCH_ENABLED");
    expect(wrapper).toContain("unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(wrapper).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(dockerfile).toContain(
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/bin/dcode.real",
    );
    expect(dockerfile).toContain(
      "install -m 0755 /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/bin/deepagents-code",
    );
    expect(dockerfile).not.toContain("dcode.upstream");
    expect(wrapper).toContain("exec python3 -m deepagents_code");
    expect(wrapper).toContain('reject_managed_override "sandbox isolation"');
    expect(wrapper).toContain('reject_managed_override "MCP posture"');
    expect(wrapper).toContain('reject_managed_override "shell allow-list posture"');
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(policy).not.toContain("/usr/local/bin/dcode.real");
    expect(policy).not.toContain("dcode.upstream");
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

    expect(landlockCheck).toContain("test -d /sandbox/.deepagents && command -v dcode");
    expect(landlockCheck).toContain("touch /sandbox/.deepagents/deepagents-landlock-test");
    expect(landlockCheck).toContain("touch /usr/deepagents-landlock-test");
    expect(landlockCheck).toContain("touch /opt/venv/deepagents-landlock-test");
    expect(landlockCheck).toContain("touch /etc/deepagents-landlock-test");
    expect(landlockCheck).toContain("touch /tmp/deepagents-landlock-test");
    expect(landlockCheck).toContain("/usr is Landlock read-only for Deep Agents Code");
    expect(landlockCheck).toContain("/opt/venv is Landlock read-only for Deep Agents Code");
    expect(landlockCheck).toContain("/etc is Landlock read-only for Deep Agents Code");
    expect(pythonEgressCheck).toContain(`DCODE_CANONICAL_PATH="${DCODE_CANONICAL_PATH}"`);
    expect(pythonEgressCheck).toContain('grep -Fxq "PATH=${DCODE_CANONICAL_PATH}"');
    expect(pythonEgressCheck).toContain('printf "PYTHON_REAL=%s\\n"');
    expect(pythonEgressCheck).toContain("^PYTHON=/opt/venv/bin/python3$");
    expect(pythonEgressCheck).toContain("^PIP=/opt/venv/bin/pip3$");
    expect(pythonEgressCheck).toContain("^USRLOCAL_COUNT=1$");
    expect(pythonEgressCheck).toContain("import urllib.error");
    expect(pythonEgressCheck).toContain("except urllib.error.HTTPError as exc:");
    expect(pythonEgressCheck).toContain("except urllib.error.URLError as exc:");
    expect(pythonEgressCheck).toContain("ERROR:URLError");
    expect(pythonEgressCheck).toContain("lacked denial evidence");
    expect(pythonEgressCheck).toContain("${python_bin@Q} - ${url@Q} <<'PY'");
    expect(pythonEgressCheck).toContain(
      'expect_reached "arbitrary Python" "GitHub" "https://api.github.com/"',
    );
    expect(pythonEgressCheck).toContain(
      'expect_reached "arbitrary Python" "PyPI" "https://pypi.org/"',
    );
    expect(pythonEgressCheck).toContain('PROJECT_VENV="/sandbox/.nemoclaw-e2e-project-venv"');
    expect(pythonEgressCheck).toContain("python3 -m venv --copies");
    expect(pythonEgressCheck).toContain(
      'expect_reached "project venv Python under /sandbox" "PyPI" "https://pypi.org/" "$PROJECT_PYTHON"',
    );
    expect(pythonEgressCheck).toContain(
      'expect_reached "project venv Python under /sandbox" "files.pythonhosted.org" "https://files.pythonhosted.org/" "$PROJECT_PYTHON"',
    );
    expect(pythonEgressCheck).toContain(
      'expect_blocked "project venv Python under /sandbox" "Tavily" "https://api.tavily.com/" "$PROJECT_PYTHON"',
    );
    expect(pythonEgressCheck).toContain("https://api.tavily.com/");
    expect(pythonEgressCheck).toContain("https://api.smith.langchain.com/");
    expect(pythonEgressCheck).toContain("https://modelcontextprotocol.io/");
    expect(pythonEgressCheck).toContain("https://example.com/");
    expect(pythonEgressCheck).toContain("${actor} cannot reach ${label} without explicit policy");
    expect(secretBoundaryCheck).toContain("Case: Deep Agents Code dcode secret boundary");
    expect(secretBoundaryCheck).toContain("env OPENAI_API_KEY=");
    expect(secretBoundaryCheck).toContain("dcode -n 'Reply with the single word PING'");
    expect(secretBoundaryCheck).toContain("DCODE_EXIT:0");
    expect(secretBoundaryCheck).toContain("refusing to start");
    expect(secretBoundaryCheck).toContain("NETWORK_LOG_PATTERN=");
    expect(secretBoundaryCheck).toContain("AUDIT_NETWORK_LOG_PATTERN=");
    expect(secretBoundaryCheck).toContain("NET:OPEN|inference\\\\.local|pypi\\\\.org");
    expect(secretBoundaryCheck).toContain("integrate\\\\.api\\\\.nvidia\\\\.com");
    expect(secretBoundaryCheck).toContain("/tmp/gateway.log");
    expect(secretBoundaryCheck).toContain("/tmp/nemoclaw-start.log");
    expect(secretBoundaryCheck).toContain("ocsf_json_enabled");
    expect(secretBoundaryCheck).toContain(
      'openshell logs "$SANDBOX_NAME" -n 500 --source all --since 2m',
    );
    expect(secretBoundaryCheck).toContain("AUDIT_LOG_READ:1");
    expect(secretBoundaryCheck).toContain("LOG_MARKER_FOUND:1");
    expect(secretBoundaryCheck).toContain("assert_no_rejected_interval_audit_logs");
    expect(secretBoundaryCheck).toContain("assert_no_rejected_interval_network_logs");
    expect(secretBoundaryCheck).toContain("sha256sum ${DEEPAGENTS_ENV_FILE@Q}");
    expect(cloudExperimentalChecksForOnboarding("cloud-langchain-deepagents-code")).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
    ]);
  });

  it("ships a headless inference acceptance check for Deep Agents Code", () => {
    const headlessCheck = fs.readFileSync(headlessCheckPath, "utf8");

    expect(headlessCheck).toContain("test -d /sandbox/.deepagents && command -v dcode");
    expect(headlessCheck).toContain("dcode -n 'Reply with exactly one word: PONG'");
    expect(headlessCheck).toContain("https://inference\\.local(/v1)?");
    expect(headlessCheck).toContain("references_managed_placeholder_key");
    expect(headlessCheck).toContain(
      'api_key_env[[:space:]]*=[[:space:]]*"DEEPAGENTS_CODE_OPENAI_API_KEY"',
    );
    expect(headlessCheck).toContain("classify_headless_output");
    expect(headlessCheck).toContain("DEEPAGENTS_HEADLESS_TIMEOUT must be a positive integer");
    expect(headlessCheck).toContain("nvapi-");
    expect(headlessCheck).toContain("nvcf-");
    expect(headlessCheck).toContain("ghp_");
    expect(headlessCheck).toContain("github_pat_");
    expect(headlessCheck).toContain("sk-proj-");
    expect(headlessCheck).toContain("sk-ant-");
    expect(headlessCheck).toContain("xapp");
    expect(headlessCheck).toContain("A(K|S)IA");
    expect(headlessCheck).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(headlessCheck).toContain("sandbox_artifact_scan_command");
    expect(headlessCheck).toContain('cat /sandbox/.deepagents/config.toml 2>/dev/null" || true');
    expect(headlessCheck).toContain("find /sandbox/.deepagents -maxdepth 3 -type f");
    expect(headlessCheck).toContain('-name "*.log"');
    expect(headlessCheck).not.toContain("config_output:0:200");
  });

  it("requires the managed inference route and placeholder key in Deep Agents Code config", () => {
    expect(
      runHeadlessCheckHelper(
        'printf "%s" "$CONFIG" | references_managed_inference_route && printf route',
        { CONFIG: 'base_url = "https://inference.local/v1"' },
      ),
    ).toBe("route");
    expect(
      runHeadlessCheckHelper(
        'printf "%s" "$CONFIG" | references_managed_placeholder_key && printf key',
        { CONFIG: 'api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"' },
      ),
    ).toBe("key");
  });

  it("classifies Deep Agents Code headless output without accepting local failures", () => {
    const classify = (exitCode: string, output: string) =>
      runHeadlessCheckHelper(
        [
          'if classification="$(classify_headless_output "$DCODE_EXIT" "$HEADLESS_OUTPUT")"; then',
          '  printf "pass:%s" "$classification";',
          "else",
          '  printf "fail:%s" "$classification";',
          "fi",
        ].join(" "),
        { DCODE_EXIT: exitCode, HEADLESS_OUTPUT: output },
      );

    expect(classify("0", "PONG\nDCODE_EXIT:0")).toBe("pass:pong");
    expect(
      classify("1", "OpenAI provider returned HTTP 401 for inference.local\nDCODE_EXIT:1"),
    ).toBe("pass:actionable-inference-error");
    expect(classify("124", "still waiting\nDCODE_EXIT:124")).toBe("fail:timeout");
    expect(classify("1", "usage: dcode [-h]\nDCODE_EXIT:1")).toBe("fail:local-execution-failure");
    expect(classify("1", "Traceback (most recent call last):\nDCODE_EXIT:1")).toBe(
      "fail:local-execution-failure",
    );
    expect(classify("1", "something happened\nDCODE_EXIT:1")).toBe("fail:ambiguous-output");
  });

  it("rejects unsafe headless timeout values before sandbox execution", () => {
    const validate = (timeout: string) =>
      runHeadlessCheckHelper(
        'if is_positive_integer "$HEADLESS_TIMEOUT"; then printf valid; else printf invalid; fi',
        { DEEPAGENTS_HEADLESS_TIMEOUT: timeout },
      );

    expect(validate("120")).toBe("valid");
    expect(validate("0")).toBe("invalid");
    expect(validate("1; touch /tmp/nemoclaw-timeout-injection")).toBe("invalid");
  });

  it("detects representative secret families in headless inference artifacts", () => {
    const detectsSecret = (token: string) =>
      runHeadlessCheckHelper(
        'if printf "%s" "$TOKEN" | contains_secret; then printf secret; else printf clean; fi',
        { TOKEN: token },
      );
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
    expect(requirementsLock).toContain("deepagents-code==0.1.12 \\");
    expect(requirementsLock).toContain("langchain-nvidia-ai-endpoints==");
    expect(requirementsLock).toMatch(/--hash=sha256:[a-f0-9]{64}/);
  });

  it("records dependency advisory review for the lockfile", () => {
    const review = readAgentFile("dependency-review.md");

    expect(review).toContain("requirements.lock");
    expect(review).toContain("a0b986369ff564ed9105c4e95915541ccc161d6f1e8032cc496127ea3e7d2e45");
    expect(review).toContain(
      "pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off",
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

  it("allows nemoclaw-managed messaging tokens whose values are intentionally credential-shaped", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      SLACK_BOT_TOKEN: "xoxb-1234567890-abcdefghij",
      SLACK_APP_TOKEN: "xapp-1-A1B2C3-1234567890-abcdefghij",
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

  it("rejects unmanaged runtime env vars holding Telegram-shaped bot tokens", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const fakeTelegram = "987654321:AbcDefGhiJklMnoPqrStuVwxYz012345678";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { STRAY_TG_TOKEN: fakeTelegram });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STRAY_TG_TOKEN");
    expect(result.stderr).not.toContain(fakeTelegram);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects unmanaged runtime env vars holding Discord-shaped bot tokens", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const fakeDiscord = "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { STRAY_DISCORD: fakeDiscord });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STRAY_DISCORD");
    expect(result.stderr).not.toContain(fakeDiscord);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects Telegram-shaped tokens written to the deepagents env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeTelegram = "111222333:AbcDefGhiJklMnoPqrStuVwxYz012345678";
    fs.writeFileSync(envFile, `OTHER_BOT=${fakeTelegram}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OTHER_BOT");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeTelegram);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects Discord-shaped tokens written to the deepagents env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeDiscord = "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    fs.writeFileSync(envFile, `STRAY_DISCORD_FILE=${fakeDiscord}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STRAY_DISCORD_FILE");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeDiscord);
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

  it("passes through when no secret-shaped value is present in env or file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(
      envFile,
      ["# comment", "DISCORD_ALLOWED_USERS=alice,bob", "MODEL_NAME=gpt-4"].join("\n"),
      "utf8",
    );

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects non-messaging secret shapes carried by managed runtime env names", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "SLACK_BOT_TOKEN", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "SLACK_APP_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "TELEGRAM_BOT_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "DISCORD_BOT_TOKEN", sample: "AKIAABCDEFGHIJKLMNOP" },
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

  it("rejects export-prefixed env-file entries that carry opaque credential-name payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-export-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const opaque = "opaqueCredentialPayloadZ1234567890";
    fs.writeFileSync(envFile, `export OPENAI_API_KEY=${opaque}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects export-prefixed env-file entries that carry token-prefix secrets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-export-tok-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `export OPENAI_API_KEY=${fakeSecret}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeSecret);
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

  it("rejects dotenv variable expansion in env-file entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-dynamic-var-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, "MY_CRED=$OTHER_SECRET\n", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MY_CRED");
    expect(result.stderr).toContain("dynamic value");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects dotenv command substitution in env-file entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-dynamic-cmd-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, "MY_CRED=$(whoami)\n", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MY_CRED");
    expect(result.stderr).toContain("dynamic value");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects dotenv backtick substitution in env-file entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-dynamic-bt-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, "MY_CRED=`whoami`\n", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MY_CRED");
    expect(result.stderr).toContain("dynamic value");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects bearer-wrapped secret values carried in runtime env vars", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-bearer-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-abcdefghijklmnopqrstuvwx";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      CUSTOM_HEADER: `Bearer ${fakeSecret}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CUSTOM_HEADER");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects embedded secret values carried in runtime env vars", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-embedded-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-abcdefghijklmnopqrstuvwx";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      EMBEDDED_HOST_HEADER: `prefix-${fakeSecret}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EMBEDDED_HOST_HEADER");
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
      { name: "xoxa", sample: "xoxa-1234567890" },
      { name: "xoxs", sample: "xoxs-1234567890" },
      { name: "xapp", sample: "xapp-1-A1B2C3-12345-abcde" },
      { name: "akia", sample: "AKIAABCDEFGHIJKLMNOP" },
      { name: "asia", sample: "ASIAABCDEFGHIJKLMNOP" },
      { name: "hf", sample: "hf_abcdefghijklmnopq" },
      { name: "glpat", sample: "glpat-abcdefghijklmn" },
      { name: "gsk", sample: "gsk_abcdefghijklmnop" },
      { name: "pypi", sample: "pypi-abcdefghijklmnop" },
      { name: "telegram", sample: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      { name: "telegram_bot", sample: "bot123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      {
        name: "discord",
        sample: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
      },
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

  it("patches direct module execution back to NemoClaw managed posture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
    const packageDir = path.join(tempDir, "deepagents_code");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(packageDir, "main.py"),
      [
        "import os",
        "from types import SimpleNamespace",
        "",
        "class Parser:",
        "    def __init__(self):",
        "        self.args = SimpleNamespace(",
        "            command=None,",
        "            sandbox='docker',",
        "            sandbox_id='sandbox-id',",
        "            sandbox_snapshot_name='snapshot',",
        "            sandbox_setup='setup.sh',",
        "            mcp_config='mcp.json',",
        "            no_mcp=False,",
        "            trust_project_mcp=True,",
        "            shell_allow_list=['bash'],",
        "        )",
        "",
        "    def parse_args(self):",
        "        return self.args",
        "",
        "    def error(self, message):",
        "        raise RuntimeError(message)",
        "",
        "parser = Parser()",
        "",
        "def parse_args():",
        "    args = parser.parse_args()",
        "    return args",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync("python3", [path.join(agentDir, "patch-managed-deepagents-code.py")], {
      env: { ...process.env, PYTHONPATH: tempDir },
    });

    const patched = fs.readFileSync(path.join(packageDir, "main.py"), "utf8");
    expect(patched).toContain('args.sandbox = "none"');
    expect(patched).toContain("args.no_mcp = True");
    expect(patched).toContain("args.mcp_config = None");
    expect(patched).toContain("args.shell_allow_list = None");
    expect(patched).toContain('os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)');
    expect(patched).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(patched).toContain('getattr(args, "command", None) == "mcp"');

    const output = execFileSync(
      "python3",
      [
        "-c",
        [
          "import os",
          "import deepagents_code.main as main",
          "os.environ['DEEPAGENTS_CODE_SHELL_ALLOW_LIST'] = 'bash'",
          "args = main.parse_args()",
          "assert args.sandbox == 'none', args.sandbox",
          "assert args.sandbox_id is None, args.sandbox_id",
          "assert args.sandbox_snapshot_name is None, args.sandbox_snapshot_name",
          "assert args.sandbox_setup is None, args.sandbox_setup",
          "assert args.mcp_config is None, args.mcp_config",
          "assert args.no_mcp is True, args.no_mcp",
          "assert args.trust_project_mcp is False, args.trust_project_mcp",
          "assert args.shell_allow_list is None, args.shell_allow_list",
          "assert 'DEEPAGENTS_CODE_SHELL_ALLOW_LIST' not in os.environ",
          "main.parser.args.command = 'mcp'",
          "try:",
          "    main.parse_args()",
          "except RuntimeError as exc:",
          "    assert 'MCP commands are disabled' in str(exc), exc",
          "else:",
          "    raise AssertionError('mcp command did not fail')",
          "print('managed-posture-ok')",
        ].join("\n"),
      ],
      { env: { ...process.env, PYTHONPATH: tempDir }, encoding: "utf8" },
    );
    expect(output).toContain("managed-posture-ok");
  });
});
