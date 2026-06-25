// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_PREFIX_PATTERNS } from "../src/lib/security/secret-patterns.ts";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");

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

    expect(dockerfile).toContain("rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code");
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

  it("keeps optional service egress out of the default policy and requires Landlock", () => {
    const policy = readAgentFile("policy-additions.yaml");

    expect(policy).not.toContain("api.tavily.com");
    expect(policy).not.toContain("api.smith.langchain.com");
    expect(policy).toContain("    - /usr\n");
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
    expect(landlockCheck).toContain("touch /etc/deepagents-landlock-test");
    expect(landlockCheck).toContain("touch /tmp/deepagents-landlock-test");
    expect(landlockCheck).toContain("/usr is Landlock read-only for Deep Agents Code");
    expect(landlockCheck).toContain("/etc is Landlock read-only for Deep Agents Code");
    expect(pythonEgressCheck).toContain("python3 - ${url@Q} <<'PY'");
    expect(pythonEgressCheck).toContain('expect_reached "GitHub" "https://api.github.com/"');
    expect(pythonEgressCheck).toContain('expect_reached "PyPI" "https://pypi.org/"');
    expect(pythonEgressCheck).toContain("https://api.tavily.com/");
    expect(pythonEgressCheck).toContain("https://api.smith.langchain.com/");
    expect(pythonEgressCheck).toContain("https://modelcontextprotocol.io/");
    expect(pythonEgressCheck).toContain("https://example.com/");
    expect(pythonEgressCheck).toContain(
      "arbitrary Python cannot reach ${label} without explicit policy",
    );
  });

  it("hash-locks Deep Agents Code base image PyPI installs", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const requirementsLock = readAgentFile("requirements.lock");

    expect(baseDockerfile).toContain("COPY agents/langchain-deepagents-code/requirements.lock");
    expect(baseDockerfile).toContain("--require-hashes");
    expect(baseDockerfile).toContain("--ignore-installed");
    expect(baseDockerfile).toContain("-r /tmp/deepagents-code-requirements.lock");
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
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stderr).toContain("nemoclaw credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
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

  it("pins the wrapper parity contract to the canonical TOKEN_PREFIX_PATTERNS count to surface drift", () => {
    expect(Array.isArray(TOKEN_PREFIX_PATTERNS)).toBe(true);
    expect(TOKEN_PREFIX_PATTERNS.length).toBe(16);
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
