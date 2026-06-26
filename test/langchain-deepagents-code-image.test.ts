// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { cloudExperimentalChecksForOnboarding } from "./e2e-scenario/live/cloud-experimental-check-list.ts";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const DCODE_CANONICAL_PATH =
  "/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function policyBinaryPaths(policyText: string, policyName: string): string[] {
  const parsed = YAML.parse(policyText) as {
    network_policies?: Record<string, { binaries?: Array<{ path?: unknown }> }>;
  };
  const binaries = parsed.network_policies?.[policyName]?.binaries;
  expect(Array.isArray(binaries), `${policyName} policy must declare binary-scoped egress`).toBe(
    true,
  );
  return (binaries ?? []).map((entry) => (typeof entry.path === "string" ? entry.path : ""));
}

function makeStartScriptFixture(tempDir: string): {
  envFile: string;
  messagingEnvFile: string;
  scriptPath: string;
} {
  const envFile = path.join(tempDir, "proxy-env.sh");
  const messagingEnvFile = path.join(tempDir, "messaging.env");
  const scriptPath = path.join(tempDir, "start.sh");
  const fixture = readAgentFile("start.sh")
    .replace('local env_file="/sandbox/.deepagents/.env"', `local env_file="${messagingEnvFile}"`)
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`,
    );
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, messagingEnvFile, scriptPath };
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

  it("declares the messaging plan build arg before the DeepAgents build applier runs", () => {
    const dockerfile = readAgentFile("Dockerfile");

    expect(dockerfile).toContain("ARG NEMOCLAW_MESSAGING_PLAN_B64=");
    expect(dockerfile).toContain("NEMOCLAW_MESSAGING_PLAN_B64=${NEMOCLAW_MESSAGING_PLAN_B64}");
    expect(dockerfile.indexOf("ARG NEMOCLAW_MESSAGING_PLAN_B64=")).toBeLessThan(
      dockerfile.indexOf("messaging-build-applier.mts --agent langchain-deepagents-code"),
    );
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

  it("loads generated messaging env values literally without command execution", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, messagingEnvFile, scriptPath } = makeStartScriptFixture(tempDir);
    const marker = path.join(tempDir, "nemoclaw-pwned");
    fs.writeFileSync(
      messagingEnvFile,
      [
        `DISCORD_ALLOWED_USERS=$(touch ${marker})`,
        `SLACK_ALLOWED_CHANNELS=C123;touch ${marker}`,
        `UNTRUSTED_KEY=$(touch ${marker})`,
      ].join("\n"),
      "utf8",
    );

    const output = execFileSync(
      "bash",
      [
        scriptPath,
        "sh",
        "-c",
        [
          'cat "$NEMOCLAW_TEST_PROXY_ENV"',
          'printf "\\nENV_DISCORD_ALLOWED_USERS=%s\\n" "$DISCORD_ALLOWED_USERS"',
          'printf "ENV_SLACK_ALLOWED_CHANNELS=%s\\n" "$SLACK_ALLOWED_CHANNELS"',
          'test ! -e "$NEMOCLAW_PWNED"',
        ].join("; "),
      ],
      {
        env: {
          NEMOCLAW_TEST_PROXY_ENV: envFile,
          NEMOCLAW_PWNED: marker,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain(`ENV_DISCORD_ALLOWED_USERS=$(touch ${marker})`);
    expect(output).toContain(`ENV_SLACK_ALLOWED_CHANNELS=C123;touch ${marker}`);
    expect(output).not.toContain("UNTRUSTED_KEY");
    expect(fs.existsSync(marker)).toBe(false);
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
    expect(cloudExperimentalChecksForOnboarding("cloud-langchain-deepagents-code")).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
    ]);
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
