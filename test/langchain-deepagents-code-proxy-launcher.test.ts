// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isValidProxyHost, isValidProxyPort } from "../src/lib/onboard/dockerfile-patch.ts";
import { TRUSTED_FETCH_PROXY_ENV_NAME } from "./helpers/langchain-deepagents-code-headless.ts";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const headlessCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "07-deepagents-code-headless-inference.sh",
);
const PROXY_URL_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;
const CLEARED_PROXY_ENV_NAMES = ["ALL_PROXY", "all_proxy", "OPENAI_PROXY"] as const;
const DEFAULT_MANAGED_PROXY = { host: "10.200.0.1", port: "3128" } as const;
const OBSERVABILITY_MARKER_NAME = ".nemoclaw-observability-enabled";
const TEST_OWNER_UID = process.getuid?.() ?? 0;

function observabilityMarkerPath(tempDir: string): string {
  return path.join(tempDir, "persistent-dcode-state", OBSERVABILITY_MARKER_NAME);
}

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function writeManagedProxyFiles(
  tempDir: string,
  managedProxy: { host: string; port: string },
): void {
  const hostFile = path.join(tempDir, "trusted-proxy-host");
  const portFile = path.join(tempDir, "trusted-proxy-port");
  fs.rmSync(hostFile, { force: true });
  fs.rmSync(portFile, { force: true });
  fs.writeFileSync(hostFile, `${managedProxy.host}\n`);
  fs.writeFileSync(portFile, `${managedProxy.port}\n`);
  fs.chmodSync(hostFile, 0o444);
  fs.chmodSync(portFile, 0o444);
}

function replaceManagedProxyFileConstants(source: string, tempDir: string): string {
  const rlimitLib = path.join(tempDir, "sandbox-rlimits.sh");
  fs.writeFileSync(
    rlimitLib,
    "harden_resource_limits() { :; }\nverify_resource_limits_exact() { :; }\n",
    "utf8",
  );
  return source
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${path.join(tempDir, "trusted-proxy-host")}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${path.join(tempDir, "trusted-proxy-port")}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${TEST_OWNER_UID}`,
    );
}

function makeLauncherProxyProbeFixture(
  tempDir: string,
  managedProxy: { host: string; port: string } = DEFAULT_MANAGED_PROXY,
): string {
  const launcherPath = path.join(tempDir, "dcode-launcher.sh");
  const probePath = path.join(tempDir, "managed-dcode-probe.sh");
  const probe = [
    "#!/bin/bash -p",
    `for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy ALL_PROXY all_proxy OPENAI_PROXY ${TRUSTED_FETCH_PROXY_ENV_NAME} NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT NEMOCLAW_OBSERVABILITY; do`,
    '  printf \'LAUNCHER_%s=%s\\n\' "$name" "${!name-__unset__}"',
    "done",
    "",
  ].join("\n");
  const fixture = replaceManagedProxyFileConstants(
    readAgentFile("dcode-launcher.sh")
      .replace(
        'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
        `readonly MANAGED_DCODE_WRAPPER="${probePath}"`,
      )
      .replace(
        'readonly MANAGED_OBSERVABILITY_MARKER="/sandbox/.deepagents/.nemoclaw-observability-enabled"',
        `readonly MANAGED_OBSERVABILITY_MARKER="${observabilityMarkerPath(tempDir)}"`,
      ),
    tempDir,
  );
  fs.writeFileSync(probePath, probe, "utf8");
  fs.writeFileSync(launcherPath, fixture, "utf8");
  writeManagedProxyFiles(tempDir, managedProxy);
  fs.chmodSync(probePath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function makeStartProxyProbeFixture(
  tempDir: string,
  managedProxy: { host: string; port: string } = DEFAULT_MANAGED_PROXY,
): { envFile: string; ephemeralDir: string; markerFile: string; scriptPath: string } {
  const ephemeralDir = path.join(tempDir, "ephemeral-tmp");
  const envFile = path.join(ephemeralDir, "proxy-env.sh");
  const markerFile = observabilityMarkerPath(tempDir);
  const markerDir = path.dirname(markerFile);
  const scriptPath = path.join(tempDir, "start.sh");
  fs.mkdirSync(ephemeralDir);
  const fixture = replaceManagedProxyFileConstants(readAgentFile("start.sh"), tempDir)
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${ephemeralDir}/nemoclaw-proxy-env.XXXXXX")"`,
    )
    .replace("local marker_dir=/sandbox/.deepagents", `local marker_dir="${markerDir}"`);
  fs.writeFileSync(scriptPath, fixture, "utf8");
  writeManagedProxyFiles(tempDir, managedProxy);
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, ephemeralDir, markerFile, scriptPath };
}

function runLauncher(
  launcherPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [launcherPath, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
}

function shellValidatorAccepts(source: string, name: string, value: string): boolean {
  const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  expect(match, `${name} must exist`).not.toBeNull();
  const definition = match?.[0] ?? "";
  return spawnSync("bash", ["-c", `${definition}\n${name} "$1"`, "bash", value]).status === 0;
}

describe("Deep Agents Code direct-exec proxy launcher", () => {
  it("preserves the empty-prompt failure through the installed launcher chain (#6440)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-empty-prompt-"));
    try {
      const launcherPath = path.join(tempDir, "dcode-launcher.sh");
      const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
      const launcher = replaceManagedProxyFileConstants(
        readAgentFile("dcode-launcher.sh").replace(
          'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
          `readonly MANAGED_DCODE_WRAPPER="${wrapperPath}"`,
        ),
        tempDir,
      );
      fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });
      fs.writeFileSync(wrapperPath, readAgentFile("dcode-wrapper.sh"), { mode: 0o755 });
      writeManagedProxyFiles(tempDir, DEFAULT_MANAGED_PROXY);

      const result = runLauncher(launcherPath, ["-n", ""], {});

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "NemoClaw: empty non-interactive prompt for -n; provide prompt text.\n",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores hostile PATH and BASH_ENV before launcher and entrypoint normalization", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-shell-entry-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { scriptPath } = makeStartProxyProbeFixture(tempDir);
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
    const hostileEnv = {
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      BASH_ENV: bashEnv,
    };

    const launcherResult = spawnSync(launcherPath, ["-n", "PONG"], {
      env: hostileEnv,
      encoding: "utf8",
    });
    const startResult = spawnSync(scriptPath, ["/usr/bin/true"], {
      env: hostileEnv,
      encoding: "utf8",
    });

    expect(launcherResult.status, launcherResult.stderr).toBe(0);
    expect(startResult.status, startResult.stderr).toBe(0);
    expect(fs.existsSync(fakeBashMarker)).toBe(false);
    expect(fs.existsSync(bashEnvMarker)).toBe(false);
  });

  it("normalizes proxy state for direct dcode launcher execution (#6191)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-direct-proxy-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir, {
      host: "managed-proxy.internal",
      port: "65535",
    });
    const result = runLauncher(launcherPath, ["-n", "PONG"], {
      HTTP_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      HTTPS_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      NO_PROXY: "corp.internal,inference.local",
      http_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      https_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      no_proxy: "corp.internal,inference.local",
      ALL_PROXY: "socks5://all-user:all-password@all-proxy.example:1080",
      all_proxy: "socks5://lower-all-user:lower-all-password@lower-all-proxy.example:1080",
      OPENAI_PROXY: "http://openai-user:openai-password@attacker.example:8080",
    });

    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    const managedProxy = "http://managed-proxy.internal:65535";
    const managedNoProxy = "localhost,127.0.0.1,::1,managed-proxy.internal";
    for (const name of PROXY_URL_ENV_NAMES) {
      expect(lines).toContain(`LAUNCHER_${name}=${managedProxy}`);
    }
    expect(lines).toContain(`LAUNCHER_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
    for (const name of NO_PROXY_ENV_NAMES) {
      expect(lines).toContain(`LAUNCHER_${name}=${managedNoProxy}`);
    }
    for (const name of CLEARED_PROXY_ENV_NAMES) {
      expect(lines).toContain(`LAUNCHER_${name}=__unset__`);
    }
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("inference.local");
    expect(output).not.toContain("corp-proxy.example");
    expect(output).not.toContain("corp-user");
    expect(output).not.toContain("corp-password");
    expect(output).not.toContain("all-proxy.example");
    expect(output).not.toContain("all-password");
  });

  it("recovers the exact observability bit after ephemeral runtime state resets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { ephemeralDir, markerFile, scriptPath } = makeStartProxyProbeFixture(tempDir);

    const noncanonicalStart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEMOCLAW_OBSERVABILITY: "true",
      },
      encoding: "utf8",
    });
    const noncanonicalLaunch = runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    expect(noncanonicalStart.status, noncanonicalStart.stderr).toBe(0);
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(noncanonicalLaunch.status, noncanonicalLaunch.stderr).toBe(0);
    expect(noncanonicalLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");

    const enabledStart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEMOCLAW_OBSERVABILITY: "1",
      },
      encoding: "utf8",
    });
    expect(enabledStart.status, enabledStart.stderr).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toBe("1\n");
    expect(fs.statSync(markerFile).mode & 0o777).toBe(0o444);

    const policyRestart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(policyRestart.status, policyRestart.stderr).toBe(0);
    const restartedLaunch = runLauncher(launcherPath, [], {});
    expect(restartedLaunch.status, restartedLaunch.stderr).toBe(0);
    expect(restartedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=1");

    fs.rmSync(ephemeralDir, { recursive: true, force: true });
    expect(fs.existsSync(markerFile)).toBe(true);
    const enabledLaunch = runLauncher(launcherPath, [], {});
    expect(enabledLaunch.status, enabledLaunch.stderr).toBe(0);
    expect(enabledLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=1");

    fs.mkdirSync(ephemeralDir, { recursive: true });
    const disabledStart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEMOCLAW_OBSERVABILITY: "0",
      },
      encoding: "utf8",
    });
    expect(disabledStart.status, disabledStart.stderr).toBe(0);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it("ignores tampered, symlinked, and non-regular observability markers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { scriptPath } = makeStartProxyProbeFixture(tempDir);
    const markerFile = observabilityMarkerPath(tempDir);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });

    fs.writeFileSync(markerFile, "true\n", { encoding: "utf8", mode: 0o644 });
    const tamperedLaunch = runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    expect(tamperedLaunch.status, tamperedLaunch.stderr).toBe(0);
    expect(tamperedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");

    fs.rmSync(markerFile);
    fs.mkdirSync(markerFile);
    const nonRegularLaunch = runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    const nonRegularStart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEMOCLAW_OBSERVABILITY: "1",
      },
      encoding: "utf8",
    });
    expect(nonRegularLaunch.status, nonRegularLaunch.stderr).toBe(0);
    expect(nonRegularLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");
    expect(nonRegularStart.status).not.toBe(0);
    expect(nonRegularStart.stderr).toContain("Unsafe managed observability marker target");

    fs.rmSync(markerFile, { recursive: true });
    const symlinkTarget = path.join(tempDir, "observability-symlink-target");
    fs.writeFileSync(symlinkTarget, "1\n", "utf8");
    fs.symlinkSync(symlinkTarget, markerFile);
    const symlinkedLaunch = runLauncher(launcherPath, [], {});
    const symlinkedStart = spawnSync("bash", [scriptPath, "/usr/bin/true"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(symlinkedLaunch.status, symlinkedLaunch.stderr).toBe(0);
    expect(symlinkedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");
    expect(symlinkedStart.status).not.toBe(0);
    expect(symlinkedStart.stderr).toContain("Unsafe managed observability marker target");
  });

  it("pins validated proxy overrides into direct dcode execution paths (#6191)", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const launcher = readAgentFile("dcode-launcher.sh");

    expect(dockerfile).toContain("ARG NEMOCLAW_PROXY_HOST=10.200.0.1");
    expect(dockerfile).toContain("ARG NEMOCLAW_PROXY_PORT=3128");
    expect(dockerfile).toContain("printf '%s\\n' \"$NEMOCLAW_PROXY_HOST\"");
    expect(dockerfile).toContain("printf '%s\\n' \"$NEMOCLAW_PROXY_PORT\"");
    expect(dockerfile).toContain("chmod 0444 /usr/local/share/nemoclaw/dcode-proxy-host");
    expect(dockerfile).toContain("chown root:root /usr/local/share/nemoclaw/dcode-proxy-host");
    expect(dockerfile).not.toContain("    NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST}");
    expect(dockerfile).not.toContain("    NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT}");
    expect(launcher).toContain('readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw');
    expect(launcher).toContain("Runtime env is untrusted and cannot override");
    expect(launcher).toContain('"${MANAGED_PROXY_OWNER_UID}:444"');
    expect(launcher).toContain(
      'export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"',
    );
    expect(launcher).toContain('export HTTPS_PROXY="$_PROXY_URL"');
    expect(launcher).toContain('export DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL="$_PROXY_URL"');
    expect(launcher).toContain('export no_proxy="$_NO_PROXY_VAL"');
    expect(launcher).toContain("unset ALL_PROXY all_proxy OPENAI_PROXY");
  });

  it("does not let runtime config override the image-baked dcode proxy (#6191)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-trusted-proxy-"));
    const trustedProxy = { host: "trusted-proxy.internal", port: "3129" };
    const launcherPath = makeLauncherProxyProbeFixture(tempDir, trustedProxy);
    const { envFile, scriptPath } = makeStartProxyProbeFixture(tempDir, trustedProxy);
    const untrustedEnv = {
      HTTP_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      NO_PROXY: "corp.internal,inference.local",
      ALL_PROXY: "socks5://all-user:all-password@all-proxy.example:1080",
      all_proxy: "socks5://lower-all-user:lower-all-password@lower-all-proxy.example:1080",
      OPENAI_PROXY: "http://openai-user:openai-password@attacker.example:8080",
      DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL: "http://attacker-proxy.internal:4444",
      NEMOCLAW_PROXY_HOST: "attacker-proxy.internal",
      NEMOCLAW_PROXY_PORT: "4444",
    };
    const launcherResult = runLauncher(launcherPath, ["-n", "PONG"], untrustedEnv);
    const startResult = spawnSync(
      "bash",
      [
        scriptPath,
        "bash",
        "-c",
        'printf \'START_PROXY=%s|%s|%s|%s|%s|%s\\n\' "$HTTPS_PROXY" "$NO_PROXY" "${NEMOCLAW_PROXY_HOST-__unset__}" "${NEMOCLAW_PROXY_PORT-__unset__}" "${ALL_PROXY-__unset__}" "${all_proxy-__unset__}"',
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...untrustedEnv },
        encoding: "utf8",
      },
    );

    expect(launcherResult.status, launcherResult.stderr).toBe(0);
    expect(startResult.status, startResult.stderr).toBe(0);
    const envFileText = fs.readFileSync(envFile, "utf8");
    const launcherNoProxy = launcherResult.stdout.match(/^LAUNCHER_NO_PROXY=(.*)$/m)?.[1];
    const startNoProxy = startResult.stdout.match(/^START_PROXY=[^|]*\|([^|]*)\|/m)?.[1];
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o444);
    expect(startResult.stdout).toContain(
      "START_PROXY=http://trusted-proxy.internal:3129|localhost,127.0.0.1,::1,trusted-proxy.internal|__unset__|__unset__|__unset__|__unset__",
    );
    expect(envFileText).toContain("export HTTPS_PROXY=http://trusted-proxy.internal:3129");
    expect(envFileText).toContain(
      "export DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL=http://trusted-proxy.internal:3129",
    );
    expect(launcherResult.stdout).toContain(
      "LAUNCHER_DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL=http://trusted-proxy.internal:3129",
    );
    expect(envFileText).toContain(
      "export NO_PROXY=localhost\\,127.0.0.1\\,::1\\,trusted-proxy.internal",
    );
    expect(envFileText).toContain("unset ALL_PROXY all_proxy OPENAI_PROXY");
    expect(envFileText).not.toMatch(/^export (?:ALL_PROXY|all_proxy|OPENAI_PROXY)=/m);
    // The two standalone shell boundaries construct the same exclusion list.
    // TypeScript does not reconstruct NO_PROXY; its connect probe deliberately
    // sources this persisted value from /tmp/nemoclaw-proxy-env.sh.
    expect(launcherNoProxy).toBe("localhost,127.0.0.1,::1,trusted-proxy.internal");
    expect(startNoProxy).toBe(launcherNoProxy);
    const combined = `${launcherResult.stdout}\n${launcherResult.stderr}\n${startResult.stdout}\n${startResult.stderr}\n${envFileText}`;
    expect(combined).toContain("http://trusted-proxy.internal:3129");
    expect(combined).toContain("localhost,127.0.0.1,::1,trusted-proxy.internal");
    expect(combined).not.toContain("attacker-proxy.internal");
    expect(combined).not.toContain("corp-proxy.example");
    expect(combined).not.toContain("corp-password");
    expect(combined).not.toContain("all-proxy.example");
    expect(combined).not.toContain("all-password");
  });

  it("fails closed when the image-baked dcode proxy contract is missing (#6191)", () => {
    for (const missingFile of ["trusted-proxy-host", "trusted-proxy-port"]) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-missing-proxy-"));
      const launcherPath = makeLauncherProxyProbeFixture(tempDir);
      const { scriptPath } = makeStartProxyProbeFixture(tempDir);
      fs.unlinkSync(path.join(tempDir, missingFile));
      const launcherResult = runLauncher(launcherPath, ["-n", "PONG"], {
        NEMOCLAW_PROXY_HOST: "attacker-proxy.internal",
        NEMOCLAW_PROXY_PORT: "4444",
      });
      const startResult = spawnSync("bash", [scriptPath, "true"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NEMOCLAW_PROXY_HOST: "attacker-proxy.internal",
          NEMOCLAW_PROXY_PORT: "4444",
        },
        encoding: "utf8",
      });

      expect(launcherResult.status).not.toBe(0);
      expect(startResult.status).not.toBe(0);
      const combined = `${launcherResult.stdout}\n${launcherResult.stderr}\n${startResult.stdout}\n${startResult.stderr}`;
      expect(combined).toContain("trusted managed proxy");
      expect(combined).not.toContain("attacker-proxy.internal");
    }
  });

  it("rejects writable image-baked dcode proxy files (#6191)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-proxy-mode-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { scriptPath } = makeStartProxyProbeFixture(tempDir);
    fs.chmodSync(path.join(tempDir, "trusted-proxy-host"), 0o644);
    const launcherResult = runLauncher(launcherPath, ["-n", "PONG"], {});
    const startResult = spawnSync("bash", [scriptPath, "true"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });

    expect(launcherResult.status).not.toBe(0);
    expect(startResult.status).not.toBe(0);
    expect(`${launcherResult.stderr}\n${startResult.stderr}`).toContain(
      "Unsafe ownership or mode on trusted managed proxy host file",
    );
  });

  it("keeps dcode shell proxy validators aligned with onboard validation (#6191)", () => {
    const start = readAgentFile("start.sh");
    const launcher = readAgentFile("dcode-launcher.sh");
    const hostSamples = [
      "10.200.0.1",
      "managed-proxy.internal",
      "proxy_name",
      "http://proxy.internal",
      "user:password@proxy.internal",
      "proxy.internal/path",
      "proxy internal",
      "proxy.internal\ninjected",
      "",
    ];
    const portSamples = ["1", "3128", "65535", "00001", "0", "65536", "000001", "12a", ""];

    for (const value of hostSamples) {
      const expected = isValidProxyHost(value);
      expect(shellValidatorAccepts(start, "is_valid_proxy_host", value), value).toBe(expected);
      expect(shellValidatorAccepts(launcher, "is_valid_proxy_host", value), value).toBe(expected);
    }
    for (const value of portSamples) {
      const expected = isValidProxyPort(value);
      expect(shellValidatorAccepts(start, "is_valid_proxy_port", value), value).toBe(expected);
      expect(shellValidatorAccepts(launcher, "is_valid_proxy_port", value), value).toBe(expected);
    }
  });

  it("documents the proxy-only source boundary and removal condition (#6191)", () => {
    const start = readAgentFile("start.sh");
    const launcher = readAgentFile("dcode-launcher.sh");
    const headlessCheck = fs.readFileSync(headlessCheckPath, "utf8");

    for (const marker of [
      "# Invalid state:",
      "# Source boundary:",
      "# Source-fix constraint:",
      "# Regression:",
      "# Removal condition:",
    ]) {
      expect(start).toContain(marker);
    }
    expect(start).toContain("Direct DNS/hosts resolution is not required");
    expect(launcher).toContain("Remove it only when OpenShell normalizes every sandbox exec/login");
    expect(headlessCheck).toContain("getent hosts inference.local >/dev/null 2>&1");
    expect(headlessCheck).toContain("direct inference.local DNS/hosts is absent");
    expect(headlessCheck).toContain('stat -c "%u:%a"');
    expect(headlessCheck).toContain("direct-exec dcode -n reached managed inference");
    expect(headlessCheck).toContain("connect --probe-only accepted the managed inference route");
  });

  it("rejects unsafe direct dcode proxy overrides before managed code runs (#6191)", () => {
    const rejectedOverrides = [
      { host: "corp-user:corp-password@proxy.example", port: "3128" },
      { host: "proxy.example/path", port: "3128" },
      { host: "10.200.0.1", port: "0" },
      { host: "10.200.0.1", port: "65536" },
    ];

    for (const managedProxy of rejectedOverrides) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-launch-invalid-"));
      const launcherPath = makeLauncherProxyProbeFixture(tempDir, managedProxy);
      const { scriptPath } = makeStartProxyProbeFixture(tempDir, managedProxy);
      const result = runLauncher(launcherPath, ["-n", "PONG"], {});
      const startResult = spawnSync("bash", [scriptPath, "true"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(startResult.status).not.toBe(0);
      expect(result.stdout).not.toContain("LAUNCHER_");
      for (const value of Object.values(managedProxy)) {
        expect(`${result.stdout}\n${result.stderr}\n${startResult.stderr}`).not.toContain(value);
      }
    }
  });
});
