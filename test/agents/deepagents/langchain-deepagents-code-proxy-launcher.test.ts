// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { TRUSTED_FETCH_PROXY_ENV_NAME } from "../../helpers/langchain-deepagents-code-headless.ts";
import {
  dcodeStateDir,
  makeStartScriptFixture,
  prepareManagedScriptFixture,
} from "../../support/dcode-start-script-fixture.ts";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const PROXY_URL_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;
const CLEARED_PROXY_ENV_NAMES = ["ALL_PROXY", "all_proxy", "OPENAI_PROXY"] as const;
const DEFAULT_TEST_PATH = process.env.PATH ?? "/usr/bin:/bin";
const OBSERVABILITY_MARKER_NAME = ".nemoclaw-observability-enabled";
const execFileAsync = promisify(execFile);

vi.setConfig({ maxConcurrency: 4 });

function observabilityMarkerPath(tempDir: string): string {
  return path.join(dcodeStateDir(tempDir), OBSERVABILITY_MARKER_NAME);
}

function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

function makeLauncherFixtureSource(source: string, tempDir: string): string {
  return prepareManagedScriptFixture(
    source.replace(
      'exec /opt/venv/bin/python3 -I "$MANAGED_SESSION_SUPERVISOR" "$MANAGED_DCODE_WRAPPER" "$@"',
      'exec "$MANAGED_DCODE_WRAPPER" "$@"',
    ),
    tempDir,
  );
}

function makeLauncherProxyProbeFixture(tempDir: string): string {
  const launcherPath = path.join(tempDir, "dcode-launcher.sh");
  const probePath = path.join(tempDir, "managed-dcode-probe.sh");
  const markerFile = observabilityMarkerPath(tempDir);
  const probe = [
    "#!/bin/bash -p",
    `for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy ALL_PROXY all_proxy OPENAI_PROXY ${TRUSTED_FETCH_PROXY_ENV_NAME} NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT NEMOCLAW_OBSERVABILITY; do`,
    '  printf \'LAUNCHER_%s=%s\\n\' "$name" "${!name-__unset__}"',
    "done",
    "",
  ].join("\n");
  const fixture = makeLauncherFixtureSource(
    readAgentFile("dcode-launcher.sh")
      .replace(
        'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
        `readonly MANAGED_DCODE_WRAPPER="${probePath}"`,
      )
      .replace(
        'readonly MANAGED_OBSERVABILITY_MARKER="/sandbox/.deepagents/.nemoclaw-observability-enabled"',
        `readonly MANAGED_OBSERVABILITY_MARKER="${markerFile}"`,
      ),
    tempDir,
  );
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(probePath, probe, "utf8");
  fs.writeFileSync(launcherPath, fixture, "utf8");
  fs.chmodSync(probePath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function makeStartProxyProbeFixture(tempDir: string): {
  envFile: string;
  ephemeralDir: string;
  markerFile: string;
  scriptPath: string;
} {
  const ephemeralDir = path.join(tempDir, "ephemeral-tmp");
  const markerFile = observabilityMarkerPath(tempDir);
  const { envFile, scriptPath } = makeStartScriptFixture(tempDir, {
    envDir: ephemeralDir,
    markerDir: path.dirname(markerFile),
  });
  return { envFile, ephemeralDir, markerFile, scriptPath };
}

async function runCommand(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  try {
    const { stderr, stdout } = await execFileAsync(file, [...args], {
      ...options,
      encoding: "utf8",
    });
    return { status: 0, stderr, stdout };
  } catch (error) {
    const result = error as { code?: unknown; stderr?: string; stdout?: string };
    return {
      status: typeof result.code === "number" ? result.code : null,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  }
}

function runLauncher(
  launcherPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return runCommand("bash", [launcherPath, ...args], {
    env: { PATH: DEFAULT_TEST_PATH, ...env },
  });
}

describe.concurrent("Deep Agents Code direct-exec proxy launcher", () => {
  it("exports OpenShell projected trust for startup and sourced shells", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-live-ca-"));
    try {
      const caFile = path.join(tempDir, "openshell-ca-bundle.crt");
      fs.writeFileSync(caFile, "OpenShell mediation CA and system roots\n", { mode: 0o444 });
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir, {
        caFile,
      });

      const liveResult = await runCommand("bash", [scriptPath, "true"], {
        env: {
          PATH: DEFAULT_TEST_PATH,
          SSL_CERT_FILE: "/ambient-live-ca.pem",
          REQUESTS_CA_BUNDLE: "/ambient-live-ca.pem",
          NODE_EXTRA_CA_CERTS: "/ambient-live-ca.pem",
        },
      });
      expect(liveResult.status, liveResult.stderr).toBe(0);
      const liveEnvironment = fs.readFileSync(envFile, "utf8");
      expect(liveEnvironment).toContain(`_nemoclaw_dcode_ca_bundle=${caFile}`);
      expect(liveEnvironment).toContain("export SSL_CERT_FILE=/ambient-live-ca.pem");
      expect(liveEnvironment).toContain("export REQUESTS_CA_BUNDLE=/ambient-live-ca.pem");
      expect(liveEnvironment).toContain("export NODE_EXTRA_CA_CERTS=/ambient-live-ca.pem");

      const projectedResult = await runCommand("bash", [scriptPath, "true"], {
        env: { PATH: DEFAULT_TEST_PATH },
      });
      expect(projectedResult.status, projectedResult.stderr).toBe(0);
      const projectedEnvironment = fs.readFileSync(envFile, "utf8");
      expect(projectedEnvironment).toContain(`_nemoclaw_dcode_ca_bundle=${caFile}`);
      expect(projectedEnvironment).toContain(`export SSL_CERT_FILE=${caFile}`);
      expect(projectedEnvironment).toContain(`export REQUESTS_CA_BUNDLE=${caFile}`);
      expect(projectedEnvironment).toContain(`export NODE_EXTRA_CA_CERTS=${caFile}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps read-only identity commands outside the session supervisor", () => {
    const launcher = readAgentFile("dcode-launcher.sh");
    const directIdentity =
      'status | whoami | identity | --version | -v | -V) exec "$MANAGED_DCODE_WRAPPER" "$@"';
    const supervisedSession =
      'exec /opt/venv/bin/python3 -I "$MANAGED_SESSION_SUPERVISOR" "$MANAGED_DCODE_WRAPPER" "$@"';

    expect(launcher).toContain(directIdentity);
    expect(launcher.indexOf(directIdentity)).toBeLessThan(launcher.indexOf(supervisedSession));
  });

  it("routes one-shot non-interactive sessions through the session supervisor (#6720)", () => {
    const launcher = readAgentFile("dcode-launcher.sh");
    const supervisedSession =
      'exec /opt/venv/bin/python3 -I "$MANAGED_SESSION_SUPERVISOR" "$MANAGED_DCODE_WRAPPER" "$@"';

    expect(launcher).not.toMatch(/-n\s*\|[^\n]*exec "\$MANAGED_DCODE_WRAPPER"/u);
    expect(launcher).not.toMatch(/--non-interactive[^\n]*exec "\$MANAGED_DCODE_WRAPPER"/u);
    expect(launcher).toContain(supervisedSession);
  });

  it("preserves the empty-prompt failure through the installed launcher chain (#6440)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-empty-prompt-"));
    try {
      const launcherPath = path.join(tempDir, "dcode-launcher.sh");
      const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
      const launcher = makeLauncherFixtureSource(
        readAgentFile("dcode-launcher.sh").replace(
          'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
          `readonly MANAGED_DCODE_WRAPPER="${wrapperPath}"`,
        ),
        tempDir,
      );
      fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });
      fs.writeFileSync(wrapperPath, readAgentFile("dcode-wrapper.sh"), { mode: 0o755 });

      const result = await runLauncher(launcherPath, ["-n", ""], {});

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "NemoClaw: empty non-interactive prompt for -n; provide prompt text.\n",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores hostile PATH and BASH_ENV before launcher and entrypoint normalization", async () => {
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
      PATH: `${fakeBin}:${DEFAULT_TEST_PATH}`,
      BASH_ENV: bashEnv,
    };

    const launcherResult = await runCommand(launcherPath, ["-n", "PONG"], {
      env: hostileEnv,
    });
    const startResult = await runCommand(scriptPath, ["/usr/bin/true"], {
      env: hostileEnv,
    });

    expect(launcherResult.status, launcherResult.stderr).toBe(0);
    expect(startResult.status, startResult.stderr).toBe(0);
    expect(fs.existsSync(fakeBashMarker)).toBe(false);
    expect(fs.existsSync(bashEnvMarker)).toBe(false);
  });

  it("clears ambient proxies before direct dcode execution", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-direct-proxy-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const result = await runLauncher(launcherPath, ["-n", "PONG"], {
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
    const managedProxy = "__unset__";
    const managedNoProxy = "__unset__";
    expect(
      PROXY_URL_ENV_NAMES.every((name) => lines.includes(`LAUNCHER_${name}=${managedProxy}`)),
    ).toBe(true);
    expect(lines).toContain(`LAUNCHER_${TRUSTED_FETCH_PROXY_ENV_NAME}=${managedProxy}`);
    expect(
      NO_PROXY_ENV_NAMES.every((name) => lines.includes(`LAUNCHER_${name}=${managedNoProxy}`)),
    ).toBe(true);
    expect(
      CLEARED_PROXY_ENV_NAMES.every((name) => lines.includes(`LAUNCHER_${name}=__unset__`)),
    ).toBe(true);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("inference.local");
    expect(output).not.toContain("corp-proxy.example");
    expect(output).not.toContain("corp-user");
    expect(output).not.toContain("corp-password");
    expect(output).not.toContain("all-proxy.example");
    expect(output).not.toContain("all-password");
  });

  it("recovers the exact observability bit after ephemeral runtime state resets", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { ephemeralDir, markerFile, scriptPath } = makeStartProxyProbeFixture(tempDir);

    const noncanonicalStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: DEFAULT_TEST_PATH,
        NEMOCLAW_OBSERVABILITY: "true",
      },
    });
    const noncanonicalLaunch = await runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    expect(noncanonicalStart.status, noncanonicalStart.stderr).toBe(0);
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(noncanonicalLaunch.status, noncanonicalLaunch.stderr).toBe(0);
    expect(noncanonicalLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");

    const enabledStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: DEFAULT_TEST_PATH,
        NEMOCLAW_OBSERVABILITY: "1",
      },
    });
    expect(enabledStart.status, enabledStart.stderr).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toBe("1\n");
    expect(fs.statSync(markerFile).mode & 0o777).toBe(0o444);

    const policyRestart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: { PATH: DEFAULT_TEST_PATH },
    });
    expect(policyRestart.status, policyRestart.stderr).toBe(0);
    const restartedLaunch = await runLauncher(launcherPath, [], {});
    expect(restartedLaunch.status, restartedLaunch.stderr).toBe(0);
    expect(restartedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=1");

    fs.rmSync(ephemeralDir, { recursive: true, force: true });
    expect(fs.existsSync(markerFile)).toBe(true);
    const enabledLaunch = await runLauncher(launcherPath, [], {});
    expect(enabledLaunch.status, enabledLaunch.stderr).toBe(0);
    expect(enabledLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=1");

    fs.mkdirSync(ephemeralDir, { recursive: true });
    const disabledStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: DEFAULT_TEST_PATH,
        NEMOCLAW_OBSERVABILITY: "0",
      },
    });
    expect(disabledStart.status, disabledStart.stderr).toBe(0);
    expect(fs.existsSync(markerFile)).toBe(false);
    const disabledLaunch = await runLauncher(launcherPath, [], { NEMOCLAW_OBSERVABILITY: "1" });
    expect(disabledLaunch.status, disabledLaunch.stderr).toBe(0);
    expect(disabledLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");
  });

  it("ignores tampered, symlinked, and non-regular observability markers", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { scriptPath } = makeStartProxyProbeFixture(tempDir);
    const markerFile = observabilityMarkerPath(tempDir);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });

    fs.writeFileSync(markerFile, "true\n", { encoding: "utf8", mode: 0o644 });
    const tamperedLaunch = await runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    expect(tamperedLaunch.status, tamperedLaunch.stderr).toBe(0);
    expect(tamperedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");

    fs.rmSync(markerFile);
    fs.mkdirSync(markerFile);
    const nonRegularLaunch = await runLauncher(launcherPath, [], {
      NEMOCLAW_OBSERVABILITY: "1",
    });
    const nonRegularStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: DEFAULT_TEST_PATH,
        NEMOCLAW_OBSERVABILITY: "1",
      },
    });
    const nonRegularDisabledStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: {
        PATH: DEFAULT_TEST_PATH,
        NEMOCLAW_OBSERVABILITY: "0",
      },
    });
    expect(nonRegularLaunch.status, nonRegularLaunch.stderr).toBe(0);
    expect(nonRegularLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");
    expect(nonRegularStart.status).not.toBe(0);
    expect(nonRegularStart.stderr).toContain("Unsafe managed observability marker target");
    expect(nonRegularDisabledStart.status).not.toBe(0);
    expect(nonRegularDisabledStart.stderr).toContain("Unsafe managed observability marker target");

    fs.rmSync(markerFile, { recursive: true });
    const symlinkTarget = path.join(tempDir, "observability-symlink-target");
    fs.writeFileSync(symlinkTarget, "1\n", "utf8");
    fs.symlinkSync(symlinkTarget, markerFile);
    const symlinkedLaunch = await runLauncher(launcherPath, [], {});
    const symlinkedStart = await runCommand("bash", [scriptPath, "/usr/bin/true"], {
      env: { PATH: DEFAULT_TEST_PATH },
    });
    expect(symlinkedLaunch.status, symlinkedLaunch.stderr).toBe(0);
    expect(symlinkedLaunch.stdout).toContain("LAUNCHER_NEMOCLAW_OBSERVABILITY=__unset__");
    expect(symlinkedStart.status).not.toBe(0);
    expect(symlinkedStart.stderr).toContain("Unsafe managed observability marker target");
  });

  it("clears ambient proxies in startup, sourced shells, and direct execution", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-trusted-proxy-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { envFile, scriptPath } = makeStartProxyProbeFixture(tempDir);
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
    const launcherResult = await runLauncher(launcherPath, ["-n", "PONG"], untrustedEnv);
    const startResult = await runCommand(
      "bash",
      [
        scriptPath,
        "bash",
        "-c",
        'printf \'START_PROXY=%s|%s|%s|%s|%s|%s\\n\' "${HTTPS_PROXY-__unset__}" "${NO_PROXY-__unset__}" "${NEMOCLAW_PROXY_HOST-__unset__}" "${NEMOCLAW_PROXY_PORT-__unset__}" "${ALL_PROXY-__unset__}" "${all_proxy-__unset__}"',
      ],
      {
        env: { PATH: DEFAULT_TEST_PATH, ...untrustedEnv },
      },
    );

    expect(launcherResult.status, launcherResult.stderr).toBe(0);
    expect(startResult.status, startResult.stderr).toBe(0);
    const envFileText = fs.readFileSync(envFile, "utf8");
    const posixSourceResult = await runCommand("sh", ["-c", '. "$1"', "sh", envFile], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(posixSourceResult.status, posixSourceResult.stderr).toBe(0);
    const launcherNoProxy = launcherResult.stdout.match(/^LAUNCHER_NO_PROXY=(.*)$/m)?.[1];
    const startNoProxy = startResult.stdout.match(/^START_PROXY=[^|]*\|([^|]*)\|/m)?.[1];
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o444);
    expect(startResult.stdout).toContain(
      "START_PROXY=__unset__|__unset__|__unset__|__unset__|__unset__|__unset__",
    );
    expect(envFileText).toContain(
      "unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy",
    );
    expect(launcherResult.stdout).toContain(
      "LAUNCHER_DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL=__unset__",
    );
    expect(launcherNoProxy).toBe("__unset__");
    expect(startNoProxy).toBe(launcherNoProxy);
    const combined = `${launcherResult.stdout}\n${launcherResult.stderr}\n${startResult.stdout}\n${startResult.stderr}\n${envFileText}`;
    expect(combined).not.toContain("attacker-proxy.internal");
    expect(combined).not.toContain("corp-proxy.example");
    expect(combined).not.toContain("corp-password");
    expect(combined).not.toContain("all-proxy.example");
    expect(combined).not.toContain("all-password");
  });

  const expectManagedCaBundleRejection = async ({
    expected,
    mutate,
  }: {
    expected: string;
    mutate: (caFile: string, scripts: string[]) => void;
  }): Promise<void> => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-ca-bundle-"));
    const launcherPath = makeLauncherProxyProbeFixture(tempDir);
    const { envFile, scriptPath } = makeStartProxyProbeFixture(tempDir);
    const caFile = path.join(tempDir, "trusted-ca-bundle.pem");

    const safeStart = await runCommand("bash", [scriptPath, "true"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(safeStart.status, safeStart.stderr).toBe(0);
    expect(fs.existsSync(envFile)).toBe(true);

    mutate(caFile, [launcherPath, scriptPath, envFile]);
    const env = { PATH: DEFAULT_TEST_PATH };
    const launcherResult = await runLauncher(launcherPath, ["-n", "PONG"], env);
    const startResult = await runCommand("bash", [scriptPath, "true"], {
      env,
    });
    const connectSourceResult = await runCommand("sh", ["-c", '. "$1"', "sh", envFile], {
      env,
    });

    expect(launcherResult.status).not.toBe(0);
    expect(startResult.status).not.toBe(0);
    expect(connectSourceResult.status).not.toBe(0);
    expect(launcherResult.stderr).toContain(expected);
    expect(startResult.stderr).toContain(expected);
    expect(connectSourceResult.stderr).toContain(expected);
    const combined = `${launcherResult.stderr}\n${startResult.stderr}\n${connectSourceResult.stderr}`;
    expect(combined).not.toContain(caFile);
  };

  it.each([
    {
      condition: "foreign-owned",
      expected: "Unsafe ownership or mode on managed fetch CA bundle file",
      mutate: (caFile: string, scripts: string[]) => {
        const statPath = path.join(path.dirname(caFile), "stat");
        fs.writeFileSync(
          statPath,
          `#!/bin/sh\nprintf '%s\\n' '${(process.getuid?.() ?? 0) + 1}:444:18'\n`,
          { mode: 0o755 },
        );
        const replaceStatObservation = (script: string): void => {
          const source = fs.readFileSync(script, "utf8");
          fs.chmodSync(script, 0o600);
          fs.writeFileSync(script, source.replaceAll("stat -", `${JSON.stringify(statPath)} -`));
        };
        replaceStatObservation(scripts[0]);
        replaceStatObservation(scripts[1]);
        replaceStatObservation(scripts[2]);
      },
    },
    {
      condition: "owner-writable",
      expected: "Unsafe ownership or mode on managed fetch CA bundle file",
      mutate: (caFile: string) => fs.chmodSync(caFile, 0o644),
    },
    {
      condition: "executable",
      expected: "Unsafe ownership or mode on managed fetch CA bundle file",
      mutate: (caFile: string) => fs.chmodSync(caFile, 0o544),
    },
    {
      condition: "writable",
      expected: "Unsafe ownership or mode on managed fetch CA bundle file",
      mutate: (caFile: string) => fs.chmodSync(caFile, 0o666),
    },
    {
      condition: "empty",
      expected: "Unsafe ownership or mode on managed fetch CA bundle file",
      mutate: (caFile: string) => {
        fs.chmodSync(caFile, 0o600);
        fs.truncateSync(caFile, 0);
        fs.chmodSync(caFile, 0o444);
      },
    },
    {
      condition: "non-regular",
      expected: "Missing or unsafe managed fetch CA bundle file",
      mutate: (caFile: string) => {
        fs.rmSync(caFile);
        fs.mkdirSync(caFile);
      },
    },
    {
      condition: "regular-file symlink",
      expected: "Missing or unsafe managed fetch CA bundle file",
      mutate: (caFile: string) => {
        const target = `${caFile}.target`;
        fs.renameSync(caFile, target);
        fs.symlinkSync(target, caFile);
      },
    },
    {
      condition: "dangling symlink",
      expected: "Missing or unsafe managed fetch CA bundle file",
      mutate: (caFile: string) => {
        fs.rmSync(caFile);
        fs.symlinkSync(`${caFile}.missing`, caFile);
      },
    },
  ])(
    "rejects $condition managed fetch CA bundles in start, connect, and direct dcode paths (#6636)",
    async ({ expected, mutate }) => {
      await expectManagedCaBundleRejection({ expected, mutate });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects an unreadable managed fetch CA bundle in start, connect, and direct dcode paths (#6636)",
    async () => {
      await expectManagedCaBundleRejection({
        expected: "Missing or unsafe managed fetch CA bundle file",
        mutate: (caFile: string) => fs.chmodSync(caFile, 0o000),
      });
    },
  );
});
