// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest anchor for test/e2e/test-sandbox-operations.sh.
 *
 * Keeps the same real boundaries as the legacy script — repo CLI, Docker,
 * OpenShell sandbox commands, in-sandbox process/PTY probes, logs streaming,
 * and gateway recovery — without introducing another scenario framework.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");
const SANDBOX_A = "e2e-sbx-a";
const SANDBOX_B = "e2e-sbx-b";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const GATEWAY_CONTAINER = "openshell-cluster-nemoclaw";
const liveTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

type ProcessResult = { exitCode: number | null; stdout: string; stderr: string };
type CleanupRegistry = { add(name: string, run: () => Promise<void> | void): void };

function resultText(result: ProcessResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function outputContainsSandbox(result: ProcessResult, sandboxName: string): boolean {
  const escaped = sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "m").test(resultText(result));
}

function expectExitZero(result: ProcessResult, label: string): void {
  expect(result.exitCode, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

async function cleanupSandbox(host: HostCliClient, sandboxName: string): Promise<void> {
  const result = await host.nemoclaw([sandboxName, "destroy", "--yes"], {
    artifactName: `cleanup-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 15 * 60_000,
  });
  if (result.exitCode === 0) return;
  const text = resultText(result);
  if (/Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one/i.test(text)) return;
  expectExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
}

async function bestEffortCleanupSandbox(host: HostCliClient, sandboxName: string): Promise<void> {
  try {
    await cleanupSandbox(host, sandboxName);
  } catch {
    // Best-effort pre-cleanup mirrors the legacy script's stale sandbox removal.
  }
}

async function destroyGateway(host: HostCliClient, artifactName = "cleanup-gateway-destroy") {
  await host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 5 * 60_000,
  });
}

async function bestEffortDestroyGateway(host: HostCliClient): Promise<void> {
  try {
    await destroyGateway(host);
  } catch {
    // Mirrors legacy teardown: gateway cleanup must not mask the test failure.
  }
}

async function onboardSandbox(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  sandboxName: string,
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ShellProbeResult> {
  cleanup.add(`destroy sandbox ${sandboxName}`, () => cleanupSandbox(host, sandboxName));
  const result = await host.nemoclaw(
    ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
    {
      artifactName,
      env: {
        ...buildAvailabilityProbeEnv(),
        ...extraEnv,
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_PROVIDER: "cloud",
        NEMOCLAW_SANDBOX_NAME: sandboxName,
        NEMOCLAW_RECREATE_SANDBOX: "1",
        NVIDIA_API_KEY: process.env.NVIDIA_API_KEY ?? "",
      },
      redactionValues: [process.env.NVIDIA_API_KEY ?? ""],
      timeoutMs: 20 * 60_000,
    },
  );
  expectExitZero(result, `nemoclaw onboard ${sandboxName}`);
  return result;
}

async function expectListed(host: HostCliClient, sandboxName: string, artifactName: string) {
  const list = await host.nemoclaw(["list"], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list");
  expect(outputContainsSandbox(list, sandboxName), resultText(list)).toBe(true);
  return list;
}

async function execInSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  script: string,
  artifactName: string,
  timeoutMs = 60_000,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs,
  });
}

function findJsonObjectEnd(raw: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function parseOpenClawAgentText(raw: string): string {
  if (!raw.trim()) return "";
  const parts: string[] = [];
  const visited = new Set<unknown>();
  const textKeys = new Set(["text", "content", "reasoning_content"]);
  const containerKeys = new Set([
    "result",
    "payloads",
    "payload",
    "messages",
    "choices",
    "response",
    "data",
    "output",
    "outputs",
    "items",
    "segments",
    "delta",
  ]);

  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };
  const collect = (value: unknown) => {
    if (visited.has(value)) return;
    visited.add(value);
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of textKeys) add(record[key]);
    const choices = record.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        collect((choice as Record<string, unknown>).message);
        collect((choice as Record<string, unknown>).delta);
        add((choice as Record<string, unknown>).text);
      }
    }
    for (const key of containerKeys) {
      if (key in record) collect(record[key]);
    }
  };
  const collectDoc = (doc: unknown) => {
    if (doc && typeof doc === "object" && (doc as Record<string, unknown>).result) {
      collect((doc as Record<string, unknown>).result);
    } else {
      collect(doc);
    }
  };

  try {
    collectDoc(JSON.parse(raw));
  } catch {
    for (const match of raw.matchAll(/{/g)) {
      try {
        const before = parts.length;
        const start = match.index;
        const end = findJsonObjectEnd(raw, start);
        if (end === null) continue;
        collectDoc(JSON.parse(raw.slice(start, end)));
        if (parts.length > before) break;
      } catch {
        // Continue scanning for a later JSON object, matching the legacy parser.
      }
    }
  }
  return parts.join("\n");
}

async function assertAgentCanAnswer(host: HostCliClient, sandboxName: string): Promise<void> {
  const sessionId = `e2e-sbx-02-${Date.now()}-${process.pid}`;
  const result = await host.nemoclaw(
    [
      "sandbox",
      "exec",
      sandboxName,
      "--timeout",
      "90",
      "--",
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      sessionId,
      "-m",
      "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
    ],
    {
      artifactName: "tc-sbx-02-openclaw-agent-json",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    },
  );
  const reply = parseOpenClawAgentText(result.stdout);
  expectExitZero(result, "openclaw agent --json");
  expect(reply, resultText(result)).toMatch(/(^|[^0-9])42([^0-9]|$)/);
}

async function assertStatusFields(host: HostCliClient, sandboxName: string): Promise<void> {
  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-03-status-fields",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expectExitZero(status, `nemoclaw ${sandboxName} status`);
  const text = resultText(status);
  for (const field of ["Sandbox", "Model", "Provider", "GPU"]) {
    expect(text, `missing status field ${field}:\n${text}`).toMatch(new RegExp(field, "i"));
  }
}

async function assertLogsStream(host: HostCliClient, sandboxName: string): Promise<void> {
  const logs = await host.nemoclaw([sandboxName, "logs"], {
    artifactName: "tc-sbx-04-logs",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 15_000,
  });
  expectExitZero(logs, `nemoclaw ${sandboxName} logs`);
  expect(resultText(logs).trim().length, "logs command produced no output").toBeGreaterThan(0);

  const follow = await host.nemoclaw([sandboxName, "logs", "--follow"], {
    artifactName: "tc-sbx-04-logs-follow",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 5_000,
    killGraceMs: 1_000,
  });
  expect(follow.timedOut, "logs --follow should keep streaming until timeout kills it").toBe(true);
}

async function assertTmuxPtyFlow(sandbox: SandboxClient, sandboxName: string): Promise<void> {
  const tmux = await execInSandbox(
    sandbox,
    sandboxName,
    "command -v tmux || echo TMUX_MISSING",
    "tc-sbx-09-tmux-present",
  );
  expect(resultText(tmux), "tmux is missing inside sandbox (#4513)").not.toContain("TMUX_MISSING");

  const pty = await execInSandbox(
    sandbox,
    sandboxName,
    "if command -v python3 >/dev/null 2>&1; then python3 -c 'import os; _,s=os.openpty(); print(os.ttyname(s))' && echo PTY_OK; else echo PY3_MISSING; fi",
    "tc-sbx-09-pty-allocation",
  );
  if (!resultText(pty).includes("PY3_MISSING")) {
    expect(resultText(pty), `PTY allocation failed (#4513):\n${resultText(pty)}`).toContain(
      "PTY_OK",
    );
  }

  const session = `nemoclaw-e2e-tmux-${process.pid}-${Date.now()}`;
  const flow = await execInSandbox(
    sandbox,
    sandboxName,
    `TMUX_TMPDIR=/tmp tmux new-session -d -s '${session}' 'sleep 30' && TMUX_TMPDIR=/tmp tmux list-sessions && TMUX_TMPDIR=/tmp tmux kill-session -t '${session}' && echo TMUX_FLOW_OK`,
    "tc-sbx-09-tmux-lifecycle",
  );
  if (!resultText(flow).includes("TMUX_FLOW_OK")) {
    await execInSandbox(
      sandbox,
      sandboxName,
      `TMUX_TMPDIR=/tmp tmux kill-session -t '${session}' 2>/dev/null || true`,
      "tc-sbx-09-tmux-cleanup",
    );
  }
  expect(resultText(flow), `tmux lifecycle failed:\n${resultText(flow)}`).toContain("TMUX_FLOW_OK");
  expect(resultText(flow)).toContain(session);
}

async function assertRegistryRebuild(host: HostCliClient, sandboxName: string): Promise<void> {
  if (!fs.existsSync(REGISTRY_FILE)) {
    throw new Error(
      `registry rebuild contract requires ${REGISTRY_FILE} to exist after onboarding`,
    );
  }
  const backup = `${REGISTRY_FILE}.e2e-sbx-backup-${process.pid}`;
  fs.copyFileSync(REGISTRY_FILE, backup);
  try {
    fs.rmSync(REGISTRY_FILE, { force: true });
    await expectListed(host, sandboxName, "tc-sbx-07-registry-rebuild-list");
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.copyFileSync(backup, REGISTRY_FILE);
    throw error;
  } finally {
    fs.rmSync(backup, { force: true });
  }
}

async function assertProcessRecovery(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  await execInSandbox(
    sandbox,
    sandboxName,
    "pkill -9 -f 'openclaw gateway' 2>/dev/null || kill -9 $(pgrep -f 'openclaw gateway') 2>/dev/null || ps aux | awk '/openclaw.*gateway/ && !/awk/ {print $2}' | xargs -r kill -9 2>/dev/null; echo PROCESS_KILL_PROBED",
    "tc-sbx-08-kill-openclaw-gateway",
  );
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-08-status-recovers-process",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expectExitZero(status, `nemoclaw ${sandboxName} status after process kill`);
  expect(resultText(status)).toMatch(/recover|running|healthy|OpenClaw/i);

  const ssh = await execInSandbox(
    sandbox,
    sandboxName,
    "echo process-recovery-ok",
    "tc-sbx-08-ssh-after-recovery",
  );
  expect(resultText(ssh), "sandbox exec failed after process recovery").toContain(
    "process-recovery-ok",
  );
}

async function assertMetadataForBothSandboxes(
  host: HostCliClient,
  sandboxA: string,
  sandboxB: string,
): Promise<void> {
  const list = await host.nemoclaw(["list"], {
    artifactName: "tc-sbx-10-list-two-sandboxes",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list after second sandbox onboard");
  expect(outputContainsSandbox(list, sandboxA), resultText(list)).toBe(true);
  expect(outputContainsSandbox(list, sandboxB), resultText(list)).toBe(true);
  for (const sandboxName of [sandboxA, sandboxB]) {
    const entryPattern = new RegExp(
      `${sandboxName}[\\s\\S]*?agent:.*?model:\\s*(?!unknown\\b)\\S+.*?provider:\\s*(?!unknown\\b)\\S+`,
      "i",
    );
    expect(resultText(list), `missing model/provider metadata for ${sandboxName}`).toMatch(
      entryPattern,
    );
  }
}

async function assertNetworkIsolation(
  sandbox: SandboxClient,
  source: string,
  target: string,
  artifactName: string,
): Promise<void> {
  const probe = await execInSandbox(
    sandbox,
    source,
    `node -e "const http = require('http'); const req = http.get('http://${target}:18789/', (res) => { console.log('STATUS_' + res.statusCode); res.resume(); }); req.on('error', (e) => console.log('ERROR: ' + e.message)); req.setTimeout(5000, () => { req.destroy(); console.log('TIMEOUT'); });"`,
    artifactName,
    15_000,
  );
  const text = resultText(probe);
  expect(text.trim().length, "network isolation probe produced no output").toBeGreaterThan(0);
  expect(text, `sandbox ${source} unexpectedly reached ${target}:\n${text}`).toMatch(
    /STATUS_403|ERROR|TIMEOUT/i,
  );
  expect(text, `sandbox ${source} reached ${target}:\n${text}`).not.toMatch(/STATUS_2[0-9][0-9]/);
}

async function assertDestroyRemovesSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const destroy = await host.nemoclaw([sandboxName, "destroy", "--yes"], {
    artifactName: `tc-sbx-05-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 15 * 60_000,
  });
  expectExitZero(destroy, `nemoclaw ${sandboxName} destroy --yes`);

  const list = await host.nemoclaw(["list"], {
    artifactName: `tc-sbx-05-nemoclaw-list-after-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expect(outputContainsSandbox(list, sandboxName), resultText(list)).toBe(false);

  const openshellList = await sandbox.list({
    artifactName: `tc-sbx-05-openshell-list-after-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expect(outputContainsSandbox(openshellList, sandboxName), resultText(openshellList)).toBe(false);
}

async function assertGatewayRecovery(host: HostCliClient, sandboxName: string): Promise<void> {
  const running = await host.command(
    "docker",
    ["ps", "-q", "--filter", `name=${GATEWAY_CONTAINER}`],
    {
      artifactName: "tc-sbx-06-gateway-container-running",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  if (!running.stdout.trim()) {
    // Preserve the legacy script's soft-skip when the shared gateway is already
    // absent before the destructive recovery probe can exercise it.
    return;
  }

  await host.command("docker", ["kill", GATEWAY_CONTAINER], {
    artifactName: "tc-sbx-06-docker-kill-gateway",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const afterKill = await host.command(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", GATEWAY_CONTAINER],
    {
      artifactName: "tc-sbx-06-gateway-container-after-kill",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  if (afterKill.stdout.trim() === "true") {
    // Preserve the legacy script's soft-skip when Docker restarts the gateway
    // before the recovery path can observe a stopped container.
    return;
  }

  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-06-status-recovers-gateway",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 10 * 60_000,
  });
  if (status.exitCode === 0) return;

  const afterStatus = await host.command(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", GATEWAY_CONTAINER],
    {
      artifactName: "tc-sbx-06-gateway-container-after-status",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  if (afterStatus.stdout.trim() !== "true") {
    // Same legacy soft-skip: Docker did not restart the gateway container on
    // this runner, so there is no recovery signal to assert.
    return;
  }
  expectExitZero(status, `nemoclaw ${sandboxName} status after gateway kill`);
}

liveTest(
  "sandbox operations preserve list/status/logs/recovery/multi-sandbox contracts",
  async ({ artifacts, cleanup, environment, host, sandbox, secrets, skip }) => {
    secrets.required("NVIDIA_API_KEY");

    await artifacts.writeJson("scenario.json", {
      id: "sandbox-operations",
      runner: "vitest",
      boundary: "repo-cli-docker-openshell-sandbox",
      legacySource: "test/e2e/test-sandbox-operations.sh",
      contracts: [
        "TC-SBX-01 list shows onboarded sandbox",
        "TC-SBX-02 openclaw agent answers through sandbox inference.local",
        "TC-SBX-03 status renders Sandbox/Model/Provider/GPU fields",
        "TC-SBX-04 logs and logs --follow behave as streaming commands",
        "TC-SBX-05 destroy removes NemoClaw and OpenShell entries",
        "TC-SBX-06 status recovers after gateway container kill",
        "TC-SBX-07 list rebuilds registry from live state",
        "TC-SBX-08 status recovers killed in-sandbox OpenClaw gateway process",
        "TC-SBX-09 tmux and PTY lifecycle work inside sandbox",
        "TC-SBX-10 two sandboxes list with model/provider metadata",
        "TC-SBX-11 sandboxes cannot reach each other by hostname",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-sandbox-operations",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for sandbox operations E2E: ${resultText(docker)}`);
      }
      skip("Docker is required for sandbox operations E2E");
    }

    await environment.assertReady(ENVIRONMENT);
    cleanup.add("destroy shared NemoClaw gateway", () => bestEffortDestroyGateway(host));
    await bestEffortCleanupSandbox(host, SANDBOX_B);
    await bestEffortCleanupSandbox(host, SANDBOX_A);

    await onboardSandbox(host, cleanup, SANDBOX_A, "onboard-sandbox-a");

    await expectListed(host, SANDBOX_A, "tc-sbx-01-list-sandbox-a");
    await assertAgentCanAnswer(host, SANDBOX_A);
    await assertStatusFields(host, SANDBOX_A);
    await assertLogsStream(host, SANDBOX_A);
    await assertTmuxPtyFlow(sandbox, SANDBOX_A);
    await assertRegistryRebuild(host, SANDBOX_A);
    await assertProcessRecovery(host, sandbox, SANDBOX_A);

    await onboardSandbox(host, cleanup, SANDBOX_B, "tc-sbx-10-onboard-sandbox-b", {
      CHAT_UI_URL: "http://127.0.0.1:18790",
    });
    await assertMetadataForBothSandboxes(host, SANDBOX_A, SANDBOX_B);
    await assertNetworkIsolation(sandbox, SANDBOX_A, SANDBOX_B, "tc-sbx-11-a-cannot-reach-b");
    await assertNetworkIsolation(sandbox, SANDBOX_B, SANDBOX_A, "tc-sbx-11-b-cannot-reach-a");
    await assertDestroyRemovesSandbox(host, sandbox, SANDBOX_B);

    await assertGatewayRecovery(host, SANDBOX_A);

    await artifacts.writeJson("scenario-result.json", {
      id: "sandbox-operations",
      status: "passed",
      legacySource: "test/e2e/test-sandbox-operations.sh",
    });
  },
  45 * 60_000,
);
