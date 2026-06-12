// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-shields-config.sh.
 *
 * Preserves the real shields/config boundary from the legacy script: source
 * install, OpenShell/Docker sandbox exec, host-root Docker tamper, chmod/chown
 * lock state, config redaction, audit JSONL, and the auto-restore timer. Local
 * helpers stay in this file because this is one focused security/policy
 * dependent, not a new shields fixture family.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const AUDIT_FILE = path.join(os.homedir(), ".nemoclaw", "state", "shields-audit.jsonl");
const STATE_FILE = (sandboxName: string) =>
  path.join(os.homedir(), ".nemoclaw", "state", `shields-${sandboxName}.json`);
const TIMER_FILE = (sandboxName: string) =>
  path.join(os.homedir(), ".nemoclaw", "state", `shields-timer-${sandboxName}.json`);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-shields";
const INSTALL_LOG = "/tmp/nemoclaw-e2e-shields-install.log";
const RUN_SHIELDS_TEST = shouldRunLiveE2EScenarios() ? test : test.skip;

const TEST_TIMEOUT_MS = 45 * 60_000;
const INSTALL_TIMEOUT_MS = 25 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const TIMER_POLL_TIMEOUT_MS = 75_000;
const TIMER_POLL_INTERVAL_MS = 5_000;

validateSandboxName(SANDBOX_NAME);

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function runNemoclaw(
  host: HostCliClient,
  args: string[],
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("nemoclaw", args, {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number },
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function docker(
  host: HostCliClient,
  args: string[],
  options: { artifactName: string; timeoutMs?: number } = {
    artifactName: "docker",
  },
): Promise<ShellProbeResult> {
  return host.command("docker", args, {
    artifactName: options.artifactName,
    env: commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function installedShellCommand(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

function parseModeOwner(value: string): { mode: string; owner: string } {
  const [mode = "", owner = ""] = value.trim().split(/\s+/, 2);
  return { mode, owner };
}

async function statPath(
  sandbox: SandboxClient,
  targetPath: string,
  artifactName: string,
): Promise<{ mode: string; owner: string; raw: string }> {
  const result = await sandboxShell(sandbox, `stat -c '%a %U:%G' ${JSON.stringify(targetPath)}`, {
    artifactName,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  const parsed = parseModeOwner(result.stdout);
  return { ...parsed, raw: result.stdout.trim() };
}

async function cleanupSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifactPrefix: string,
): Promise<void> {
  await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: `${artifactPrefix}-nemoclaw-destroy`,
    timeoutMs: 120_000,
  }).catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${artifactPrefix}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${artifactPrefix}-openshell-gateway-destroy`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  for (const file of [STATE_FILE(SANDBOX_NAME), TIMER_FILE(SANDBOX_NAME), AUDIT_FILE]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(path.join(os.homedir(), ".nemoclaw", "onboard.lock"), {
    force: true,
  });
}

async function findSandboxContainer(host: HostCliClient): Promise<string> {
  const result = await docker(host, ["ps", "--filter", `name=openshell-${SANDBOX_NAME}`, "-q"], {
    artifactName: "phase-5b-docker-ps-sandbox-container",
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  const containerId = result.stdout.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  expect(containerId, `could not find openshell container for ${SANDBOX_NAME}`).not.toBe("");
  return containerId;
}

async function readOriginalConfig(
  host: HostCliClient,
  containerId: string,
  targetFile: string,
): Promise<void> {
  const result = await host.command(
    "bash",
    ["-lc", `docker exec -u 0 ${containerId} cat ${CONFIG_PATH} > ${targetFile}`],
    {
      artifactName: "phase-5b-backup-original-config",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(fs.statSync(targetFile).size, "original config backup must not be empty").toBeGreaterThan(
    0,
  );
}

function readAuditEntries(): unknown[] {
  return fs
    .readFileSync(AUDIT_FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

RUN_SHIELDS_TEST(
  "shields-config: live shields up/down locks config and detects drift",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "shields-config",
      runner: "vitest",
      boundary: "live-sandbox-shields-config",
      migratedFrom: "test/e2e/test-shields-config.sh",
      contracts: [
        "source install creates a live OpenClaw sandbox",
        "default config starts mutable with unified .openclaw layout",
        "shields up locks config/workspace and config get redacts secrets",
        "host-root chmod-write-chmod tamper is detected as content drift",
        "shields down restores mutable modes and records audit JSONL",
        "auto-restore timer re-locks shields",
        "double shields-up/down operations are rejected",
      ],
    });

    const dockerInfo = await docker(host, ["info"], {
      artifactName: "prereq-docker-info",
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for shields-config live E2E: ${resultText(dockerInfo)}`,
        );
      }
      skip("Docker is required for shields-config live E2E");
    }

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    await cleanupSandbox(host, sandbox, "pre-cleanup");
    cleanup.add(`destroy shields-config sandbox ${SANDBOX_NAME}`, async () => {
      await cleanupSandbox(host, sandbox, "cleanup");
    });

    const install = await installedShellCommand(
      host,
      `cd ${JSON.stringify(REPO_ROOT)} && bash install.sh --non-interactive > ${INSTALL_LOG} 2>&1`,
      {
        artifactName: "phase-1-install-shields-config",
        env: commandEnv({
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);
    expect(fs.existsSync(INSTALL_LOG), `${INSTALL_LOG} should be written`).toBe(true);

    const cliVersion = await installedShellCommand(
      host,
      "command -v nemoclaw && command -v openshell",
      {
        artifactName: "phase-1-installed-commands-on-path",
      },
    );
    expect(cliVersion.exitCode, resultText(cliVersion)).toBe(0);

    const configDefault = await statPath(sandbox, CONFIG_PATH, "phase-2-config-perms-default");
    expect(configDefault.mode).toBe("660");
    expect(configDefault.owner).toBe("sandbox:sandbox");
    const dirDefault = await statPath(sandbox, CONFIG_DIR, "phase-2-config-dir-perms-default");
    expect(dirDefault.mode).toBe("2770");
    expect(dirDefault.owner).toBe("sandbox:sandbox");

    const statusDefault = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-2-shields-status-default",
    });
    expect(statusDefault.exitCode, resultText(statusDefault)).toBe(0);
    expect(statusDefault.stdout).toContain("Shields: NOT CONFIGURED");

    const layoutProbe = await sandboxShell(
      sandbox,
      [
        `bad=0`,
        `if [ -e /sandbox/.openclaw-data ] || [ -L /sandbox/.openclaw-data ]; then echo "legacy data dir exists: /sandbox/.openclaw-data"; bad=1; fi`,
        `for entry in /sandbox/.openclaw/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in /sandbox/.openclaw-data/*) echo "legacy symlink remains: $entry -> $target"; bad=1 ;; esac; done`,
        `exit "$bad"`,
      ].join("; "),
      { artifactName: "phase-2-unified-openclaw-layout" },
    );
    expect(layoutProbe.exitCode, resultText(layoutProbe)).toBe(0);
    expect(resultText(layoutProbe).trim()).toBe("");

    const shieldsUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-3-shields-up",
    });
    expect(shieldsUp.exitCode, resultText(shieldsUp)).toBe(0);
    expect(resultText(shieldsUp)).toContain("Lockdown active");

    const configUp = await statPath(sandbox, CONFIG_PATH, "phase-3-config-perms-up");
    expect(configUp.mode).toMatch(/^4[0-4][0-4]$/);
    expect(configUp.owner).toBe("root:root");

    const writeUp = await sandboxShell(
      sandbox,
      `echo 'TAMPERED' >> ${CONFIG_PATH} 2>&1 && echo WRITABLE || echo BLOCKED`,
      { artifactName: "phase-3-config-write-blocked" },
    );
    expect(resultText(writeUp)).toMatch(
      /BLOCKED|Permission denied|Read-only|Operation not permitted/,
    );

    const workspaceUp = await sandboxShell(
      sandbox,
      "touch /sandbox/.openclaw/workspace/.shields-up-probe 2>&1 && echo WRITABLE || echo BLOCKED",
      { artifactName: "phase-3-workspace-write-blocked" },
    );
    expect(resultText(workspaceUp)).toMatch(
      /BLOCKED|Permission denied|Read-only|Operation not permitted/,
    );

    const configGet = await runNemoclaw(host, [SANDBOX_NAME, "config", "get"], {
      artifactName: "phase-4-config-get",
      redactionValues: [apiKey],
    });
    expect(configGet.exitCode, resultText(configGet)).toBe(0);
    expect(configGet.stdout).toContain("{");
    expect(configGet.stdout).not.toMatch(/nvapi-|sk-|Bearer /);
    expect(configGet.stdout).not.toContain('"gateway"');

    const dotpath = await runNemoclaw(host, [SANDBOX_NAME, "config", "get", "--key", "inference"], {
      artifactName: "phase-4-config-get-dotpath",
      redactionValues: [apiKey],
    });
    if (
      dotpath.exitCode === 0 &&
      dotpath.stdout.trim() !== "" &&
      dotpath.stdout.trim() !== "null"
    ) {
      expect(dotpath.stdout).not.toMatch(/nvapi-|sk-|Bearer /);
    } else {
      await artifacts.writeJson("phase-4-dotpath-non-fatal.json", {
        exitCode: dotpath.exitCode,
        stdout: dotpath.stdout.trim(),
        stderr: dotpath.stderr.trim(),
        note: "config get --key inference is non-fatal because the inference key may not exist",
      });
    }

    const statusUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-5-shields-status-up",
    });
    expect(statusUp.exitCode, resultText(statusUp)).toBe(0);
    expect(statusUp.stdout).toContain("Shields: UP");

    const containerId = await findSandboxContainer(host);
    const originalConfig = path.join(os.tmpdir(), `nemoclaw-shields-orig-${process.pid}.json`);
    await readOriginalConfig(host, containerId, originalConfig);
    try {
      const tamper = await host.command(
        "bash",
        [
          "-lc",
          [
            `had_immutable=false`,
            `if docker exec -u 0 ${containerId} lsattr -d ${CONFIG_PATH} 2>/dev/null | awk '{print $1}' | grep -q i; then had_immutable=true; fi`,
            `docker exec -u 0 ${containerId} sh -c 'chattr -i ${CONFIG_PATH} 2>/dev/null || true; chmod 644 ${CONFIG_PATH} && printf " " >> ${CONFIG_PATH} && chmod 444 ${CONFIG_PATH}'`,
            `if [ "$had_immutable" = true ]; then docker exec -u 0 ${containerId} chattr +i ${CONFIG_PATH} >/dev/null 2>&1 || true; fi`,
          ].join("\n"),
        ],
        {
          artifactName: "phase-5b-host-root-tamper",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(tamper.exitCode, resultText(tamper)).toBe(0);

      const afterTamper = await docker(
        host,
        ["exec", containerId, "stat", "-c", "%a %U:%G", CONFIG_PATH],
        {
          artifactName: "phase-5b-perms-after-tamper",
          timeoutMs: 30_000,
        },
      );
      expect(afterTamper.exitCode, resultText(afterTamper)).toBe(0);
      expect(afterTamper.stdout.trim()).toBe("444 root:root");

      const statusTamper = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
        artifactName: "phase-5b-shields-status-drifted",
      });
      expect(statusTamper.exitCode, resultText(statusTamper)).toBe(2);
      expect(resultText(statusTamper)).toContain("UP (DRIFTED");
      expect(resultText(statusTamper)).toContain("content drifted");

      const reUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
        artifactName: "phase-5b-shields-up-refuses-tamper",
      });
      expect(reUp.exitCode, resultText(reUp)).not.toBe(0);
      expect(resultText(reUp)).toContain("Refusing to re-seal");
    } finally {
      await host.command(
        "bash",
        [
          "-lc",
          `docker exec -i -u 0 ${containerId} sh -c 'chattr -i ${CONFIG_PATH} 2>/dev/null || true; chmod 644 ${CONFIG_PATH} && cat > ${CONFIG_PATH} && chmod 444 ${CONFIG_PATH} && chattr +i ${CONFIG_PATH} 2>/dev/null || true' < ${originalConfig}`,
        ],
        {
          artifactName: "phase-5b-restore-original-config",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      fs.rmSync(originalConfig, { force: true });
    }

    const statusRestored = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-5b-shields-status-restored",
    });
    expect(statusRestored.exitCode, resultText(statusRestored)).toBe(0);
    expect(statusRestored.stdout).toContain("Shields: UP (lockdown active)");

    const shieldsDown = await runNemoclaw(
      host,
      [
        SANDBOX_NAME,
        "shields",
        "down",
        "--timeout",
        "5m",
        "--reason",
        "E2E shields lifecycle test",
      ],
      { artifactName: "phase-6-shields-down" },
    );
    expect(shieldsDown.exitCode, resultText(shieldsDown)).toBe(0);
    expect(resultText(shieldsDown)).toContain("Config unlocked");

    const configDown = await statPath(sandbox, CONFIG_PATH, "phase-6-config-perms-down");
    expect(configDown.mode).toBe("660");
    expect(configDown.owner).toBe("sandbox:sandbox");
    const dirDown = await statPath(sandbox, CONFIG_DIR, "phase-6-config-dir-perms-down");
    expect(dirDown.mode).toBe("2770");
    expect(dirDown.owner).toBe("sandbox:sandbox");
    const workspaceDown = await sandboxShell(
      sandbox,
      "touch /sandbox/.openclaw/workspace/.shields-down-probe 2>&1 && rm -f /sandbox/.openclaw/workspace/.shields-down-probe && echo WRITABLE || echo BLOCKED",
      { artifactName: "phase-6-workspace-write-restored" },
    );
    expect(resultText(workspaceDown)).toContain("WRITABLE");

    const statusDown = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-7-shields-status-down",
    });
    expect(statusDown.exitCode, resultText(statusDown)).toBe(0);
    expect(statusDown.stdout).toContain("Shields: DOWN");
    expect(statusDown.stdout).toContain("E2E shields lifecycle test");
    expect(statusDown.stdout).toMatch(/Auto-lockdown in:|remaining/i);

    const restoreUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-7-restore-shields-up",
    });
    expect(restoreUp.exitCode, resultText(restoreUp)).toBe(0);

    expect(fs.existsSync(AUDIT_FILE), `${AUDIT_FILE} should exist`).toBe(true);
    const auditText = fs.readFileSync(AUDIT_FILE, "utf8");
    const auditEntries = readAuditEntries();
    const upCount = auditText.split('"shields_up"').length - 1;
    const downCount = auditText.split('"shields_down"').length - 1;
    expect(upCount).toBeGreaterThanOrEqual(2);
    expect(downCount).toBeGreaterThanOrEqual(1);
    expect(auditText).not.toMatch(/nvapi-|sk-|Bearer /);
    await artifacts.writeJson("phase-8-audit-summary.json", {
      entries: auditEntries.length,
      upCount,
      downCount,
    });

    const timerDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "10s", "--reason", "Auto-restore timer E2E"],
      { artifactName: "phase-9-shields-down-timer" },
    );
    expect(timerDown.exitCode, resultText(timerDown)).toBe(0);
    const statusTimer = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
      artifactName: "phase-9-status-down-before-auto-restore",
    });
    expect(statusTimer.stdout).toContain("Shields: DOWN");

    const deadline = Date.now() + TIMER_POLL_TIMEOUT_MS;
    let restored = false;
    let lastTimerStatus = "";
    for (let attempt = 1; Date.now() < deadline; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, TIMER_POLL_INTERVAL_MS));
      const poll = await runNemoclaw(host, [SANDBOX_NAME, "shields", "status"], {
        artifactName: `phase-9-status-auto-restore-poll-${attempt}`,
      });
      lastTimerStatus = resultText(poll);
      if (lastTimerStatus.includes("Shields: UP")) {
        restored = true;
        break;
      }
    }
    expect(restored, lastTimerStatus).toBe(true);
    const configTimer = await sandboxShell(sandbox, `stat -c '%a' ${CONFIG_PATH}`, {
      artifactName: "phase-9-config-perms-after-auto-restore",
    });
    expect(configTimer.stdout.trim()).toMatch(/^4[0-4][0-4]$/);

    const doubleUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-10-double-shields-up",
    });
    expect(doubleUp.exitCode, resultText(doubleUp)).toBe(0);
    expect(resultText(doubleUp)).toContain("already active");

    const cleanupDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "5m", "--reason", "Cleanup"],
      { artifactName: "phase-10-cleanup-shields-down" },
    );
    expect(cleanupDown.exitCode, resultText(cleanupDown)).toBe(0);

    const doubleDown = await runNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down", "--timeout", "5m", "--reason", "Should fail"],
      { artifactName: "phase-11-double-shields-down" },
    );
    expect(doubleDown.exitCode, resultText(doubleDown)).not.toBe(0);
    expect(resultText(doubleDown)).toContain("already unlocked");

    await artifacts.writeJson("scenario-result.json", {
      id: "shields-config",
      sandboxName: SANDBOX_NAME,
      assertions: {
        install: true,
        mutableDefault: true,
        shieldsUpLock: true,
        configGetRedaction: true,
        contentDriftDetection: true,
        shieldsDownMutableRestore: true,
        auditTrail: true,
        autoRestore: true,
        doubleOperationRejection: true,
      },
      shellDeletion: "deferred to #5098 Phase 11 cleanup",
      nightlyShellWiring: "deferred to #5098 Phase 11 cleanup",
    });
  },
);
