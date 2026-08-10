// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real-system boundaries: two NemoClaw onboards on one
 * host, per-port OpenShell Docker-driver gateways, dashboard forward
 * allocation, port-scoped `nemoclaw list`, OpenShell sandbox discovery, host
 * socket probes, and selected-instance uninstall/health cleanup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTrustedActiveOpenShellGatewayUserServicePid } from "../../../src/lib/onboard/docker-driver-gateway-service.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { PollingError, pollUntil } from "../fixtures/polling.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_A = process.env.NEMOCLAW_CGP_SANDBOX_A ?? "e2e-cgp-a";
const SANDBOX_B = process.env.NEMOCLAW_CGP_SANDBOX_B ?? "e2e-cgp-b";
const GATEWAY_PORT_A = process.env.NEMOCLAW_E2E_GATEWAY_PORT_A ?? "8080";
const GATEWAY_PORT_B = process.env.NEMOCLAW_E2E_GATEWAY_PORT_B ?? "18080";
const DASHBOARD_PORT_A = process.env.NEMOCLAW_E2E_DASHBOARD_PORT_A ?? "18789";
const PHASE_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const PROBE_ATTEMPTS = Number(process.env.NEMOCLAW_E2E_PROBE_ATTEMPTS ?? 12);
const PROBE_DELAY_MS = Number(process.env.NEMOCLAW_E2E_PROBE_DELAY_SECONDS ?? 5) * 1_000;
const TEST_TIMEOUT_MS = 90 * 60_000;
const POST_UNINSTALL_HEALTH_PROBES = 3;

type GatewayProcessAuthority = "standalone-state" | "systemd-service";

interface GatewayProcessIdentity {
  authority: GatewayProcessAuthority;
  pid: number;
}

interface CapturedProcessIdentity {
  executable: string;
  pid: number;
  startIdentity: string;
}

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_A);
validateSandboxName(SANDBOX_B);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

function gatewayNameForPort(port: string): string {
  return port === "8080" ? "nemoclaw" : `nemoclaw-${port}`;
}

function gatewayStateDirForPort(port: string): string {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error(`invalid gateway port '${port}'`);
  }
  const leaf = port === "8080" ? "openshell-docker-gateway" : `openshell-docker-gateway-${port}`;
  return path.join(process.env.HOME || os.homedir(), ".local", "state", "nemoclaw", leaf);
}

function readGatewayPid(port: string): number | null {
  try {
    const raw = fs.readFileSync(
      path.join(gatewayStateDirForPort(port), "openshell-gateway.pid"),
      "utf-8",
    );
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readGatewayRuntimePid(port: string): number | null {
  try {
    const marker: unknown = JSON.parse(
      fs.readFileSync(path.join(gatewayStateDirForPort(port), "runtime.json"), "utf-8"),
    );
    if (!marker || typeof marker !== "object" || !("pid" in marker)) return null;
    const pid = (marker as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readStandaloneGatewayIdentity(port: string): GatewayProcessIdentity | null {
  const pid = readGatewayPid(port);
  const runtimePid = readGatewayRuntimePid(port);
  if (pid === null && runtimePid === null) return null;
  if (pid === null || runtimePid === null || pid !== runtimePid) {
    throw new Error(
      `gateway ${gatewayNameForPort(port)} has inconsistent standalone process state ` +
        `(pid file: ${String(pid)}, runtime marker: ${String(runtimePid)})`,
    );
  }
  return { authority: "standalone-state", pid };
}

function readDefaultGatewayIdentity(): GatewayProcessIdentity {
  const standalone = readStandaloneGatewayIdentity(GATEWAY_PORT_A);
  if (standalone) return standalone;

  const pid =
    process.platform === "linux" && GATEWAY_PORT_A === "8080"
      ? getTrustedActiveOpenShellGatewayUserServicePid({ env: commandEnv() })
      : null;
  if (pid === null) {
    throw new Error(
      `default gateway ${gatewayNameForPort(GATEWAY_PORT_A)} has neither matching ` +
        "standalone PID/runtime state nor a trusted active systemd MainPID",
    );
  }
  return { authority: "systemd-service", pid };
}

function readAlternateGatewayIdentity(): GatewayProcessIdentity {
  const identity = readStandaloneGatewayIdentity(GATEWAY_PORT_B);
  if (!identity) {
    throw new Error(
      `alternate gateway ${gatewayNameForPort(GATEWAY_PORT_B)} is missing its standalone ` +
        "PID/runtime ownership proof",
    );
  }
  return identity;
}

function evidenceField(output: string, field: string): string | null {
  const values = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${field}=`))
    .map((line) => line.slice(field.length + 1).trim())
    .filter(Boolean);
  return values.length === 1 ? values[0] : null;
}

function capturedProcessIdentity(result: ShellProbeResult): CapturedProcessIdentity | null {
  const pidText = evidenceField(result.stdout, "active_pid");
  if (pidText === null) return null;
  const pid = Number(pidText);
  const executable = evidenceField(result.stdout, "process_executable");
  const startIdentity = evidenceField(result.stdout, "process_start_identity");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !executable || !startIdentity) {
    throw new Error(`incomplete gateway process identity evidence:\n${resultText(result)}`);
  }
  return { executable, pid, startIdentity };
}

function openshellEnvForGateway(gatewayName: string): NodeJS.ProcessEnv {
  return commandEnv({ OPENSHELL_GATEWAY: gatewayName });
}

function onboardEnv(
  sandboxName: string,
  gatewayPort: string,
  fakeBaseUrl: string,
): NodeJS.ProcessEnv {
  return commandEnv({
    CHAT_UI_URL: "",
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_DASHBOARD_PORT: "",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_GATEWAY_PORT: gatewayPort,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
  });
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
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs,
  });
}

async function captureGatewayEvidence(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    authority: GatewayProcessAuthority;
    gatewayName: string;
    knownPid?: number | null;
    port: string;
    stage: string;
  },
): Promise<{
  host: ShellProbeResult;
  processIdentity: CapturedProcessIdentity | null;
  sandbox: ShellProbeResult;
}> {
  const stateDir = gatewayStateDirForPort(options.port);
  const hostEvidence = await host.command(
    "bash",
    [
      "-lc",
      [
        'gateway="$1"',
        'port="$2"',
        'state_dir="$3"',
        'known_pid="$4"',
        'authority="$5"',
        'pid_file="$state_dir/openshell-gateway.pid"',
        'runtime_file="$state_dir/runtime.json"',
        'printf "gateway=%s\\nport=%s\\nstate_dir=%s\\nauthority=%s\\n" "$gateway" "$port" "$state_dir" "$authority"',
        'if [ -r "$pid_file" ]; then printf "pid_file="; cat "$pid_file"; else printf "pid_file=<missing>\\n"; fi',
        'if [ -r "$runtime_file" ]; then printf "runtime_marker=\\n"; cat "$runtime_file"; else printf "runtime_marker=<missing>\\n"; fi',
        'pid="$known_pid"',
        'if [ "$authority" = "standalone-state" ] && [ -r "$pid_file" ]; then pid="$(tr -d "[:space:]" < "$pid_file")"; fi',
        'if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then printf "proc_cmdline="; tr "\\000" " " < "/proc/$pid/cmdline"; printf "\\n"; fi',
        'if [ -n "$pid" ] && ps -p "$pid" -o pid= >/dev/null 2>&1; then',
        '  printf "active_pid=%s\\n" "$pid"',
        '  if [ -r "/proc/$pid/stat" ]; then',
        '    proc_stat="$(cat "/proc/$pid/stat")"',
        '    proc_stat="${proc_stat##*) }"',
        "    set -- $proc_stat",
        "    shift 19",
        '    printf "process_start_identity=linux:%s\\n" "$1"',
        "  else",
        '    process_started="$(ps -p "$pid" -o lstart= 2>/dev/null | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"',
        '    if [ -n "$process_started" ]; then printf "process_start_identity=ps:%s\\n" "$process_started"; fi',
        "  fi",
        '  if [ -L "/proc/$pid/exe" ]; then',
        '    printf "process_executable="; readlink "/proc/$pid/exe"; printf "\\n"',
        "  else",
        '    process_executable="$(ps -p "$pid" -o comm= 2>/dev/null | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"',
        '    if [ -n "$process_executable" ]; then printf "process_executable=%s\\n" "$process_executable"; fi',
        "  fi",
        '  ps -p "$pid" -o pid= -o ppid= -o user= -o command= 2>&1 || true',
        "fi",
        'if command -v ss >/dev/null 2>&1; then ss -H -ltnp 2>&1 | awk -v port="$port" \'$4 ~ (":" port "$")\' || true; fi',
        'if command -v lsof >/dev/null 2>&1; then lsof -nP -a -iTCP:"$port" -sTCP:LISTEN 2>&1 || true; fi',
      ].join("\n"),
      "gateway-evidence",
      options.gatewayName,
      options.port,
      stateDir,
      options.knownPid ? String(options.knownPid) : "",
      options.authority,
    ],
    {
      artifactName: `${options.stage}-${options.gatewayName}-host-identity`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(hostEvidence.exitCode, resultText(hostEvidence)).toBe(0);

  const sandboxEvidence = await sandbox.openshell(["sandbox", "list", "-g", options.gatewayName], {
    artifactName: `${options.stage}-${options.gatewayName}-sandbox-phase`,
    env: openshellEnvForGateway(options.gatewayName),
    timeoutMs: 30_000,
  });
  return {
    host: hostEvidence,
    processIdentity: capturedProcessIdentity(hostEvidence),
    sandbox: sandboxEvidence,
  };
}

async function captureGatewayPairEvidence(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    gatewayA: string;
    gatewayB: string;
    identityA: GatewayProcessIdentity;
    identityB: GatewayProcessIdentity;
    stage: string;
  },
): Promise<{
  gatewayA: {
    host: ShellProbeResult;
    processIdentity: CapturedProcessIdentity | null;
    sandbox: ShellProbeResult;
  };
  gatewayB: {
    host: ShellProbeResult;
    processIdentity: CapturedProcessIdentity | null;
    sandbox: ShellProbeResult;
  };
}> {
  const [gatewayA, gatewayB] = await Promise.all([
    captureGatewayEvidence(host, sandbox, {
      authority: options.identityA.authority,
      gatewayName: options.gatewayA,
      knownPid: options.identityA.pid,
      port: GATEWAY_PORT_A,
      stage: options.stage,
    }),
    captureGatewayEvidence(host, sandbox, {
      authority: options.identityB.authority,
      gatewayName: options.gatewayB,
      knownPid: options.identityB.pid,
      port: GATEWAY_PORT_B,
      stage: options.stage,
    }),
  ]);
  await sandbox.openshell(["gateway", "list", "-o", "json"], {
    artifactName: `${options.stage}-gateway-registrations`,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  return { gatewayA, gatewayB };
}

async function runOnboard(
  host: HostCliClient,
  sandboxName: string,
  gatewayPort: string,
  fakeBaseUrl: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await command(host, ["onboard", "--non-interactive"], {
    artifactName,
    env: onboardEnv(sandboxName, gatewayPort, fakeBaseUrl),
    timeoutMs: PHASE_TIMEOUT_MS,
  });
}

function dashboardPortFromList(output: string, sandboxName: string): string | undefined {
  let current: string | undefined;
  for (const line of output.split("\n")) {
    if (/^\s{4}\S/.test(line) && !/^\s{6}/.test(line)) {
      const stripped = line.trim();
      current = stripped ? stripped.split(/\s+/)[0] : undefined;
      continue;
    }
    if (current === sandboxName) {
      const match = line.match(/dashboard:\s+http:\/\/[0-9.]+:(\d+)\/?/);
      if (match) return match[1];
    }
  }
  return undefined;
}

function outputIncludesSandbox(output: string, sandboxName: string): boolean {
  return new RegExp(`^\\s+${sandboxName}(?: \\*)?\\s*$`, "m").test(output);
}

function sandboxPhaseFromList(output: string, sandboxName: string): string | undefined {
  for (const line of output.replace(/\x1B\[[0-9;]*m/g, "").split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === sandboxName) return parts.at(-1);
  }
  return undefined;
}

async function waitForSandboxReady(
  sandbox: SandboxClient,
  sandboxName: string,
  gatewayName: string,
  artifactPrefix: string,
): Promise<string> {
  try {
    const result = await pollUntil({
      artifactPrefix,
      attempts: PROBE_ATTEMPTS,
      delayMs: PROBE_DELAY_MS,
      probe: async (_attempt, artifactName) => {
        const probe = await sandbox.openshell(["sandbox", "list", "-g", gatewayName], {
          artifactName,
          env: openshellEnvForGateway(gatewayName),
          timeoutMs: 30_000,
        });
        const output = resultText(probe);
        return { output, phase: sandboxPhaseFromList(output, sandboxName) ?? "missing" };
      },
      accept: ({ phase }) => phase === "Ready" || phase === "Running",
      terminal: ({ phase }) =>
        phase === "Error" || phase === "Failed" || phase === "CrashLoopBackOff"
          ? `${sandboxName} reached terminal phase '${phase}' on ${gatewayName}`
          : undefined,
    });
    return result.value.phase;
  } catch (error) {
    if (!(error instanceof PollingError)) throw error;
    if (error.reason === "terminal") throw error;
    const last = error.lastAttempt?.value;
    throw new Error(
      `${sandboxName} did not reach Ready/Running on ${gatewayName}; last phase '${last?.phase ?? "missing"}'\n${last?.output ?? ""}`,
    );
  }
}

async function expectPortListening(
  host: HostCliClient,
  port: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command("bash", ["-lc", `ss -ltn | grep -Eq '[:.]${port}\\b'`], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

async function expectPortNotListening(
  host: HostCliClient,
  port: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command("bash", ["-lc", `! ss -ltn | grep -Eq '[:.]${port}\\b'`], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

async function expectSurvivingGatewayHealthyAcrossProbes(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    dashboardPort: string;
    gatewayName: string;
    gatewayPort: string;
    sandboxName: string;
  },
): Promise<string[]> {
  const phases: string[] = [];
  for (let attempt = 1; attempt <= POST_UNINSTALL_HEALTH_PROBES; attempt += 1) {
    const suffix = String(attempt).padStart(2, "0");
    const sandboxList = await sandbox.openshell(["sandbox", "list", "-g", options.gatewayName], {
      artifactName: `phase-4-survivor-probe-${suffix}-sandbox-phase`,
      env: openshellEnvForGateway(options.gatewayName),
      timeoutMs: 30_000,
    });
    expect(sandboxList.exitCode, resultText(sandboxList)).toBe(0);
    const phase = sandboxPhaseFromList(resultText(sandboxList), options.sandboxName) ?? "missing";
    phases.push(phase);
    expect(
      ["Ready", "Running"],
      `survivor probe ${String(attempt)} observed ${options.sandboxName} phase '${phase}'`,
    ).toContain(phase);

    await expectPortListening(
      host,
      options.gatewayPort,
      `phase-4-survivor-probe-${suffix}-gateway-listener`,
    );
    const scopedList = await command(host, ["list"], {
      artifactName: `phase-4-survivor-probe-${suffix}-nemoclaw-list`,
      env: commandEnv({ NEMOCLAW_GATEWAY_PORT: options.gatewayPort }),
      timeoutMs: 60_000,
    });
    expect(scopedList.exitCode, resultText(scopedList)).toBe(0);
    expect(outputIncludesSandbox(scopedList.stdout, options.sandboxName), scopedList.stdout).toBe(
      true,
    );

    const dashboard = await host.command(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        "10",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${options.dashboardPort}/`,
      ],
      {
        artifactName: `phase-4-survivor-probe-${suffix}-dashboard-http`,
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(dashboard.exitCode, resultText(dashboard)).toBe(0);
    expect(dashboard.stdout.trim()).toMatch(/^[23][0-9]{2}$/);

    if (attempt < POST_UNINSTALL_HEALTH_PROBES) await sleep(PROBE_DELAY_MS);
  }
  return phases;
}

async function prerequisiteOrSkip(
  host: HostCliClient,
  skip: (message: string) => never,
  commandName: string,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command(commandName, args, {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0) return result;
  const message = `${commandName} ${args.join(" ")} is required for concurrent gateway ports E2E: ${resultText(
    result,
  )}`;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
  skip(message);
}

async function bestEffortPreclean(
  host: HostCliClient,
  sandbox: SandboxClient,
  gatewayA: string,
  gatewayB: string,
): Promise<void> {
  for (const [name, gateway, port] of [
    [SANDBOX_B, gatewayB, GATEWAY_PORT_B],
    [SANDBOX_A, gatewayA, GATEWAY_PORT_A],
  ] as const) {
    try {
      await command(host, [name, "destroy", "--yes"], {
        artifactName: `cleanup-destroy-${name}`,
        env: commandEnv({ NEMOCLAW_GATEWAY_PORT: port }),
        timeoutMs: 5 * 60_000,
      });
    } catch {
      // best effort
    }
    try {
      await sandbox.openshell(["sandbox", "delete", name, "-g", gateway], {
        artifactName: `cleanup-openshell-delete-${name}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      });
    } catch {
      // best effort
    }
  }
  for (const port of [
    "18789",
    "18790",
    "18791",
    "18792",
    "18793",
    "18794",
    "18795",
    "18796",
    "18797",
    "18798",
    "18799",
  ]) {
    try {
      await sandbox.openshell(["forward", "stop", port], {
        artifactName: `cleanup-forward-stop-${port}`,
        env: commandEnv(),
        timeoutMs: 15_000,
      });
    } catch {
      // best effort
    }
  }
  for (const gateway of [gatewayB, gatewayA]) {
    try {
      await sandbox.openshell(["gateway", "destroy", "-g", gateway], {
        artifactName: `cleanup-gateway-destroy-${gateway}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      });
    } catch {
      // best effort
    }
  }
}

async function cleanupNemoClawSandbox(
  host: HostCliClient,
  name: string,
  port: string,
): Promise<void> {
  const result = await command(host, [name, "destroy", "--yes"], {
    artifactName: `cleanup-destroy-${name}`,
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: port }),
    timeoutMs: 5 * 60_000,
  });
  const output = resultText(result);
  expect(
    result.exitCode === 0 ||
      /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu.test(
        output,
      ),
    `cleanup concurrent gateway sandbox ${name}: ${output}`,
  ).toBe(true);
}

test("concurrent gateway ports: onboards two sandboxes on isolated gateways and dashboards", {
  timeout: TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "validate multi-gateway prerequisites",
      "onboard sandbox on default gateway",
      "onboard sandbox on alternate gateway",
      "verify isolated gateways and dashboard forwards",
      "uninstall alternate gateway without disrupting default",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  await prerequisiteOrSkip(host, skip, "docker", ["info"], "prereq-docker-info");
  await prerequisiteOrSkip(
    host,
    skip,
    "bash",
    ["-lc", 'command -v "$1"', "prereq-openshell", host.openshellCommandPath],
    "prereq-openshell",
  );
  await prerequisiteOrSkip(
    host,
    skip,
    process.execPath,
    [CLI_ENTRYPOINT, "--version"],
    "prereq-nemoclaw-version",
  );

  const gatewayA = gatewayNameForPort(GATEWAY_PORT_A);
  const gatewayB = gatewayNameForPort(GATEWAY_PORT_B);
  // OpenShell reaches this fixture from its gateway network namespace, where
  // the runner's loopback address is not routable.
  const fake = await startFakeOpenAiCompatibleServer({
    host: "0.0.0.0",
    port: Number(process.env.NEMOCLAW_E2E_FAKE_PORT ?? 0),
    progress,
    publicHost: "host.openshell.internal",
  });
  await artifacts.target.declare({
    id: "concurrent-gateway-ports",
    boundary: "direct-cli-docker-openshell-multiple-gateways-dashboard-forwards",
    contract: [
      "sandbox A onboards on the default NemoClaw gateway and dashboard port",
      "sandbox B onboards with NEMOCLAW_GATEWAY_PORT on a non-default gateway",
      "both sandboxes, gateways, and dashboard forwards coexist without port collision",
      "each port-scoped registry lists only the sandbox owned by that gateway",
      "uninstalling gateway B removes only its scoped state and leaves gateway A plus the shared CLI healthy",
    ],
    gatewayA,
    gatewayB,
    fakeBaseUrl: fake.baseUrl,
  });
  cleanup.add("close fake OpenAI-compatible endpoint", async () => {
    await artifacts.writeJson("fake-openai-requests.json", fake.requests());
    await fake.close();
  });
  for (const gateway of [gatewayA, gatewayB]) {
    cleanup.trackGateway(host, gateway, {
      artifactName: `cleanup-gateway-destroy-${gateway}`,
      env: openshellEnvForGateway(gateway),
      timeoutMs: 60_000,
    });
  }
  for (const port of [
    18799, 18798, 18797, 18796, 18795, 18794, 18793, 18792, 18791, 18790, 18789,
  ]) {
    cleanup.trackForward(host, port, {
      artifactName: `cleanup-forward-stop-${port}`,
      env: commandEnv(),
      timeoutMs: 15_000,
    });
  }
  for (const [name, gateway, port] of [
    [SANDBOX_A, gatewayA, GATEWAY_PORT_A],
    [SANDBOX_B, gatewayB, GATEWAY_PORT_B],
  ] as const) {
    cleanup.trackDisposable(`delete concurrent gateway OpenShell sandbox ${name}`, () =>
      sandbox.cleanupSandbox(name, {
        artifactName: `cleanup-openshell-delete-${name}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackDisposable(`destroy concurrent gateway sandbox ${name}`, () =>
      cleanupNemoClawSandbox(host, name, port),
    );
  }

  await bestEffortPreclean(host, sandbox, gatewayA, gatewayB);

  progress.phase("onboard sandbox on default gateway");
  const onboardA = await runOnboard(
    host,
    SANDBOX_A,
    GATEWAY_PORT_A,
    fake.baseUrl,
    "phase-1-onboard-sandbox-a",
  );
  expect(onboardA.exitCode, resultText(onboardA)).toBe(0);
  const phaseA = await waitForSandboxReady(sandbox, SANDBOX_A, gatewayA, "phase-1-sandbox-a-ready");
  expect(["Ready", "Running"]).toContain(phaseA);

  const listAfterA = await command(host, ["list"], {
    artifactName: "phase-1-nemoclaw-list-after-a",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
    timeoutMs: 60_000,
  });
  expect(listAfterA.exitCode, resultText(listAfterA)).toBe(0);
  const dashboardA = dashboardPortFromList(listAfterA.stdout, SANDBOX_A);
  expect(dashboardA, listAfterA.stdout).toBe(DASHBOARD_PORT_A);
  await expectPortListening(host, GATEWAY_PORT_A, "phase-1-gateway-port-a-listening");

  progress.phase("onboard sandbox on alternate gateway");
  const onboardB = await runOnboard(
    host,
    SANDBOX_B,
    GATEWAY_PORT_B,
    fake.baseUrl,
    "phase-2-onboard-sandbox-b",
  );
  expect(onboardB.exitCode, resultText(onboardB)).toBe(0);

  progress.phase("verify isolated gateways and dashboard forwards");
  const phaseAAfterB = await waitForSandboxReady(
    sandbox,
    SANDBOX_A,
    gatewayA,
    "phase-3-sandbox-a-still-ready",
  );
  const phaseBAfterB = await waitForSandboxReady(
    sandbox,
    SANDBOX_B,
    gatewayB,
    "phase-3-sandbox-b-ready",
  );
  expect(["Ready", "Running"]).toContain(phaseAAfterB);
  expect(["Ready", "Running"]).toContain(phaseBAfterB);
  await expectPortListening(host, GATEWAY_PORT_A, "phase-3-gateway-port-a-still-listening");
  await expectPortListening(host, GATEWAY_PORT_B, "phase-3-gateway-port-b-listening");

  const listGatewayA = await command(host, ["list"], {
    artifactName: "phase-3-nemoclaw-list-gateway-a",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
    timeoutMs: 60_000,
  });
  expect(listGatewayA.exitCode, resultText(listGatewayA)).toBe(0);
  expect(outputIncludesSandbox(listGatewayA.stdout, SANDBOX_A), listGatewayA.stdout).toBe(true);
  expect(outputIncludesSandbox(listGatewayA.stdout, SANDBOX_B), listGatewayA.stdout).toBe(false);

  const listGatewayB = await command(host, ["list"], {
    artifactName: "phase-3-nemoclaw-list-gateway-b",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
    timeoutMs: 60_000,
  });
  expect(listGatewayB.exitCode, resultText(listGatewayB)).toBe(0);
  expect(outputIncludesSandbox(listGatewayB.stdout, SANDBOX_B), listGatewayB.stdout).toBe(true);
  expect(outputIncludesSandbox(listGatewayB.stdout, SANDBOX_A), listGatewayB.stdout).toBe(false);

  const dashboardAAfterB = dashboardPortFromList(listGatewayA.stdout, SANDBOX_A);
  const dashboardB = dashboardPortFromList(listGatewayB.stdout, SANDBOX_B);
  expect(dashboardAAfterB, listGatewayA.stdout).toBe(dashboardA);
  expect(dashboardB, listGatewayB.stdout).toBeTruthy();
  expect(dashboardB).not.toBe(dashboardA);

  progress.phase("uninstall alternate gateway without disrupting default");
  const gatewayIdentityA = readDefaultGatewayIdentity();
  const gatewayIdentityB = readAlternateGatewayIdentity();
  expect(gatewayIdentityA.pid).not.toBe(gatewayIdentityB.pid);
  expect(gatewayIdentityB.authority).toBe("standalone-state");
  const beforeUninstallEvidence = await captureGatewayPairEvidence(host, sandbox, {
    gatewayA,
    gatewayB,
    identityA: gatewayIdentityA,
    identityB: gatewayIdentityB,
    stage: "phase-4-before-uninstall",
  });
  expect(beforeUninstallEvidence.gatewayA.processIdentity?.pid).toBe(gatewayIdentityA.pid);
  expect(beforeUninstallEvidence.gatewayB.processIdentity?.pid).toBe(gatewayIdentityB.pid);
  if (process.platform === "linux") {
    if (gatewayIdentityA.authority === "standalone-state") {
      expect(resultText(beforeUninstallEvidence.gatewayA.host)).toContain(
        `openshell-gateway[nemoclaw=${gatewayA};port=${GATEWAY_PORT_A}]`,
      );
    }
    expect(resultText(beforeUninstallEvidence.gatewayB.host)).toContain(
      `openshell-gateway[nemoclaw=${gatewayB};port=${GATEWAY_PORT_B}]`,
    );
    expect(resultText(beforeUninstallEvidence.gatewayA.host)).toContain(
      `active_pid=${String(gatewayIdentityA.pid)}`,
    );
    expect(resultText(beforeUninstallEvidence.gatewayA.host)).not.toContain(
      `active_pid=${String(gatewayIdentityB.pid)}`,
    );
    expect(resultText(beforeUninstallEvidence.gatewayB.host)).toContain(
      `active_pid=${String(gatewayIdentityB.pid)}`,
    );
    expect(resultText(beforeUninstallEvidence.gatewayB.host)).not.toContain(
      `active_pid=${String(gatewayIdentityA.pid)}`,
    );
  }

  const uninstallB = await command(host, ["uninstall", "--yes", "--destroy-user-data"], {
    artifactName: "phase-4-uninstall-gateway-b",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
    timeoutMs: 5 * 60_000,
  });
  expect(uninstallB.exitCode, resultText(uninstallB)).toBe(0);

  const gatewayIdentityAAfterUninstall = readDefaultGatewayIdentity();
  expect(gatewayIdentityAAfterUninstall).toEqual(gatewayIdentityA);
  const afterUninstallEvidence = await captureGatewayPairEvidence(host, sandbox, {
    gatewayA,
    gatewayB,
    identityA: gatewayIdentityAAfterUninstall,
    identityB: gatewayIdentityB,
    stage: "phase-4-after-uninstall",
  });
  expect(readGatewayPid(GATEWAY_PORT_B)).toBeNull();
  expect(readGatewayRuntimePid(GATEWAY_PORT_B)).toBeNull();
  expect(afterUninstallEvidence.gatewayA.processIdentity).toEqual(
    beforeUninstallEvidence.gatewayA.processIdentity,
  );
  expect(afterUninstallEvidence.gatewayB.processIdentity).toBeNull();
  if (process.platform === "linux") {
    if (gatewayIdentityA.authority === "standalone-state") {
      expect(resultText(afterUninstallEvidence.gatewayA.host)).toContain(
        `openshell-gateway[nemoclaw=${gatewayA};port=${GATEWAY_PORT_A}]`,
      );
    }
    expect(resultText(afterUninstallEvidence.gatewayA.host)).toContain(
      `active_pid=${String(gatewayIdentityA.pid)}`,
    );
    expect(resultText(afterUninstallEvidence.gatewayB.host)).not.toContain(
      `active_pid=${String(gatewayIdentityB.pid)}`,
    );
  }

  const survivorPhases = await expectSurvivingGatewayHealthyAcrossProbes(host, sandbox, {
    dashboardPort: dashboardA as string,
    gatewayName: gatewayA,
    gatewayPort: GATEWAY_PORT_A,
    sandboxName: SANDBOX_A,
  });
  await expectPortNotListening(host, GATEWAY_PORT_B, "phase-4-gateway-port-b-stopped");

  const listAAfterUninstallB = await command(host, ["list"], {
    artifactName: "phase-4-nemoclaw-list-a-after-b-uninstall",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
    timeoutMs: 60_000,
  });
  expect(listAAfterUninstallB.exitCode, resultText(listAAfterUninstallB)).toBe(0);
  expect(outputIncludesSandbox(listAAfterUninstallB.stdout, SANDBOX_A)).toBe(true);

  const scopedStateRemoved = await host.command(
    "bash",
    ["-lc", `test ! -e "$HOME/.nemoclaw/gateways/${GATEWAY_PORT_B}"`],
    {
      artifactName: "phase-4-gateway-b-state-removed",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(scopedStateRemoved.exitCode, resultText(scopedStateRemoved)).toBe(0);

  await artifacts.target.complete({
    id: "concurrent-gateway-ports",
    assertions: {
      sandboxAOnboarded: onboardA.exitCode === 0,
      sandboxBOnboarded: onboardB.exitCode === 0,
      sandboxAPreserved: ["Ready", "Running"].includes(phaseAAfterB),
      sandboxBReady: ["Ready", "Running"].includes(phaseBAfterB),
      registryScopesIsolated:
        outputIncludesSandbox(listGatewayA.stdout, SANDBOX_A) &&
        !outputIncludesSandbox(listGatewayA.stdout, SANDBOX_B) &&
        outputIncludesSandbox(listGatewayB.stdout, SANDBOX_B) &&
        !outputIncludesSandbox(listGatewayB.stdout, SANDBOX_A),
      dashboardPortsDistinct: Boolean(dashboardA && dashboardB && dashboardA !== dashboardB),
      gatewayBUninstalled: uninstallB.exitCode === 0 && scopedStateRemoved.exitCode === 0,
      sandboxAPreservedAfterUninstallB:
        survivorPhases.length === POST_UNINSTALL_HEALTH_PROBES &&
        survivorPhases.every((phase) => phase === "Ready" || phase === "Running"),
      sharedCliPreserved: listAAfterUninstallB.exitCode === 0,
    },
  });
});
