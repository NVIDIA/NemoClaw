// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  createCliOpenShellSandboxObserver,
  stripOpenShellCliAnsi,
} from "../../adapters/openshell/sandbox-observer-cli";
import {
  namedOpenShellGateway,
  type OpenShellSandboxError,
} from "../../adapters/openshell/sandbox-observer";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { captureOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { getAgentRuntimeKind, loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { GATEWAY_PORT } from "../../core/ports";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "../../gateway-runtime-action";
import { parseGatewayInference } from "../../inference/config";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundle,
  resolveCurrentRuntimeProviderBundle,
} from "../../onboard/runtime-provider/access";
import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import { getBaselineExclusionRuntimeStatus } from "../../policy";
import {
  BASELINE_EXCLUSION_SUPPORT_IMPACT,
  type BaselineExclusionRuntimeStatus,
} from "../../policy/baseline-exclusion";
import { ROOT } from "../../runner";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { runSandboxAutoPairApprovalPass } from "./auto-pair-approval";
import { buildConfigPermsCheck } from "./doctor-config-perms";
import {
  collectInferenceChecks,
  collectManagedLlamaCppDoctorChecks,
  type DoctorInferenceRoute,
  resolveDoctorReasoningEffort,
} from "./doctor-inference";
import {
  buildLifecycleRegistrationCheck,
  buildPortableRuntimeCheck,
} from "./doctor-lifecycle-registration";
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
  inspectSandboxDoctorPortableAuthority,
  ollamaDoctorCheck,
  oneLine,
  shouldInspectLegacyGatewayContainer,
  withSandboxDoctorLifecycleLock,
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

function hermesPortableDoctorReport(
  sandboxName: string,
  phase: "pending" | "configuring" | "active",
): DoctorReport {
  const active = phase === "active";
  return buildDoctorReport(sandboxName, [
    {
      group: "Sandbox",
      label: "Portable lifecycle",
      status: active ? "ok" : "warn",
      detail: `agent=Hermes; phase=${phase}`,
      ...(active ? {} : { hint: "resume the existing Hermes portable onboarding transaction" }),
    },
  ]);
}

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

function inspectRuntimeHost(sb: SandboxEntry | null | undefined): DoctorCheck {
  const portable = sb ? buildPortableRuntimeCheck(sb.name) : null;
  if (portable) return portable;
  const recorded = sb?.openshellDriver?.trim();
  const provider = recorded
    ? requireRuntimeProviderBundle(recorded, CURRENT_RUNTIME_PROVIDER_BUNDLES)
    : resolveCurrentRuntimeProviderBundle();
  return provider.preflightDoctor.inspectHost();
}

function runtimeHostCheck(sb: SandboxEntry | null | undefined): DoctorCheck {
  try {
    return inspectRuntimeHost(sb);
  } catch (error) {
    const detail =
      error instanceof RuntimeProviderSelectionError
        ? error.message
        : `Runtime provider inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      group: "Host",
      label: "Runtime provider",
      status: "fail",
      detail,
      hint: "restore a supported durable runtime provider identity before retrying",
    };
  }
}

function collectHostChecks(sb: SandboxEntry | null | undefined): {
  checks: DoctorCheck[];
  openshellBin: ReturnType<typeof resolveOpenshell>;
} {
  const cli = cliBuildCheck();
  const openshellBin = resolveOpenshell();
  return {
    checks: [
      cli,
      runtimeHostCheck(sb),
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
  const cleanStatus = stripOpenShellCliAnsi(lifecycle?.status || "");
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
  phase: string | null,
): string {
  if (!present) return `${sandboxName} not present in live OpenShell sandbox list`;
  if (ready) return `${sandboxName} present (Ready)`;
  return `${sandboxName} present${phase ? ` (${oneLine(phase)})` : ""}`;
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

function liveSandboxObservationFailureHint(
  sandboxName: string,
  gatewayName: string,
  error: OpenShellSandboxError,
): string {
  switch (error.kind) {
    case "authentication":
      return `restore OpenShell authentication for gateway '${gatewayName}', then retry`;
    case "transport":
      return error.reason === "identity_mismatch"
        ? `run \`${CLI_NAME} ${sandboxName} status\` to inspect the recorded gateway identity, then retry`
        : `run \`openshell status\`, restore gateway '${gatewayName}', then retry`;
    case "schema":
      return "use matching supported OpenShell CLI and gateway versions, then retry";
    case "timeout":
      return `check that gateway '${gatewayName}' responds, then retry`;
    case "command":
      return `run \`openshell sandbox list -g ${gatewayName}\` and correct the reported command failure`;
  }
}

async function liveSandboxCheck(sandboxName: string, gatewayName: string): Promise<SandboxProbe> {
  const list = await createCliOpenShellSandboxObserver({
    capture: captureOpenshell,
    defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
  }).listSandboxes({
    target: namedOpenShellGateway(gatewayName),
    timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (!list.ok) {
    return {
      reachable: false,
      checks: [
        {
          group: "Sandbox",
          label: "Live sandbox",
          status: "fail",
          detail: `OpenShell sandbox observation failed: ${oneLine(list.error.message)}`,
          hint: liveSandboxObservationFailureHint(sandboxName, gatewayName, list.error),
        },
      ],
    };
  }
  const observed = list.value.sandboxes.find((sandbox) => sandbox.name === sandboxName) ?? null;
  const present = observed !== null;
  const ready = observed ? observed.readiness === "ready" : null;
  const reachable = present && ready === true;
  return {
    reachable,
    checks: [
      {
        group: "Sandbox",
        label: "Live sandbox",
        status: reachable ? "ok" : "fail",
        detail: liveSandboxDetail(sandboxName, present, ready, observed?.phase ?? null),
        hint: liveSandboxHint(sandboxName, present, ready),
      },
    ],
  };
}

async function collectSandboxReadinessChecks(
  sandboxName: string,
  gatewayName: string | null,
  openshellBin: ReturnType<typeof resolveOpenshell>,
  openshellConnected: boolean,
): Promise<SandboxProbe> {
  if (gatewayName && openshellBin && openshellConnected) {
    return liveSandboxCheck(sandboxName, gatewayName);
  }
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
    effectiveReasoningEffort: resolveDoctorReasoningEffort(sb),
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

function baselineExclusionCheckFields(
  sandboxName: string,
  key: string,
  runtimeStatus: BaselineExclusionRuntimeStatus,
): Pick<DoctorCheck, "status" | "detail" | "hint"> {
  const restoreCommand = `${CLI_NAME} ${sandboxName} policy restore ${key}`;
  if (runtimeStatus === "excluded") {
    return {
      status: "info",
      detail: `Baseline entry '${key}' excluded. ${BASELINE_EXCLUSION_SUPPORT_IMPACT}`,
      hint: `restore with \`${restoreCommand}\``,
    };
  }
  if (runtimeStatus === "no-longer-in-baseline") {
    return {
      status: "warn",
      detail: `Baseline entry '${key}' no longer exists; rebuild fails closed until the stale exclusion is cleared.`,
      hint: `key no longer exists in the baseline; run \`${restoreCommand}\` to clear the stale record`,
    };
  }
  if (runtimeStatus === "agent-changed") {
    return {
      status: "warn",
      detail: `Baseline exclusion '${key}' belongs to a different agent; rebuild fails closed until the stale approval is cleared.`,
      hint: `run \`${restoreCommand}\`, then review and approve the current agent baseline if needed`,
    };
  }
  if (runtimeStatus === "baseline-unreadable") {
    return {
      status: "warn",
      detail: "Current agent baseline is unreadable; exclusion scope could not be verified.",
      hint: `inspect \`${CLI_NAME} ${sandboxName} policy list\` before rebuilding`,
    };
  }
  if (runtimeStatus === "live-policy-unreadable") {
    return {
      status: "warn",
      detail: `Live policy for '${key}' is unreadable; exclusion enforcement could not be verified.`,
      hint: `restore gateway access, then rerun \`${CLI_NAME} ${sandboxName} doctor\``,
    };
  }
  if (runtimeStatus === "live-policy-mismatch") {
    return {
      status: "fail",
      detail: `Live policy still contains excluded baseline entry '${key}'; the recorded exclusion is not enforced.`,
      hint: `inspect \`${CLI_NAME} ${sandboxName} policy list\`, remove the colliding source, then re-run the exclusion`,
    };
  }
  return {
    status: "warn",
    detail: `Baseline entry '${key}' changed since exclusion was approved; rebuild fails closed until re-approved.`,
    hint: `run \`${restoreCommand}\`, review with \`${CLI_NAME} ${sandboxName} policy exclude ${key} --dry-run\`, then re-approve`,
  };
}

function baselineExclusionDoctorChecks(sandboxName: string): DoctorCheck[] {
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  const checks: DoctorCheck[] = [];
  for (const exclusion of registry.getBaselineExclusions(sandboxName)) {
    if (transition?.exclusion.key === exclusion.key) continue;
    const runtimeStatus = getBaselineExclusionRuntimeStatus(sandboxName, exclusion);
    checks.push({
      group: "Sandbox",
      label: `Baseline exclusion: ${exclusion.key}`,
      ...baselineExclusionCheckFields(sandboxName, exclusion.key, runtimeStatus),
    });
  }
  if (transition) {
    const key = transition.exclusion.key;
    checks.push({
      group: "Sandbox",
      label: `Baseline exclusion: ${key}`,
      status: "warn",
      detail: `Baseline policy ${transition.operation} for '${key}' was interrupted; rebuild is blocked until live and durable state are reconciled.`,
      hint: `re-run \`${CLI_NAME} ${sandboxName} policy ${transition.operation} ${key}\``,
    });
  }
  return checks;
}

function collectRegisteredSandboxChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  wantsFix: boolean,
  sandboxReachable: boolean,
): DoctorCheck[] {
  if (!sb) return [];
  const checks = [agentVersionDoctorCheck(sandboxName), shieldsDoctorCheck(sandboxName)];
  let dashboardPortRequired = true;
  try {
    dashboardPortRequired = shouldManageDashboardForAgent(loadAgent(sb.agent || "openclaw"));
  } catch {
    // Require dashboard metadata when the agent definition cannot be loaded.
  }
  checks.push(
    buildLifecycleRegistrationCheck(sandboxName, sb, CLI_NAME, { dashboardPortRequired }),
  );
  const permsCheck = buildConfigPermsCheck(sandboxName, wantsFix, {
    inspect: shields.inspectMutableConfigPerms,
    repair: shields.repairMutableConfigPerms,
    cliName: CLI_NAME,
  });
  if (permsCheck) checks.push(permsCheck);
  checks.push(...collectMessagingDoctorChecks(sandboxName, sb, sandboxReachable));
  checks.push(...baselineExclusionDoctorChecks(sandboxName));
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
    exec: (name, script) => executeSandboxCommandForVerification(name, script),
    runApprovalPass: (name) => {
      const result = runSandboxAutoPairApprovalPass(name, { capture: true });
      return { reported: result.reported, approved: result.approved };
    },
  });
}

function shouldReportServingProcessHealth(agentName: string | null | undefined): boolean {
  const resolvedName = agentName || "openclaw";
  try {
    return getAgentRuntimeKind(loadAgent(resolvedName)) === "gateway";
  } catch {
    // Status preserves OpenClaw's gateway default if its manifest cannot be
    // loaded, while unknown non-default agents are classified as unknown.
    return resolvedName === "openclaw";
  }
}

async function collectDoctorChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  gatewayName: string | null,
  intent: DoctorIntent,
): Promise<DoctorCheck[]> {
  const host = collectHostChecks(sb);
  const gateway: GatewayProbe = gatewayName
    ? await collectGatewayChecks(gatewayName, sb, host.openshellBin, !intent.asJson)
    : {
        connected: false,
        checks: [
          {
            group: "Gateway",
            label: "Registered gateway binding",
            status: "fail",
            detail: "skipped because the registered gateway binding is invalid",
            hint: `re-register or re-onboard '${sandboxName}' before running lifecycle commands`,
          },
        ],
      };
  const sandbox = await collectSandboxReadinessChecks(
    sandboxName,
    gatewayName,
    host.openshellBin,
    gateway.connected,
  );
  const route = resolveInferenceRoute(sb, host.openshellBin, gateway.connected);
  return [
    ...host.checks,
    ...gateway.checks,
    ...sandbox.checks,
    ...(await collectInferenceChecks(sandboxName, route, sandbox.reachable, {
      includeServingProcessCheck: shouldReportServingProcessHealth(sb?.agent),
    })),
    ...collectRegisteredSandboxChecks(sandboxName, sb, intent.wantsFix, sandbox.reachable),
    ...collectToolScopeChecks(sandboxName, sb, sandbox.reachable, intent.wantsFix),
    ...collectManagedLlamaCppDoctorChecks(sandboxName, sb?.gatewayPort),
    ollamaDoctorCheck(route.provider),
    cloudflaredDoctorCheck(sandboxName),
  ];
}

function resolveDoctorGatewayName(sb: SandboxEntry | null | undefined): string | null {
  if (!sb) return resolveGatewayName(GATEWAY_PORT);
  try {
    return resolveSandboxGatewayName(sb);
  } catch {
    return null;
  }
}

export async function runSandboxDoctor(
  sandboxName: string,
  args: string[] = [],
  options: RunSandboxDoctorOptions = {},
): Promise<DoctorReport | undefined> {
  const intent = parseDoctorIntent(sandboxName, args);
  if (!intent) return undefined;

  const outcome = await withSandboxDoctorLifecycleLock(sandboxName, async () => {
    const portable = inspectSandboxDoctorPortableAuthority(sandboxName, registry.getSandbox);
    if (portable.kind === "hermes") {
      const report = hermesPortableDoctorReport(sandboxName, portable.phase);
      if (intent.asJson && options.quietJson) return { report };
      const exitCode = renderDoctorReport(report, intent.asJson);
      return { exitCode };
    }

    const sb = registry.getSandbox(sandboxName);
    const gatewayName = resolveDoctorGatewayName(sb);
    const checks = await collectDoctorChecks(sandboxName, sb, gatewayName, intent);
    const report = buildDoctorReport(sandboxName, checks);
    if (intent.asJson && options.quietJson) return { report };

    const exitCode = renderDoctorReport(report, intent.asJson);
    return { exitCode };
  });
  if (outcome.exitCode && outcome.exitCode !== 0) process.exit(outcome.exitCode);
  return outcome.report;
}
