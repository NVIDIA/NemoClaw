// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real-system boundaries: two NemoClaw onboards on one
 * host, per-port OpenShell Docker-driver gateways, dashboard forward
 * allocation, port-scoped `nemoclaw list`, OpenShell sandbox discovery, host
 * socket probes, selected-instance uninstall/health cleanup, and whole-host
 * uninstall when only a non-default gateway remains. This case also verifies
 * cross-gateway destroy survival under both cleanup policies: gateway A stays
 * selected and its sandbox restarts through unscoped OpenShell commands.
 */

import fs from "node:fs";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
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
const GATEWAY_PORT_A = process.env.NEMOCLAW_E2E_GATEWAY_PORT_A ?? "18079";
const GATEWAY_PORT_B = process.env.NEMOCLAW_E2E_GATEWAY_PORT_B ?? "18080";
const DASHBOARD_PORT_A = process.env.NEMOCLAW_E2E_DASHBOARD_PORT_A ?? "18789";
const PHASE_TIMEOUT_MS = execTimeout(
  Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000,
);
const PROBE_ATTEMPTS = Number(process.env.NEMOCLAW_E2E_PROBE_ATTEMPTS ?? 12);
const PROBE_DELAY_MS = Number(process.env.NEMOCLAW_E2E_PROBE_DELAY_SECONDS ?? 5) * 1_000;
const TEST_TIMEOUT_MS = testTimeout(90 * 60_000);
const POST_UNINSTALL_HEALTH_PROBES = 3;

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

function gatewayRegistryContains(result: ShellProbeResult, gatewayName: string): boolean {
  try {
    const gateways: unknown = JSON.parse(result.stdout);
    return (
      Array.isArray(gateways) &&
      gateways.some(
        (gateway) =>
          gateway &&
          typeof gateway === "object" &&
          (gateway as { name?: unknown }).name === gatewayName,
      )
    );
  } catch {
    return false;
  }
}

function gatewayProcessEvidence(evidence: string, gateway: string): string | undefined {
  return evidence
    .split(`gateway=${gateway}\n`)[1]
    ?.split("gateway=")[0]
    ?.match(/^active_pid=\d+\nexecutable=.*\n.*$/m)?.[0];
}

async function captureGatewayEvidence(
  host: HostCliClient,
  sandbox: SandboxClient,
  gateways: readonly (readonly [string, string])[],
  stage: string,
): Promise<string> {
  const script = [
    'for spec in "$@"; do',
    '  gateway="${spec%%:*}"; port="${spec##*:}"; leaf=openshell-docker-gateway',
    '  test "$port" = 8080 || leaf="$leaf-$port"',
    '  state="$HOME/.local/state/nemoclaw/$leaf"; pid=""',
    '  test ! -r "$state/openshell-gateway.pid" || pid="$(tr -d "[:space:]" < "$state/openshell-gateway.pid")"',
    '  if test -z "$pid" && test "$port" = 8080 && command -v systemctl >/dev/null; then for service in openshell-gateway nemoclaw-openshell-gateway; do candidate="$(systemctl --user show "$service" --property=MainPID --value 2>/dev/null || true)"; test "${candidate:-0}" -le 0 || { pid="$candidate"; break; }; done; fi',
    '  printf "gateway=%s\\nport=%s\\npid_file=%s\\n" "$gateway" "$port" "${pid:-<missing>}"',
    '  if test -n "$pid" && ps -p "$pid" >/dev/null 2>&1; then printf "active_pid=%s\\nexecutable=%s\\n" "$pid" "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"; ps -p "$pid" -o pid=,ppid=,uid=,lstart=,args=; fi',
    '  printf "listeners=\\n"; ss -H -ltnp 2>&1 | grep -E "[:.]$port\\b" || true',
    '  printf "runtime=\\n"; test ! -r "$state/runtime.json" || cat "$state/runtime.json"',
    '  printf "namespace=\\n"; test ! -r "$state/openshell-gateway.toml" || grep "^sandbox_namespace" "$state/openshell-gateway.toml" || true',
    "done",
  ].join("\n");
  const evidence = await host.command(
    "bash",
    ["-lc", script, "gateway-evidence", ...gateways.map(([name, port]) => `${name}:${port}`)],
    { artifactName: `${stage}-gateway-processes`, env: commandEnv(), timeoutMs: 30_000 },
  );
  expect(evidence.exitCode, resultText(evidence)).toBe(0);
  await Promise.all(
    gateways.map(([name]) =>
      sandbox.openshell(["sandbox", "list", "-g", name], {
        artifactName: `${stage}-${name}-sandbox-phase`,
        env: openshellEnvForGateway(name),
        timeoutMs: 30_000,
      }),
    ),
  );
  return resultText(evidence);
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

interface SurvivorDashboardProbe {
  readonly gatewayPort: ShellProbeResult;
  readonly scopedList: ShellProbeResult;
  readonly dashboard: readonly ShellProbeResult[];
}

async function probeSurvivorDashboard(
  host: HostCliClient,
  sandbox: SandboxClient,
  gatewayName: string,
  gatewayPort: string,
  dashboardPort: string,
  artifactPrefix: string,
  dashboardProbes = 1,
): Promise<SurvivorDashboardProbe> {
  const gatewayPortProbe = await host.command(
    "bash",
    ["-lc", `ss -ltn | grep -Eq '[:.]${gatewayPort}\\b'`],
    {
      artifactName: `${artifactPrefix}-gateway-port`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  const scopedList = await sandbox.openshell(["sandbox", "list", "-g", gatewayName], {
    artifactName: `${artifactPrefix}-registry`,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  const dashboard: ShellProbeResult[] = [];
  for (let probe = 1; probe <= dashboardProbes; probe += 1) {
    dashboard.push(
      await host.command(
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
          `http://127.0.0.1:${dashboardPort}/`,
        ],
        {
          artifactName: `${artifactPrefix}-dashboard-${String(probe)}`,
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      ),
    );
    await (probe < dashboardProbes ? sleep(PROBE_DELAY_MS) : Promise.resolve());
  }
  return { gatewayPort: gatewayPortProbe, scopedList, dashboard };
}

async function selectAndVerifyActiveGateway(
  sandbox: SandboxClient,
  gatewayName: string,
  sandboxName: string,
  siblingSandboxName: string,
  artifactPrefix: string,
): Promise<{
  readonly select: ShellProbeResult;
  readonly list: ShellProbeResult;
  readonly containsOnlyTargetSandbox: boolean;
}> {
  const select = await sandbox.openshell(["gateway", "select", gatewayName], {
    artifactName: `${artifactPrefix}-select`,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  const list = await sandbox.openshell(["sandbox", "list"], {
    artifactName: `${artifactPrefix}-active-sandbox-list`,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  return {
    select,
    list,
    containsOnlyTargetSandbox:
      list.exitCode === 0 &&
      outputIncludesSandbox(list.stdout, sandboxName) &&
      !outputIncludesSandbox(list.stdout, siblingSandboxName),
  };
}

async function stopStartSurvivor(
  sandbox: SandboxClient,
  sandboxName: string,
  gatewayName: string,
  artifactPrefix: string,
): Promise<{
  readonly stop: ShellProbeResult;
  readonly start: ShellProbeResult;
  readonly phase: string;
}> {
  const stop = await sandbox.openshell(["sandbox", "stop", sandboxName], {
    artifactName: `${artifactPrefix}-stop`,
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  const start = await sandbox.openshell(["sandbox", "start", sandboxName], {
    artifactName: `${artifactPrefix}-start`,
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  const phase = await waitForSandboxReady(
    sandbox,
    sandboxName,
    gatewayName,
    `${artifactPrefix}-ready`,
  );
  return { stop, start, phase };
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

test(
  "concurrent gateway ports: onboards two sandboxes on isolated gateways and dashboards",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate multi-gateway prerequisites",
        "onboard sandbox on first non-default gateway",
        "onboard sandbox on alternate gateway",
        "verify isolated gateways and dashboard forwards",
        "garbage-collect an orphan without deleting the sibling gateway image",
        "destroy alternate sandbox with gateway cleanup while restarting the survivor",
        "destroy alternate sandbox without gateway cleanup while restarting the survivor",
        "restore the alternate sandbox before uninstall",
        "uninstall one gateway without disrupting its sibling",
        "whole-host uninstall omits the absent default gateway",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
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
        "sandboxes A and B onboard on distinct non-default NemoClaw gateway ports",
        "both sandboxes, gateways, and dashboard forwards coexist without port collision",
        "each port-scoped registry lists only the sandbox owned by that gateway",
        "gc on gateway A preserves gateway B's registered image while removing a true orphan tag",
        "destroy with gateway cleanup removes gateway B, preserves selected gateway A, and keeps A restartable and dashboard-reachable",
        "destroy without gateway cleanup removes only B's sandbox, preserves gateway B and selected gateway A, and keeps A restartable and dashboard-reachable",
        "uninstalling gateway B removes only its scoped state and leaves gateway A plus the shared CLI healthy",
        "whole-host uninstall removes the remaining non-default gateway without enumerating port 8080",
      ],
      gatewayA,
      gatewayB,
      fakeBaseUrl: fake.baseUrl,
    });
    cleanup.add("close fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-requests.json", fake.requests());
      await fake.close();
    });
    [gatewayA, gatewayB].forEach((gateway) => {
      cleanup.trackGateway(host, gateway, {
        artifactName: `cleanup-gateway-destroy-${gateway}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      });
    });
    [18799, 18798, 18797, 18796, 18795, 18794, 18793, 18792, 18791, 18790, 18789].forEach(
      (port) => {
        cleanup.trackForward(host, port, {
          artifactName: `cleanup-forward-stop-${port}`,
          env: commandEnv(),
          timeoutMs: 15_000,
        });
      },
    );
    (
      [
        [SANDBOX_A, gatewayA, GATEWAY_PORT_A],
        [SANDBOX_B, gatewayB, GATEWAY_PORT_B],
      ] as const
    ).forEach(([name, gateway, port]) => {
      cleanup.trackDisposable(`delete concurrent gateway OpenShell sandbox ${name}`, () =>
        sandbox.cleanupSandboxBeforeOnboard(name, {
          artifactName: `cleanup-openshell-delete-${name}`,
          env: openshellEnvForGateway(gateway),
          timeoutMs: 60_000,
        }),
      );
      cleanup.trackDisposable(`destroy concurrent gateway sandbox ${name}`, () =>
        cleanupNemoClawSandbox(host, name, port),
      );
    });

    await bestEffortPreclean(host, sandbox, gatewayA, gatewayB);

    progress.phase("onboard sandbox on first non-default gateway");
    const onboardA = await runOnboard(
      host,
      SANDBOX_A,
      GATEWAY_PORT_A,
      fake.baseUrl,
      "phase-1-onboard-sandbox-a",
    );
    expect(onboardA.exitCode, resultText(onboardA)).toBe(0);
    const phaseA = await waitForSandboxReady(
      sandbox,
      SANDBOX_A,
      gatewayA,
      "phase-1-sandbox-a-ready",
    );
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
    expect(
      [phaseAAfterB, phaseBAfterB].every((phase) => phase === "Ready" || phase === "Running"),
      `gateway A=${phaseAAfterB}, gateway B=${phaseBAfterB}`,
    ).toBe(true);
    await expectPortListening(host, GATEWAY_PORT_A, "phase-3-gateway-port-a-still-listening");
    await expectPortListening(host, GATEWAY_PORT_B, "phase-3-gateway-port-b-listening");

    const listGatewayA = await command(host, ["list"], {
      artifactName: "phase-3-nemoclaw-list-gateway-a",
      env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
      timeoutMs: 60_000,
    });
    const listGatewayB = await command(host, ["list"], {
      artifactName: "phase-3-nemoclaw-list-gateway-b",
      env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
      timeoutMs: 60_000,
    });
    expect(
      listGatewayA.exitCode === 0 &&
        listGatewayB.exitCode === 0 &&
        outputIncludesSandbox(listGatewayA.stdout, SANDBOX_A) &&
        !outputIncludesSandbox(listGatewayA.stdout, SANDBOX_B) &&
        outputIncludesSandbox(listGatewayB.stdout, SANDBOX_B) &&
        !outputIncludesSandbox(listGatewayB.stdout, SANDBOX_A),
      `gateway A list:\n${resultText(listGatewayA)}\ngateway B list:\n${resultText(listGatewayB)}`,
    ).toBe(true);

    const dashboardAAfterB = dashboardPortFromList(listGatewayA.stdout, SANDBOX_A);
    const dashboardB = dashboardPortFromList(listGatewayB.stdout, SANDBOX_B);
    expect(
      dashboardAAfterB === dashboardA && Boolean(dashboardB) && dashboardB !== dashboardA,
      `dashboard A before=${dashboardA}, after=${dashboardAAfterB}, gateway B=${dashboardB}`,
    ).toBe(true);

    progress.phase("garbage-collect an orphan without deleting the sibling gateway image");
    const registeredImage = await host.command(
      "bash",
      [
        "-lc",
        `jq -er --arg name '${SANDBOX_B}' '.sandboxes[$name].imageTag | select(type == "string" and length > 0)' "$HOME/.nemoclaw/gateways/${GATEWAY_PORT_B}/sandboxes.json"`,
      ],
      {
        artifactName: "phase-3-gateway-b-registered-image",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const registeredImageTag = resultText(registeredImage).trim();
    const siblingImageBeforeGc = await host.command(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", registeredImageTag],
      {
        artifactName: "phase-3-gateway-b-image-before-gc",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );

    const orphanTag = `nemoclaw-sandbox-local:concurrent-gc-orphan-${Date.now()}`;
    const taggedOrphan = await host.command(
      "docker",
      ["image", "tag", registeredImageTag, orphanTag],
      {
        artifactName: "phase-3-create-gc-orphan-tag",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    cleanup.trackDisposable("remove temporary concurrent gateway GC tag", async () => {
      await host.command("docker", ["image", "rm", orphanTag], {
        artifactName: "cleanup-remove-gc-orphan-tag",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
    });

    const garbageCollect = await command(host, ["gc", "--yes"], {
      artifactName: "phase-3-gc-from-gateway-a",
      env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
      timeoutMs: 5 * 60_000,
    });

    const retainedSiblingImage = await host.command(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", registeredImageTag],
      {
        artifactName: "phase-3-gateway-b-image-retained-after-gc",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const orphanTagsAfterGc = await host.command(
      "docker",
      ["image", "ls", "--filter", `reference=${orphanTag}`, "--format", "{{.Repository}}:{{.Tag}}"],
      {
        artifactName: "phase-3-gc-orphan-tag-removed",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const orphanTagAbsent =
      orphanTagsAfterGc.exitCode === 0 && !orphanTagsAfterGc.stdout.split("\n").includes(orphanTag);
    const siblingImagePreserved =
      siblingImageBeforeGc.exitCode === 0 &&
      retainedSiblingImage.exitCode === 0 &&
      siblingImageBeforeGc.stdout.trim().length > 0 &&
      retainedSiblingImage.stdout.trim() === siblingImageBeforeGc.stdout.trim();
    expect(
      registeredImage.exitCode === 0 &&
        taggedOrphan.exitCode === 0 &&
        garbageCollect.exitCode === 0 &&
        siblingImagePreserved &&
        orphanTagAbsent,
      `registered image=${resultText(registeredImage)}, ref=${registeredImageTag}; sibling before=${resultText(siblingImageBeforeGc)}; orphan tag=${resultText(taggedOrphan)}; gc=${resultText(garbageCollect)}; sibling after=${resultText(retainedSiblingImage)}; orphan tags=${resultText(orphanTagsAfterGc)}`,
    ).toBe(true);

    progress.phase("destroy alternate sandbox with gateway cleanup while restarting the survivor");
    const gatewayAProcessBeforeCleanupDestroy = gatewayProcessEvidence(
      await captureGatewayEvidence(
        host,
        sandbox,
        [[gatewayA, GATEWAY_PORT_A]],
        "phase-3-before-cleanup-destroy",
      ),
      gatewayA,
    );
    const gatewayASelectionBeforeCleanupDestroy = await selectAndVerifyActiveGateway(
      sandbox,
      gatewayA,
      SANDBOX_A,
      SANDBOX_B,
      "phase-3-select-gateway-a-before-cleanup-destroy",
    );
    const gatewayASelectedBeforeCleanupDestroy =
      gatewayASelectionBeforeCleanupDestroy.select.exitCode === 0 &&
      gatewayASelectionBeforeCleanupDestroy.containsOnlyTargetSandbox;
    expect(
      gatewayASelectedBeforeCleanupDestroy,
      `select=${resultText(gatewayASelectionBeforeCleanupDestroy.select)}; list=${resultText(gatewayASelectionBeforeCleanupDestroy.list)}`,
    ).toBe(true);
    const destroyBWithGatewayCleanup = await command(
      host,
      [SANDBOX_B, "destroy", "--yes", "--cleanup-gateway"],
      {
        artifactName: "phase-3-destroy-b-with-gateway-cleanup",
        env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
        timeoutMs: 5 * 60_000,
      },
    );
    const gatewayRegistryAfterCleanupDestroy = await sandbox.openshell(
      ["gateway", "list", "-o", "json"],
      {
        artifactName: "phase-3-gateway-registry-after-cleanup-destroy",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const gatewayBStoppedAfterCleanupDestroy = await host.command(
      "bash",
      ["-lc", `! ss -ltn | grep -Eq '[:.]${GATEWAY_PORT_B}\\b'`],
      {
        artifactName: "phase-3-gateway-b-stopped-after-destroy",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const gatewayAProcessAfterCleanupDestroy = gatewayProcessEvidence(
      await captureGatewayEvidence(
        host,
        sandbox,
        [[gatewayA, GATEWAY_PORT_A]],
        "phase-3-after-cleanup-destroy",
      ),
      gatewayA,
    );
    const liveSurvivorAfterCleanupDestroy = await probeSurvivorDashboard(
      host,
      sandbox,
      gatewayA,
      GATEWAY_PORT_A,
      DASHBOARD_PORT_A,
      "phase-3-live-survivor-after-cleanup-destroy",
    );
    const gatewayBDestroyedWithCleanup =
      destroyBWithGatewayCleanup.exitCode === 0 &&
      gatewayRegistryAfterCleanupDestroy.exitCode === 0 &&
      !gatewayRegistryContains(gatewayRegistryAfterCleanupDestroy, gatewayB) &&
      gatewayBStoppedAfterCleanupDestroy.exitCode === 0;
    const gatewayAProcessPreservedWithCleanup =
      Boolean(gatewayAProcessBeforeCleanupDestroy) &&
      gatewayAProcessAfterCleanupDestroy === gatewayAProcessBeforeCleanupDestroy;
    const gatewayAHealthyBeforeCleanupRestart =
      liveSurvivorAfterCleanupDestroy.gatewayPort.exitCode === 0 &&
      liveSurvivorAfterCleanupDestroy.scopedList.exitCode === 0 &&
      outputIncludesSandbox(liveSurvivorAfterCleanupDestroy.scopedList.stdout, SANDBOX_A) &&
      liveSurvivorAfterCleanupDestroy.dashboard.every(
        (probe) => probe.exitCode === 0 && /^[23][0-9]{2}$/.test(probe.stdout.trim()),
      );
    expect(
      gatewayASelectedBeforeCleanupDestroy &&
        gatewayBDestroyedWithCleanup &&
        gatewayAProcessPreservedWithCleanup &&
        gatewayAHealthyBeforeCleanupRestart,
      `selected A=${resultText(gatewayASelectionBeforeCleanupDestroy.select)}; active list=${resultText(gatewayASelectionBeforeCleanupDestroy.list)}; destroy=${resultText(destroyBWithGatewayCleanup)}; gateway B=${resultText(gatewayBStoppedAfterCleanupDestroy)}; gateway registry=${resultText(gatewayRegistryAfterCleanupDestroy)}; gateway A before=${gatewayAProcessBeforeCleanupDestroy}; gateway A after=${gatewayAProcessAfterCleanupDestroy}; survivor port=${resultText(liveSurvivorAfterCleanupDestroy.gatewayPort)}; list=${resultText(liveSurvivorAfterCleanupDestroy.scopedList)}; dashboard=${liveSurvivorAfterCleanupDestroy.dashboard.map(resultText).join("\\n")}`,
    ).toBe(true);
    const survivorRestartAfterCleanupDestroy = await stopStartSurvivor(
      sandbox,
      SANDBOX_A,
      gatewayA,
      "phase-3-survivor-after-cleanup-destroy",
    );
    const survivorDashboardAfterCleanupDestroy = await probeSurvivorDashboard(
      host,
      sandbox,
      gatewayA,
      GATEWAY_PORT_A,
      DASHBOARD_PORT_A,
      "phase-3-survivor-after-cleanup-destroy",
      POST_UNINSTALL_HEALTH_PROBES,
    );
    const sandboxARestartedWithCleanup =
      survivorRestartAfterCleanupDestroy.stop.exitCode === 0 &&
      survivorRestartAfterCleanupDestroy.start.exitCode === 0 &&
      ["Ready", "Running"].includes(survivorRestartAfterCleanupDestroy.phase);
    const gatewayADashboardAvailableAfterCleanupRestart =
      survivorDashboardAfterCleanupDestroy.gatewayPort.exitCode === 0 &&
      survivorDashboardAfterCleanupDestroy.scopedList.exitCode === 0 &&
      outputIncludesSandbox(survivorDashboardAfterCleanupDestroy.scopedList.stdout, SANDBOX_A) &&
      survivorDashboardAfterCleanupDestroy.dashboard.every(
        (probe) => probe.exitCode === 0 && /^[23][0-9]{2}$/.test(probe.stdout.trim()),
      );
    expect(
      sandboxARestartedWithCleanup && gatewayADashboardAvailableAfterCleanupRestart,
      `stop=${resultText(survivorRestartAfterCleanupDestroy.stop)}; start=${resultText(survivorRestartAfterCleanupDestroy.start)}; phase=${survivorRestartAfterCleanupDestroy.phase}; port=${resultText(survivorDashboardAfterCleanupDestroy.gatewayPort)}; list=${resultText(survivorDashboardAfterCleanupDestroy.scopedList)}; dashboard=${survivorDashboardAfterCleanupDestroy.dashboard.map(resultText).join("\\n")}`,
    ).toBe(true);

    await runOnboard(
      host,
      SANDBOX_B,
      GATEWAY_PORT_B,
      fake.baseUrl,
      "phase-3-reonboard-b-after-cleanup-destroy",
    );
    await waitForSandboxReady(
      sandbox,
      SANDBOX_B,
      gatewayB,
      "phase-3-sandbox-b-ready-after-cleanup-destroy",
    );
    progress.phase(
      "destroy alternate sandbox without gateway cleanup while restarting the survivor",
    );
    const gatewayASelectionBeforeRetainedDestroy = await selectAndVerifyActiveGateway(
      sandbox,
      gatewayA,
      SANDBOX_A,
      SANDBOX_B,
      "phase-3-select-gateway-a-before-retained-destroy",
    );
    const gatewayASelectedBeforeRetainedDestroy =
      gatewayASelectionBeforeRetainedDestroy.select.exitCode === 0 &&
      gatewayASelectionBeforeRetainedDestroy.containsOnlyTargetSandbox;
    expect(
      gatewayASelectedBeforeRetainedDestroy,
      `select=${resultText(gatewayASelectionBeforeRetainedDestroy.select)}; list=${resultText(gatewayASelectionBeforeRetainedDestroy.list)}`,
    ).toBe(true);
    const destroyBWithoutGatewayCleanup = await command(
      host,
      [SANDBOX_B, "destroy", "--yes", "--no-cleanup-gateway"],
      {
        artifactName: "phase-3-destroy-b-without-gateway-cleanup",
        env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
        timeoutMs: 5 * 60_000,
      },
    );
    const gatewayRegistryAfterRetainedDestroy = await sandbox.openshell(
      ["gateway", "list", "-o", "json"],
      {
        artifactName: "phase-3-gateway-registry-after-retained-destroy",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const gatewayBRetainedAfterDestroy = await host.command(
      "bash",
      ["-lc", `ss -ltn | grep -Eq '[:.]${GATEWAY_PORT_B}\\b'`],
      {
        artifactName: "phase-3-gateway-b-retained-after-destroy",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    const sandboxBAfterRetainedDestroy = await sandbox.openshell(
      ["sandbox", "list", "-g", gatewayB],
      {
        artifactName: "phase-3-sandbox-b-absent-after-retained-destroy",
        env: openshellEnvForGateway(gatewayB),
        timeoutMs: 30_000,
      },
    );
    const gatewayAProcessAfterRetainedDestroy = gatewayProcessEvidence(
      await captureGatewayEvidence(
        host,
        sandbox,
        [[gatewayA, GATEWAY_PORT_A]],
        "phase-3-after-retained-destroy",
      ),
      gatewayA,
    );
    const liveSurvivorAfterRetainedDestroy = await probeSurvivorDashboard(
      host,
      sandbox,
      gatewayA,
      GATEWAY_PORT_A,
      DASHBOARD_PORT_A,
      "phase-3-live-survivor-after-retained-destroy",
    );
    const sandboxBDestroyedWithoutGatewayCleanup =
      destroyBWithoutGatewayCleanup.exitCode === 0 &&
      sandboxBAfterRetainedDestroy.exitCode === 0 &&
      !outputIncludesSandbox(resultText(sandboxBAfterRetainedDestroy), SANDBOX_B);
    const gatewayBRetainedWithoutCleanup =
      gatewayBRetainedAfterDestroy.exitCode === 0 &&
      gatewayRegistryAfterRetainedDestroy.exitCode === 0 &&
      gatewayRegistryContains(gatewayRegistryAfterRetainedDestroy, gatewayB);
    const gatewayAProcessPreservedWithoutCleanup =
      gatewayAProcessAfterRetainedDestroy === gatewayAProcessBeforeCleanupDestroy;
    const gatewayAHealthyBeforeRetainedRestart =
      liveSurvivorAfterRetainedDestroy.gatewayPort.exitCode === 0 &&
      liveSurvivorAfterRetainedDestroy.scopedList.exitCode === 0 &&
      outputIncludesSandbox(liveSurvivorAfterRetainedDestroy.scopedList.stdout, SANDBOX_A) &&
      liveSurvivorAfterRetainedDestroy.dashboard.every(
        (probe) => probe.exitCode === 0 && /^[23][0-9]{2}$/.test(probe.stdout.trim()),
      );
    expect(
      gatewayASelectedBeforeRetainedDestroy &&
        sandboxBDestroyedWithoutGatewayCleanup &&
        gatewayBRetainedWithoutCleanup &&
        gatewayAProcessPreservedWithoutCleanup &&
        gatewayAHealthyBeforeRetainedRestart,
      `selected A=${resultText(gatewayASelectionBeforeRetainedDestroy.select)}; active list=${resultText(gatewayASelectionBeforeRetainedDestroy.list)}; destroy=${resultText(destroyBWithoutGatewayCleanup)}; gateway B=${resultText(gatewayBRetainedAfterDestroy)}; gateway registry=${resultText(gatewayRegistryAfterRetainedDestroy)}; sandbox B=${resultText(sandboxBAfterRetainedDestroy)}; gateway A=${gatewayAProcessAfterRetainedDestroy}; survivor port=${resultText(liveSurvivorAfterRetainedDestroy.gatewayPort)}; list=${resultText(liveSurvivorAfterRetainedDestroy.scopedList)}; dashboard=${liveSurvivorAfterRetainedDestroy.dashboard.map(resultText).join("\\n")}`,
    ).toBe(true);
    const survivorRestartAfterRetainedDestroy = await stopStartSurvivor(
      sandbox,
      SANDBOX_A,
      gatewayA,
      "phase-3-survivor-after-retained-destroy",
    );
    const survivorDashboardAfterRetainedDestroy = await probeSurvivorDashboard(
      host,
      sandbox,
      gatewayA,
      GATEWAY_PORT_A,
      DASHBOARD_PORT_A,
      "phase-3-survivor-after-retained-destroy",
      POST_UNINSTALL_HEALTH_PROBES,
    );
    const sandboxARestartedWithoutCleanup =
      survivorRestartAfterRetainedDestroy.stop.exitCode === 0 &&
      survivorRestartAfterRetainedDestroy.start.exitCode === 0 &&
      ["Ready", "Running"].includes(survivorRestartAfterRetainedDestroy.phase);
    const gatewayADashboardAvailableAfterRetainedRestart =
      survivorDashboardAfterRetainedDestroy.gatewayPort.exitCode === 0 &&
      survivorDashboardAfterRetainedDestroy.scopedList.exitCode === 0 &&
      outputIncludesSandbox(survivorDashboardAfterRetainedDestroy.scopedList.stdout, SANDBOX_A) &&
      survivorDashboardAfterRetainedDestroy.dashboard.every(
        (probe) => probe.exitCode === 0 && /^[23][0-9]{2}$/.test(probe.stdout.trim()),
      );
    expect(
      sandboxARestartedWithoutCleanup && gatewayADashboardAvailableAfterRetainedRestart,
      `stop=${resultText(survivorRestartAfterRetainedDestroy.stop)}; start=${resultText(survivorRestartAfterRetainedDestroy.start)}; phase=${survivorRestartAfterRetainedDestroy.phase}; port=${resultText(survivorDashboardAfterRetainedDestroy.gatewayPort)}; list=${resultText(survivorDashboardAfterRetainedDestroy.scopedList)}; dashboard=${survivorDashboardAfterRetainedDestroy.dashboard.map(resultText).join("\\n")}`,
    ).toBe(true);

    progress.phase("restore the alternate sandbox before uninstall");
    const onboardBAfterRetainedDestroy = await runOnboard(
      host,
      SANDBOX_B,
      GATEWAY_PORT_B,
      fake.baseUrl,
      "phase-3-reonboard-b-before-uninstall",
    );
    const phaseBAfterRetainedDestroy = await waitForSandboxReady(
      sandbox,
      SANDBOX_B,
      gatewayB,
      "phase-3-sandbox-b-ready-before-uninstall",
    );
    expect(
      onboardBAfterRetainedDestroy.exitCode === 0 &&
        ["Ready", "Running"].includes(phaseBAfterRetainedDestroy),
      `onboard=${resultText(onboardBAfterRetainedDestroy)}; phase=${phaseBAfterRetainedDestroy}`,
    ).toBe(true);

    progress.phase("uninstall one gateway without disrupting its sibling");
    const gatewayPair = [
      [gatewayA, GATEWAY_PORT_A],
      [gatewayB, GATEWAY_PORT_B],
    ] as const;
    const beforeEvidence = await captureGatewayEvidence(
      host,
      sandbox,
      gatewayPair,
      "phase-4-before-uninstall",
    );
    const processA = gatewayProcessEvidence(beforeEvidence, gatewayA);
    const processB = gatewayProcessEvidence(beforeEvidence, gatewayB);
    expect(
      Boolean(processA && processB && processA !== processB),
      `gateway A=${processA}; gateway B=${processB}`,
    ).toBe(true);

    const uninstallB = await command(host, ["uninstall", "--yes", "--destroy-user-data"], {
      artifactName: "phase-4-uninstall-gateway-b",
      env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
      timeoutMs: 5 * 60_000,
    });
    expect(uninstallB.exitCode, resultText(uninstallB)).toBe(0);

    const afterEvidence = await captureGatewayEvidence(
      host,
      sandbox,
      gatewayPair,
      "phase-4-after-uninstall",
    );
    const processAAfterUninstall = gatewayProcessEvidence(afterEvidence, gatewayA);
    const processBAfterUninstall = gatewayProcessEvidence(afterEvidence, gatewayB);
    expect(
      processAAfterUninstall === processA && processBAfterUninstall === undefined,
      `gateway A before=${processA}; after=${processAAfterUninstall}; gateway B after=${processBAfterUninstall}`,
    ).toBe(true);

    const survivorPhases: string[] = [];
    let listAAfterUninstallB: ShellProbeResult | undefined;
    for (let probe = 1; probe <= POST_UNINSTALL_HEALTH_PROBES; probe += 1) {
      survivorPhases.push(
        await waitForSandboxReady(
          sandbox,
          SANDBOX_A,
          gatewayA,
          `phase-4-survivor-probe-${String(probe)}`,
        ),
      );
      const gatewayPortProbe = await host.command(
        "bash",
        ["-lc", `ss -ltn | grep -Eq '[:.]${GATEWAY_PORT_A}\\b'`],
        {
          artifactName: `phase-4-survivor-port-${String(probe)}`,
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      const scopedList = await command(host, ["list"], {
        artifactName: `phase-4-survivor-list-${String(probe)}`,
        env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_A }),
        timeoutMs: 60_000,
      });
      const dashboardProbe = await host.command(
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
          `http://127.0.0.1:${DASHBOARD_PORT_A}/`,
        ],
        {
          artifactName: `phase-4-survivor-dashboard-${String(probe)}`,
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      listAAfterUninstallB = scopedList;
      expect(
        gatewayPortProbe.exitCode === 0 &&
          scopedList.exitCode === 0 &&
          outputIncludesSandbox(scopedList.stdout, SANDBOX_A) &&
          dashboardProbe.exitCode === 0 &&
          /^[23][0-9]{2}$/.test(dashboardProbe.stdout.trim()),
        `port=${resultText(gatewayPortProbe)}; list=${resultText(scopedList)}; dashboard=${resultText(dashboardProbe)}`,
      ).toBe(true);
      await (probe < POST_UNINSTALL_HEALTH_PROBES ? sleep(PROBE_DELAY_MS) : Promise.resolve());
    }
    await expectPortNotListening(host, GATEWAY_PORT_B, "phase-4-gateway-port-b-stopped");

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

    progress.phase("whole-host uninstall omits the absent default gateway");
    const uninstallAll = await command(
      host,
      ["uninstall", "--all-gateway-ports", "--yes", "--destroy-user-data"],
      {
        artifactName: "phase-5-whole-host-uninstall",
        env: commandEnv(),
        timeoutMs: 5 * 60_000,
      },
    );
    const uninstallAllOutput = resultText(uninstallAll);
    const remainingStateRemoved = await host.command(
      "bash",
      ["-lc", `test ! -e "$HOME/.nemoclaw/gateways/${GATEWAY_PORT_A}"`],
      {
        artifactName: "phase-5-gateway-a-state-removed",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(
      uninstallAll.exitCode === 0 &&
        !/gateway 'nemoclaw' on port 8080/u.test(uninstallAllOutput) &&
        remainingStateRemoved.exitCode === 0,
      `uninstall=${uninstallAllOutput}; remaining state=${resultText(remainingStateRemoved)}`,
    ).toBe(true);

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
        siblingGatewayImagePreservedByGc: siblingImagePreserved,
        gcRemovedOnlyOrphanTag: orphanTagAbsent,
        dashboardPortsDistinct: Boolean(dashboardA && dashboardB && dashboardA !== dashboardB),
        gatewayASelectedBeforeCleanupDestroy: gatewayASelectedBeforeCleanupDestroy,
        gatewayBDestroyedWithCleanup: gatewayBDestroyedWithCleanup,
        gatewayAProcessPreservedWithCleanup: gatewayAProcessPreservedWithCleanup,
        gatewayAHealthyBeforeCleanupRestart: gatewayAHealthyBeforeCleanupRestart,
        sandboxARestartedWithCleanup: sandboxARestartedWithCleanup,
        gatewayADashboardAvailableAfterCleanupRestart:
          gatewayADashboardAvailableAfterCleanupRestart,
        gatewayASelectedBeforeRetainedDestroy: gatewayASelectedBeforeRetainedDestroy,
        sandboxBDestroyedWithoutGatewayCleanup: sandboxBDestroyedWithoutGatewayCleanup,
        gatewayBRetainedWithoutCleanup: gatewayBRetainedWithoutCleanup,
        gatewayAProcessPreservedWithoutCleanup: gatewayAProcessPreservedWithoutCleanup,
        gatewayAHealthyBeforeRetainedRestart: gatewayAHealthyBeforeRetainedRestart,
        sandboxARestartedWithoutCleanup: sandboxARestartedWithoutCleanup,
        gatewayADashboardAvailableAfterRetainedRestart:
          gatewayADashboardAvailableAfterRetainedRestart,
        gatewayBUninstalled: uninstallB.exitCode === 0 && scopedStateRemoved.exitCode === 0,
        sandboxAPreservedAfterUninstallB:
          survivorPhases.length === POST_UNINSTALL_HEALTH_PROBES &&
          survivorPhases.every((phase) => phase === "Ready" || phase === "Running"),
        sharedCliPreserved: listAAfterUninstallB?.exitCode === 0,
        wholeHostUninstallPassed: uninstallAll.exitCode === 0,
        absentDefaultGatewayOmitted: !/gateway 'nemoclaw' on port 8080/u.test(uninstallAllOutput),
        remainingGatewayStateRemoved: remainingStateRemoved.exitCode === 0,
      },
    });
  },
);
