// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "../../adapters/openshell/client";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { captureOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { GATEWAY_PORT } from "../../core/ports";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "../../gateway-runtime-action";
import { parseGatewayInference } from "../../inference/config";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import { ROOT } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { runSandboxAutoPairApprovalPass, wrapSandboxShellScript } from "./auto-pair-approval";
import { buildConfigPermsCheck } from "./doctor-config-perms";
import { captureHostCommand } from "./doctor-host-command";
import { collectInferenceChecks, type DoctorInferenceRoute } from "./doctor-inference";
import { collectMessagingDoctorChecks } from "./doctor-messaging";
import {
  buildDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  renderDoctorReport,
} from "./doctor-report";
import {
  cloudflaredDoctorCheck,
  dockerInspectGateway,
  findSandboxListLine,
  inferSandboxReadyFromLine,
  ollamaDoctorCheck,
  oneLine,
  shouldInspectLegacyGatewayContainer,
} from "./doctor-system-checks";
import { buildToolScopeChecks } from "./doctor-tool-scope";

export type { DoctorCheck, DoctorReport } from "./doctor-report";

type RunSandboxDoctorOptions = {
  quietJson?: boolean;
};

type DoctorIntent = {
  asJson: boolean;
  wantsFix: boolean;
};

type GatewayProbe = {
  checks: DoctorCheck[];
  connected: boolean;
};

type SandboxProbe = {
  checks: DoctorCheck[];
  reachable: boolean;
};

function parseDoctorIntent(sandboxName: string, args: string[]): DoctorIntent | null {
  const asJson = args.includes("--json");
  const wantsFix = args.includes("--fix");
  const helpRequested = args.includes("--help") || args.includes("-h");
  const unknown = args.filter((arg) => !["--json", "--fix", "--help", "-h"].includes(arg));
  if (helpRequested) {
    console.log(`  Usage: ${CLI_NAME} <name> doctor [--json] [--fix]`);
    console.log(
      `  --fix   Restore the mutable OpenClaw config permission contract if it was tightened,`,
    );
    console.log(`          and approve pending allowlisted dashboard/CLI tool-scope upgrades`);
    return null;
  }
  if (unknown.length > 0) {
    console.error(
      `  Unknown doctor argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}`,
    );
    console.error(`  Usage: ${CLI_NAME} <name> doctor [--json] [--fix]`);
    process.exit(1);
  }
  // `--fix` mutates sandbox permissions; `--json` is the machine-readable
  // readiness-gate path. Refuse the combination so automation consuming JSON
  // can never trigger a silent repair (the JSON report has no dedicated
  // repair-intent field). Run `doctor --json` to detect, then `doctor --fix`
  // to repair.
  if (wantsFix && asJson) {
    console.error(`  ${CLI_NAME} doctor: --fix cannot be combined with --json`);
    console.error(
      `  Run \`${CLI_NAME} ${sandboxName} doctor --json\` to detect, then \`${CLI_NAME} ${sandboxName} doctor --fix\` to repair`,
    );
    process.exit(1);
  }
  return { asJson, wantsFix };
}

function cliBuildCheck(): DoctorCheck {
  const exists = fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js"));
  return {
    group: "Host",
    label: "CLI build",
    status: exists ? "ok" : "fail",
    detail: exists ? "dist/nemoclaw.js present" : "dist/nemoclaw.js missing",
    hint: exists ? undefined : "run `npm run build:cli`",
  };
}

function collectHostChecks(): {
  checks: DoctorCheck[];
  openshellBin: ReturnType<typeof resolveOpenshell>;
} {
  const cli = cliBuildCheck();
  const dockerInfo = captureHostCommand("docker", ["info", "--format", "{{.ServerVersion}}"], 8000);
  const openshellBin = resolveOpenshell();
  return {
    checks: [
      cli,
      {
        group: "Host",
        label: "Docker daemon",
        status: dockerInfo.status === 0 ? "ok" : "fail",
        detail:
          dockerInfo.status === 0
            ? `server ${dockerInfo.stdout.trim() || "unknown"}`
            : oneLine(dockerInfo.stderr || dockerInfo.error?.message || "docker info failed"),
        hint:
          dockerInfo.status === 0
            ? undefined
            : "start Docker and verify your user can access the daemon",
      },
      {
        group: "Host",
        label: "OpenShell CLI",
        status: openshellBin ? "ok" : "fail",
        detail: openshellBin || "not found on PATH",
        hint: openshellBin ? undefined : "install OpenShell before using sandbox commands",
      },
    ],
    openshellBin,
  };
}

async function collectGatewayChecks(
  gatewayName: string,
  sb: SandboxEntry | null | undefined,
  openshellBin: ReturnType<typeof resolveOpenshell>,
  recoverGateway: boolean,
): Promise<GatewayProbe> {
  const checks: DoctorCheck[] = [];
  const gateway = openshellBin
    ? await probeOpenShellGateway(gatewayName, recoverGateway)
    : { check: null, connected: false };
  if (gateway.check) checks.push(gateway.check);
  if (shouldInspectLegacyGatewayContainer(sb)) {
    checks.push(
      ...dockerInspectGateway(
        `openshell-cluster-${gatewayName}`,
        {
          namedGatewayConnected: gateway.connected,
          gatewayName,
        },
        sb?.gatewayPort ?? GATEWAY_PORT,
      ),
    );
  }
  return { checks, connected: gateway.connected };
}

async function gatewayLifecycle(gatewayName: string, recoverGateway: boolean) {
  if (!recoverGateway) return getNamedGatewayLifecycleState(gatewayName);
  const recovery = await recoverNamedGatewayRuntime({ gatewayName });
  return recovery.after || recovery.before;
}

async function probeOpenShellGateway(
  gatewayName: string,
  recoverGateway: boolean,
): Promise<{
  check: DoctorCheck;
  connected: boolean;
}> {
  const lifecycle = await gatewayLifecycle(gatewayName, recoverGateway);
  const cleanStatus = stripAnsi(lifecycle?.status || "");
  const connected = lifecycle?.state === "healthy_named";
  return {
    connected,
    check: {
      group: "Gateway",
      label: "OpenShell status",
      status: connected ? "ok" : "fail",
      detail: connected
        ? `connected to ${gatewayName}`
        : oneLine(cleanStatus || lifecycle?.gatewayInfo || `not connected to ${gatewayName}`),
      hint: connected ? undefined : `run \`openshell gateway select ${gatewayName}\` and retry`,
    },
  };
}

function liveSandboxDetail(
  sandboxName: string,
  present: boolean,
  ready: boolean | null,
  line: string | null,
): string {
  if (!present) return `${sandboxName} not present in live OpenShell sandbox list`;
  if (ready) return `${sandboxName} present (Ready)`;
  return `${sandboxName} present${line ? ` (${oneLine(line)})` : ""}`;
}

function liveSandboxHint(
  sandboxName: string,
  present: boolean,
  ready: boolean | null,
): string | undefined {
  if (!present) {
    return `run \`${CLI_NAME} ${sandboxName} status\` or recreate with \`${CLI_NAME} onboard\``;
  }
  if (ready) return undefined;
  return `run \`${CLI_NAME} ${sandboxName} status\` or \`${CLI_NAME} ${sandboxName} logs --follow\``;
}

function liveSandboxCheck(sandboxName: string): SandboxProbe {
  const list = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const liveNames = parseLiveSandboxNames(list.output || "");
  const present = list.status === 0 && liveNames.has(sandboxName);
  const line = findSandboxListLine(list.output || "", sandboxName);
  const ready = inferSandboxReadyFromLine(line);
  const reachable = present && ready === true;
  return {
    reachable,
    checks: [
      {
        group: "Sandbox",
        label: "Live sandbox",
        status: reachable ? "ok" : "fail",
        detail: liveSandboxDetail(sandboxName, present, ready, line),
        hint: liveSandboxHint(sandboxName, present, ready),
      },
    ],
  };
}

function collectSandboxReadinessChecks(
  sandboxName: string,
  openshellBin: ReturnType<typeof resolveOpenshell>,
  openshellConnected: boolean,
): SandboxProbe {
  if (openshellBin && openshellConnected) return liveSandboxCheck(sandboxName);
  if (!openshellBin) return { checks: [], reachable: false };
  return {
    reachable: false,
    checks: [
      {
        group: "Sandbox",
        label: "Live sandbox",
        status: "fail",
        detail: "skipped because the nemoclaw gateway is not connected",
        hint: "fix the gateway check above before trusting sandbox readiness",
      },
    ],
  };
}

function resolveInferenceRoute(
  sb: SandboxEntry | null | undefined,
  openshellBin: ReturnType<typeof resolveOpenshell>,
  openshellConnected: boolean,
): DoctorInferenceRoute {
  const live =
    openshellBin && openshellConnected
      ? parseGatewayInference(
          captureOpenshell(["inference", "get"], {
            ignoreError: true,
            timeout: OPENSHELL_PROBE_TIMEOUT_MS,
          }).output,
        )
      : null;
  return {
    model: live?.model || sb?.model || "unknown",
    provider: live?.provider || sb?.provider || "unknown",
  };
}

function agentVersionDoctorCheck(sandboxName: string): DoctorCheck {
  try {
    const version = sandboxVersion.checkAgentVersion(sandboxName);
    const agentName = agentRuntime.getAgentDisplayName(agentRuntime.getSessionAgent(sandboxName));
    if (version.isStale) {
      return {
        group: "Sandbox",
        label: "Agent version",
        status: "warn",
        detail: `${agentName} v${version.sandboxVersion || "unknown"}; v${version.expectedVersion} available`,
        hint: `run \`${CLI_NAME} ${sandboxName} rebuild\``,
      };
    }
    if (version.sandboxVersion) {
      return {
        group: "Sandbox",
        label: "Agent version",
        status: "ok",
        detail: `${agentName} v${version.sandboxVersion}`,
      };
    }
    return {
      group: "Sandbox",
      label: "Agent version",
      status: "info",
      detail: "could not detect version",
    };
  } catch {
    return {
      group: "Sandbox",
      label: "Agent version",
      status: "info",
      detail: "version check unavailable",
    };
  }
}

function shieldsDoctorCheck(sandboxName: string): DoctorCheck {
  const posture = shields.getShieldsPosture(sandboxName, false);
  const status: DoctorStatus =
    posture.mode === "locked"
      ? "ok"
      : posture.mode === "temporarily_unlocked" || posture.mode === "error"
        ? "warn"
        : "info";
  const hint =
    posture.mode === "mutable_default"
      ? `run \`${CLI_NAME} ${sandboxName} shields up\` to opt into lockdown`
      : posture.mode === "locked"
        ? undefined
        : `run \`${CLI_NAME} ${sandboxName} shields status\` for details`;
  return {
    group: "Sandbox",
    label: "Shields",
    status,
    detail: posture.detail,
    hint,
  };
}

function collectRegisteredSandboxChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  wantsFix: boolean,
  sandboxReachable: boolean,
): DoctorCheck[] {
  if (!sb) return [];
  const checks = [agentVersionDoctorCheck(sandboxName), shieldsDoctorCheck(sandboxName)];
  const permsCheck = buildConfigPermsCheck(sandboxName, wantsFix, {
    inspect: shields.inspectMutableConfigPerms,
    repair: shields.repairMutableConfigPerms,
    cliName: CLI_NAME,
  });
  if (permsCheck) checks.push(permsCheck);
  checks.push(...collectMessagingDoctorChecks(sandboxName, sb, sandboxReachable));
  return checks;
}

function collectToolScopeChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  sandboxReachable: boolean,
  wantsFix: boolean,
): DoctorCheck[] {
  if (!sb || !sandboxReachable || (sb.agent ?? "openclaw") !== "openclaw") return [];
  return buildToolScopeChecks(sandboxName, CLI_NAME, wantsFix, {
    exec: (name, script) =>
      executeSandboxCommandForVerification(name, wrapSandboxShellScript(script)),
    runApprovalPass: (name) => {
      const result = runSandboxAutoPairApprovalPass(name, { capture: true });
      return { reported: result.reported, approved: result.approved };
    },
  });
}

async function collectDoctorChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  gatewayName: string,
  intent: DoctorIntent,
): Promise<DoctorCheck[]> {
  const host = collectHostChecks();
  const gateway = await collectGatewayChecks(gatewayName, sb, host.openshellBin, !intent.asJson);
  const sandbox = collectSandboxReadinessChecks(sandboxName, host.openshellBin, gateway.connected);
  const route = resolveInferenceRoute(sb, host.openshellBin, gateway.connected);
  return [
    ...host.checks,
    ...gateway.checks,
    ...sandbox.checks,
    ...(await collectInferenceChecks(sandboxName, route, sandbox.reachable)),
    ...collectRegisteredSandboxChecks(sandboxName, sb, intent.wantsFix, sandbox.reachable),
    ...collectToolScopeChecks(sandboxName, sb, sandbox.reachable, intent.wantsFix),
    ollamaDoctorCheck(route.provider),
    cloudflaredDoctorCheck(sandboxName),
  ];
}

export async function runSandboxDoctor(
  sandboxName: string,
  args: string[] = [],
  options: RunSandboxDoctorOptions = {},
): Promise<DoctorReport | undefined> {
  const intent = parseDoctorIntent(sandboxName, args);
  if (!intent) return undefined;

  const sb = registry.getSandbox(sandboxName);
  const gatewayName = sb ? resolveSandboxGatewayName(sb) : resolveGatewayName(GATEWAY_PORT);
  const checks = await collectDoctorChecks(sandboxName, sb, gatewayName, intent);
  const report = buildDoctorReport(sandboxName, checks);
  if (intent.asJson && options.quietJson) return report;

  const exitCode = renderDoctorReport(report, intent.asJson);
  if (exitCode !== 0) process.exit(exitCode);
  return undefined;
}
