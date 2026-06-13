// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Focused direct-Vitest migration of test/e2e/test-double-onboard.sh.
//
// This intentionally stays as one free-standing live Vitest test with local
// helpers: the legacy contract is a real OpenShell/Docker/nemoclaw lifecycle
// boundary, but it does not need a new registry scenario or shared fixture.
// The legacy bash lane remains wired in nightly-e2e.yaml until #5098 Phase 11
// explicitly retires converted shell entry points.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SANDBOX_A = process.env.NEMOCLAW_DOUBLE_ONBOARD_SANDBOX_A ?? "e2e-double-a";
const SANDBOX_B = process.env.NEMOCLAW_DOUBLE_ONBOARD_SANDBOX_B ?? "e2e-double-b";
const INSTALL_SANDBOX_NAME = process.env.NEMOCLAW_E2E_INSTALL_SANDBOX_NAME ?? "";
const ALT_GATEWAY_NAME = "e2e-double-alt";
const PHASE_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const PROBE_ATTEMPTS = Number(process.env.NEMOCLAW_E2E_PROBE_ATTEMPTS ?? 3);
const PROBE_DELAY_MS = Number(process.env.NEMOCLAW_E2E_PROBE_DELAY_SECONDS ?? 3) * 1_000;
const PROBE_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PROBE_TIMEOUT_SECONDS ?? 180) * 1_000;
const RECOVERY_PROBE_TIMEOUT_MS =
  Number(process.env.NEMOCLAW_E2E_RECOVERY_PROBE_TIMEOUT_SECONDS ?? 180) * 1_000;
const TEST_TIMEOUT_MS = 90 * 60_000;
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_A);
validateSandboxName(SANDBOX_B);
if (INSTALL_SANDBOX_NAME) validateSandboxName(INSTALL_SANDBOX_NAME);
validateSandboxName(ALT_GATEWAY_NAME);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

function onboardEnv(sandboxName: string, fakeBaseUrl: string, recreate = false): NodeJS.ProcessEnv {
  return commandEnv({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
    ...(recreate ? { NEMOCLAW_RECREATE_SANDBOX: "1" } : {}),
  });
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup is best effort; the test performs explicit final assertions when
    // it reaches the cleanup phase. Early-failure cleanup must not mask the
    // original lifecycle failure.
  }
}

async function command(
  host: HostCliClient,
  args: string[],
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    env: options.env ?? commandEnv(),
    artifactName: options.artifactName,
    timeoutMs: options.timeoutMs,
  });
}

async function runOnboard(
  host: HostCliClient,
  sandboxName: string,
  fakeBaseUrl: string,
  artifactName: string,
  recreate = false,
): Promise<ShellProbeResult> {
  return await command(host, ["onboard", "--non-interactive"], {
    artifactName,
    env: onboardEnv(sandboxName, fakeBaseUrl, recreate),
    timeoutMs: PHASE_TIMEOUT_MS,
  });
}

async function runProbeOnlyConnect(
  host: HostCliClient,
  sandboxName: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command(
    "bash",
    [
      "-lc",
      [
        "set +e",
        'log="$(mktemp)"',
        '"$1" "$2" "$3" connect --probe-only >"$log" 2>&1',
        "rc=$?",
        'cat "$log"',
        'rm -f "$log"',
        'exit "$rc"',
      ].join("\n"),
      "nemoclaw-probe-connect",
      process.execPath,
      CLI_ENTRYPOINT,
      sandboxName,
    ],
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
}

async function cleanupDoubleOnboardState(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  const names = [INSTALL_SANDBOX_NAME, SANDBOX_A, SANDBOX_B].filter(Boolean);
  for (const name of names) {
    await ignoreCleanupError(() =>
      command(host, [name, "destroy", "--yes"], {
        artifactName: `cleanup-nemoclaw-destroy-${name}`,
        env: commandEnv(),
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      }),
    );
  }
  for (const name of names) {
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", name], {
        artifactName: `cleanup-openshell-sandbox-delete-${name}`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
  }
  await ignoreCleanupError(() =>
    sandbox.openshell(["forward", "stop", "18789"], {
      artifactName: "cleanup-openshell-forward-stop-18789",
      env: commandEnv(),
      timeoutMs: 30_000,
    }),
  );
  await stopGatewayRuntime(host, "cleanup-stop-gateway-runtime");
  await ignoreCleanupError(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy-nemoclaw",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await ignoreCleanupError(() =>
    sandbox.openshell(["gateway", "destroy", "-g", ALT_GATEWAY_NAME], {
      artifactName: `cleanup-openshell-gateway-destroy-${ALT_GATEWAY_NAME}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

async function gatewayRuntimeId(host: HostCliClient, artifactName: string): Promise<string> {
  const script = String.raw`
set -euo pipefail
pid_file="$HOME/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid"
if [ -f "$pid_file" ]; then
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf 'pid:%s\n' "$pid"
    exit 0
  fi
fi
cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"
if [ -n "$cid" ]; then
  printf 'container:%s\n' "$cid"
  exit 0
fi
exit 1
`;
  const result = await host.command("bash", ["-lc", script], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  const observedRuntimeId = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^(pid|container):/.test(line));
  return observedRuntimeId ?? (result.exitCode === 0 ? result.stdout.trim() : "");
}

async function stopGatewayRuntime(host: HostCliClient, artifactName: string): Promise<void> {
  const script = String.raw`
set +e
openshell forward stop 18789 >/dev/null 2>&1
openshell gateway stop -g nemoclaw >/dev/null 2>&1
pid_file="$HOME/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid"
if [ -f "$pid_file" ]; then
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" >/dev/null 2>&1 || true
  fi
fi
cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"
[ -n "$cid" ] && docker stop "$cid" >/dev/null 2>&1 || true
exit 0
`;
  await host.command("bash", ["-lc", script], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
}

function gatewayAliasEndpoint(): string {
  return `${os.platform() === "linux" ? "http" : "https"}://127.0.0.1:${
    process.env.NEMOCLAW_GATEWAY_PORT ?? "8080"
  }`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

function gatewayNameFromOutput(output: string): string | undefined {
  return stripAnsi(output).match(/^\s*Gateway:\s+([^\s]+)/m)?.[1];
}

function dashboardPortFromList(output: string, sandboxName: string): string | undefined {
  let current: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("    ") && !line.startsWith("      ")) {
      const stripped = line.trim();
      current = stripped ? stripped.split(/\s+/)[0] : undefined;
      continue;
    }
    if (current === sandboxName) {
      const match = line.match(/dashboard:\s+http:\/\/127\.0\.0\.1:(\d+)\/?/);
      if (match) return match[1];
    }
  }
  return undefined;
}

function forwardOwnerForPort(output: string, port: string): string | undefined {
  for (const line of stripAnsi(output).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toLowerCase() === "sandbox") continue;
    const status = parts.slice(4).join(" ").toLowerCase();
    if (parts[2] === port && status.includes("running")) return parts[0];
  }
  return undefined;
}

async function waitForForwardOwner(
  sandbox: SandboxClient,
  port: string,
  owner: string,
  artifactPrefix: string,
): Promise<{ owner: string | undefined; output: string }> {
  let observedOwner: string | undefined;
  let lastOutput = "";
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    const result = await sandbox.openshell(["forward", "list"], {
      artifactName: `${artifactPrefix}-attempt-${attempt}`,
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    lastOutput = resultText(result);
    observedOwner = forwardOwnerForPort(lastOutput, port);
    if (observedOwner === owner) break;
    if (attempt < PROBE_ATTEMPTS) await sleep(PROBE_DELAY_MS);
  }
  return { owner: observedOwner, output: lastOutput };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function registryHas(sandboxName: string): boolean {
  if (!fs.existsSync(REGISTRY_FILE)) return false;
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as unknown;
    if (!registry || typeof registry !== "object") return false;

    if (Array.isArray(registry)) {
      return registry.some(
        (entry) =>
          entry === sandboxName ||
          (entry && typeof entry === "object" && "name" in entry && entry.name === sandboxName),
      );
    }

    if (hasOwn(registry, sandboxName)) return true;
    if (!hasOwn(registry, "sandboxes")) return false;

    const sandboxes = (registry as { sandboxes?: unknown }).sandboxes;
    if (Array.isArray(sandboxes)) {
      return sandboxes.some(
        (entry) =>
          entry === sandboxName ||
          (entry && typeof entry === "object" && "name" in entry && entry.name === sandboxName),
      );
    }
    return !!sandboxes && typeof sandboxes === "object" && hasOwn(sandboxes, sandboxName);
  } catch {
    return false;
  }
}

async function waitOpenshellSandboxAbsent(
  sandbox: SandboxClient,
  sandboxName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() <= deadline) {
    const result = await sandbox.openshell(["sandbox", "get", sandboxName], {
      artifactName: `wait-absent-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    last = resultText(result);
    if (result.exitCode !== 0 && /NotFound|Not Found|sandbox not found/i.test(last)) return true;
    await sleep(1_000);
  }
  throw new Error(
    `OpenShell still reports sandbox '${sandboxName}' after ${timeoutMs}ms:\n${last}`,
  );
}

async function prerequisiteOrSkip(
  host: HostCliClient,
  skip: (message: string) => never,
  commandName: string,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  let result: ShellProbeResult;
  try {
    result = await host.command(commandName, args, {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${commandName} ${args.join(" ")} is required for double-onboard live E2E: ${detail}`;
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
    skip(message);
  }
  if (result.exitCode === 0) return result;
  const message = `${commandName} ${args.join(" ")} is required for double-onboard live E2E: ${resultText(
    result,
  )}`;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
  skip(message);
}

liveTest(
  "double-onboard: reuses gateway, preserves sibling sandbox, and recovers stale registry",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    expect(
      fs.existsSync(CLI_DIST_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    await prerequisiteOrSkip(host, skip, "docker", ["info"], "prereq-docker-info");
    await prerequisiteOrSkip(
      host,
      skip,
      "bash",
      ["-lc", "command -v openshell"],
      "prereq-openshell",
    );
    await prerequisiteOrSkip(
      host,
      skip,
      process.execPath,
      [CLI_ENTRYPOINT, "--version"],
      "prereq-nemoclaw",
    );

    const fake = await startFakeOpenAiCompatibleServer({
      port: Number(process.env.NEMOCLAW_FAKE_PORT ?? 0),
    });
    await artifacts.writeJson("fake-openai.json", { baseUrl: fake.baseUrl });
    cleanup.add("close fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-requests.json", fake.requests());
      await fake.close();
    });
    cleanup.add("remove double-onboard sandboxes and gateways", async () => {
      await cleanupDoubleOnboardState(host, sandbox);
    });

    await artifacts.writeJson("scenario.json", {
      id: "double-onboard",
      runner: "vitest",
      boundary: "direct-cli-openshell-lifecycle",
      legacySource: "test/e2e/test-double-onboard.sh",
      contract: [
        "first onboard creates a sandbox and NemoClaw gateway",
        "same-name recreate reuses the healthy gateway without port conflicts",
        "different-name onboard preserves the first sandbox and allocates distinct dashboard forwards",
        "stale OpenShell deletion preserves registry metadata through status/connect and rebuild recovers it",
        "status after gateway stop gives explicit lifecycle guidance without deleting registry state",
      ],
    });

    await cleanupDoubleOnboardState(host, sandbox);

    // Phase 2: first onboard.
    const first = await runOnboard(host, SANDBOX_A, fake.baseUrl, "phase-2-first-onboard");
    const firstText = resultText(first);
    expect(first.exitCode, firstText).toBe(0);
    expect(firstText).toContain(`Sandbox '${SANDBOX_A}' created`);

    const gatewayInfo = await sandbox.openshell(["gateway", "info", "-g", "nemoclaw"], {
      artifactName: "phase-2-openshell-gateway-info",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(resultText(gatewayInfo)).toContain("nemoclaw");

    const sandboxAAfterFirst = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-2-openshell-sandbox-a-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterFirst.exitCode, resultText(sandboxAAfterFirst)).toBe(0);
    expect(registryHas(SANDBOX_A), `${REGISTRY_FILE} missing ${SANDBOX_A}`).toBe(true);

    // Phase 3: second onboard with the same name must reuse the healthy gateway.
    const gatewayBeforeSecond = await gatewayRuntimeId(host, "phase-3-gateway-id-before");
    const second = await runOnboard(host, SANDBOX_A, fake.baseUrl, "phase-3-second-onboard", true);
    const secondText = resultText(second);
    expect(second.exitCode, secondText).toBe(0);
    const gatewayAfterSecond = await gatewayRuntimeId(host, "phase-3-gateway-id-after");
    expect(gatewayBeforeSecond, "gateway runtime id before second onboard").not.toBe("");
    expect(gatewayAfterSecond).toBe(gatewayBeforeSecond);
    expect(secondText).not.toContain("Port 8080 is not available");
    expect(secondText).not.toContain("Port 18789 is not available");
    const sandboxAAfterSecond = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-3-openshell-sandbox-a-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterSecond.exitCode, resultText(sandboxAAfterSecond)).toBe(0);

    // Phase 4: third onboard with a different name must not destroy A.
    await sandbox.openshell(
      ["gateway", "add", "--local", "--name", ALT_GATEWAY_NAME, gatewayAliasEndpoint()],
      {
        artifactName: "phase-4-openshell-gateway-add-alt",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const selectAlt = await sandbox.openshell(["gateway", "select", ALT_GATEWAY_NAME], {
      artifactName: "phase-4-openshell-gateway-select-alt",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(selectAlt.exitCode, resultText(selectAlt)).toBe(0);
    const selectedAlt = await host.command(
      "bash",
      ["-lc", "openshell status 2>&1 || true; openshell gateway info 2>&1 || true"],
      {
        artifactName: "phase-4-selected-alt-gateway",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(gatewayNameFromOutput(resultText(selectedAlt))).toBe(ALT_GATEWAY_NAME);

    const gatewayBeforeThird = await gatewayRuntimeId(host, "phase-4-gateway-id-before");
    const third = await runOnboard(host, SANDBOX_B, fake.baseUrl, "phase-4-third-onboard");
    const thirdText = resultText(third);
    expect(third.exitCode, thirdText).toBe(0);
    const gatewayAfterThird = await gatewayRuntimeId(host, "phase-4-gateway-id-after");
    expect(gatewayBeforeThird, "gateway runtime id before third onboard").not.toBe("");
    expect(gatewayAfterThird).toBe(gatewayBeforeThird);
    expect(thirdText).not.toContain("Port 8080 is not available");
    expect(thirdText).not.toContain("Port 18789 is not available");

    const selectedNemoclaw = await host.command(
      "bash",
      ["-lc", "openshell status 2>&1 || true; openshell gateway info 2>&1 || true"],
      {
        artifactName: "phase-4-selected-nemoclaw-gateway",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(gatewayNameFromOutput(resultText(selectedNemoclaw))).toBe("nemoclaw");

    const sandboxBAfterThird = await sandbox.openshell(["sandbox", "get", SANDBOX_B], {
      artifactName: "phase-4-openshell-sandbox-b-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxBAfterThird.exitCode, resultText(sandboxBAfterThird)).toBe(0);
    const sandboxAAfterThird = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-4-openshell-sandbox-a-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterThird.exitCode, resultText(sandboxAAfterThird)).toBe(0);

    const list = await command(host, ["list"], {
      artifactName: "phase-4-nemoclaw-list",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    const portA = dashboardPortFromList(list.stdout, SANDBOX_A);
    const portB = dashboardPortFromList(list.stdout, SANDBOX_B);
    expect(portA, `nemoclaw list did not show ${SANDBOX_A} dashboard: ${list.stdout}`).toBeTruthy();
    expect(portB, `nemoclaw list did not show ${SANDBOX_B} dashboard: ${list.stdout}`).toBeTruthy();
    expect(portB).not.toBe(portA);

    await sandbox.openshell(["forward", "stop", portB ?? ""], {
      artifactName: "phase-4-stop-sandbox-b-dashboard-forward",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    let probe: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      probe = await runProbeOnlyConnect(
        host,
        SANDBOX_B,
        `phase-4-probe-connect-sandbox-b-attempt-${attempt}`,
      );
      if (probe.exitCode === 0 && !probe.timedOut) break;
      if (attempt < PROBE_ATTEMPTS) await sleep(PROBE_DELAY_MS);
    }
    expect(probe?.exitCode, probe ? resultText(probe) : "probe did not run").toBe(0);
    expect(probe?.timedOut, probe ? resultText(probe) : "probe did not run").toBe(false);

    const restoredForwardB = await waitForForwardOwner(
      sandbox,
      portB ?? "",
      SANDBOX_B,
      "phase-4-openshell-forward-list-b",
    );
    expect(restoredForwardB.owner, restoredForwardB.output).toBe(SANDBOX_B);

    const retainedForwardA = await waitForForwardOwner(
      sandbox,
      portA ?? "",
      SANDBOX_A,
      "phase-4-openshell-forward-list-a",
    );
    expect(retainedForwardA.owner, retainedForwardA.output).toBe(SANDBOX_A);

    // Phase 5: direct OpenShell deletion leaves a stale registry entry that
    // status/connect preserve and rebuild can recover.
    await sandbox.openshell(["sandbox", "delete", SANDBOX_A], {
      artifactName: "phase-5-delete-sandbox-a-directly",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(await waitOpenshellSandboxAbsent(sandbox, SANDBOX_A, 60_000)).toBe(true);
    expect(registryHas(SANDBOX_A), "registry should still contain stale sandbox A").toBe(true);

    const staleStatus = await command(host, [SANDBOX_A, "status"], {
      artifactName: "phase-5-stale-status",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    const staleStatusText = resultText(staleStatus);
    expect(staleStatus.exitCode, staleStatusText).toBe(1);
    expect(staleStatusText).toContain("No local registry entry was removed");
    expect(staleStatusText).not.toContain("Removed stale local registry entry");
    expect(registryHas(SANDBOX_A), "status removed stale registry entry").toBe(true);

    const staleConnect = await command(host, [SANDBOX_A, "connect"], {
      artifactName: "phase-5-stale-connect",
      env: commandEnv(),
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    const staleConnectText = resultText(staleConnect);
    expect(staleConnect.exitCode, staleConnectText).toBe(1);
    expect(staleConnectText).not.toContain("Removed stale local registry entry");
    expect(registryHas(SANDBOX_A), "connect removed stale registry entry").toBe(true);

    const rebuild = await command(host, [SANDBOX_A, "rebuild", "--yes"], {
      artifactName: "phase-5-stale-rebuild-recovery",
      env: onboardEnv(SANDBOX_A, fake.baseUrl),
      timeoutMs: PHASE_TIMEOUT_MS,
    });
    const rebuildText = resultText(rebuild);
    expect(rebuild.timedOut, rebuildText).toBe(false);
    expect(rebuildText).not.toContain("Cannot back up state");
    expect(rebuildText).not.toContain("does not exist");
    expect(rebuildText).toContain("absent from the live OpenShell gateway");
    expect(rebuildText).toContain("No live workspace state to back up");
    expect(rebuildText).toContain("Creating new sandbox with current image");
    expect(rebuild.exitCode, rebuildText).toBe(0);

    const sandboxAAfterRebuild = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-5-openshell-sandbox-a-after-rebuild",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterRebuild.exitCode, resultText(sandboxAAfterRebuild)).toBe(0);
    expect(registryHas(SANDBOX_A), "rebuild lost sandbox A registry entry").toBe(true);

    await command(host, [SANDBOX_A, "destroy", "--yes"], {
      artifactName: "phase-5-destroy-recovered-sandbox-a",
      env: commandEnv(),
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    await sandbox.openshell(["sandbox", "delete", SANDBOX_A], {
      artifactName: "phase-5-openshell-delete-recovered-sandbox-a",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(registryHas(SANDBOX_A), "destroy did not purge recovered sandbox A").toBe(false);

    // Phase 6: gateway stop must produce explicit lifecycle guidance and keep B.
    await sandbox.openshell(["forward", "stop", "18789"], {
      artifactName: "phase-6-forward-stop-18789",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    await stopGatewayRuntime(host, "phase-6-stop-gateway-runtime");
    const postStopStatus = await command(host, [SANDBOX_B, "status"], {
      artifactName: "phase-6-status-after-gateway-stop",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    const postStopText = resultText(postStopStatus);
    expect([0, 1]).toContain(postStopStatus.exitCode);
    expect(postStopText).toMatch(
      /Recovered NemoClaw gateway runtime|gateway is no longer configured after restart\/rebuild|gateway is still refusing connections after restart|gateway trust material rotated after restart/,
    );
    expect(registryHas(SANDBOX_B), "gateway-stop status removed sandbox B registry entry").toBe(
      true,
    );

    // Phase 7: final cleanup with explicit assertions.
    await cleanupDoubleOnboardState(host, sandbox);
    const sandboxAAfterCleanup = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-7-openshell-sandbox-a-after-cleanup",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    const sandboxBAfterCleanup = await sandbox.openshell(["sandbox", "get", SANDBOX_B], {
      artifactName: "phase-7-openshell-sandbox-b-after-cleanup",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterCleanup.exitCode, resultText(sandboxAAfterCleanup)).not.toBe(0);
    expect(sandboxBAfterCleanup.exitCode, resultText(sandboxBAfterCleanup)).not.toBe(0);
    expect(
      registryHas(SANDBOX_A) || registryHas(SANDBOX_B),
      "registry still contains test entries",
    ).toBe(false);

    await artifacts.writeJson("scenario-result.json", {
      id: "double-onboard",
      fakeOpenAiRequests: fake.requests(),
      assertions: {
        firstOnboard: first.exitCode === 0,
        secondOnboardReusedGateway: gatewayAfterSecond === gatewayBeforeSecond,
        thirdOnboardPreservedSibling:
          sandboxAAfterThird.exitCode === 0 && sandboxBAfterThird.exitCode === 0,
        distinctDashboardPorts: Boolean(portA && portB && portA !== portB),
        staleRegistryRecovered: rebuild.exitCode === 0,
        gatewayStopGuidance:
          /Recovered NemoClaw gateway runtime|gateway is no longer configured after restart\/rebuild|gateway is still refusing connections after restart|gateway trust material rotated after restart/.test(
            postStopText,
          ),
      },
    });
  },
);
