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
import { buildGatewayInferenceGetArgs, parseGatewayInference } from "../../inference/config";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundle,
  resolveCurrentRuntimeProviderBundle,
} from "../../onboard/runtime-provider/access";
import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import { ROOT } from "../../runner";
import * as sandboxVersion from "../../sandbox/version";
import {
  inspectMutableConfigPerms,
  repairMutableConfigPerms,
} from "../../sandbox/mutable-config-perms";
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
  buildGlobalDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type GlobalDoctorReport,
  renderDoctorReport,
} from "./doctor-report";
import {
  cloudflaredDoctorCheck,
  dockerInspectGateway,
  gatewayDoctorStartHint,
  inspectSandboxDoctorPortableAuthority,
  ollamaDoctorCheck,
  oneLine,
  shouldInspectLegacyGatewayContainer,
  withSandboxDoctorLifecycleLock,
} from "./doctor-system-checks";
import { buildToolScopeChecks } from "./doctor-tool-scope";

export type { DoctorCheck, DoctorReport } from "./doctor-report";
export { redactDoctorReport } from "./doctor-report";

type RunSandboxDoctorOptions = {
  quietJson?: boolean;
};

type DoctorIntent = {
  asJson: boolean;
  wantsFix: boolean;
};

type DoctorHostProbe = {
  checks: DoctorCheck[];
  openshellBin: string | null;
};

type DoctorGatewayProbe = {
  checks: DoctorCheck[];
  connected: boolean;
};

type DoctorGatewayProbeOptions = {
  gatewayPort: number;
  ignoreProbeErrors?: boolean;
  recoverGateway: boolean;
  unavailableHint?: string;
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

function collectDoctorHostChecks(sb: SandboxEntry | null | undefined): DoctorHostProbe {
  const openshellBin = resolveOpenshell();
  return {
    checks: [
      cliBuildCheck(),
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

async function gatewayLifecycle(gatewayName: string, options: DoctorGatewayProbeOptions) {
  if (!options.recoverGateway) {
    return options.ignoreProbeErrors === undefined
      ? getNamedGatewayLifecycleState(gatewayName)
      : getNamedGatewayLifecycleState(gatewayName, {
          ignoreProbeErrors: options.ignoreProbeErrors,
        });
  }
  const recovery = await recoverNamedGatewayRuntime({ gatewayName });
  return recovery.after || recovery.before;
}

async function probeOpenShellGateway(
  gatewayName: string,
  options: DoctorGatewayProbeOptions,
): Promise<{ check: DoctorCheck; connected: boolean }> {
  const lifecycle = await gatewayLifecycle(gatewayName, options);
  const cleanStatus = oneLine(stripOpenShellCliAnsi(lifecycle?.status || ""));
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
      hint: connected
        ? undefined
        : lifecycle?.state === "connected_other" || !options.unavailableHint
          ? `run \`openshell gateway select ${gatewayName}\` and retry`
          : options.unavailableHint,
    },
  };
}

async function collectDoctorGatewayChecks(
  gatewayName: string,
  sb: SandboxEntry | null | undefined,
  openshellBin: string | null,
  options: DoctorGatewayProbeOptions,
): Promise<DoctorGatewayProbe> {
  const checks: DoctorCheck[] = sb
    ? [
        {
          group: "Gateway",
          label: "Registered gateway binding",
          status: "ok",
          detail: `resolved to '${gatewayName}'`,
        },
      ]
    : [];
  const gateway = openshellBin
    ? await probeOpenShellGateway(gatewayName, options)
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
        sb?.gatewayPort ?? options.gatewayPort,
      ),
    );
  }
  return { checks, connected: gateway.connected };
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
  openshellBin: string | null,
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
  openshellBin: string | null,
  openshellConnected: boolean,
  gatewayName: string | null,
): DoctorInferenceRoute {
  const live =
    openshellBin && openshellConnected && gatewayName
      ? parseGatewayInference(
          captureOpenshell(buildGatewayInferenceGetArgs(gatewayName), {
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

function collectRegisteredSandboxChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  wantsFix: boolean,
  sandboxReachable: boolean,
): DoctorCheck[] {
  if (!sb) return [];
  const checks = [agentVersionDoctorCheck(sandboxName)];
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
    inspect: inspectMutableConfigPerms,
    repair: repairMutableConfigPerms,
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
  const host = collectDoctorHostChecks(sb);
  const gateway: DoctorGatewayProbe = gatewayName
    ? await collectDoctorGatewayChecks(gatewayName, sb, host.openshellBin, {
        gatewayPort: sb?.gatewayPort ?? GATEWAY_PORT,
        recoverGateway: !intent.asJson,
      })
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
  const route = resolveInferenceRoute(sb, host.openshellBin, gateway.connected, gatewayName);
  return [
    ...host.checks,
    ...gateway.checks,
    ...sandbox.checks,
    ...(await collectInferenceChecks(sandboxName, route, sandbox.reachable, {
      gatewayName,
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

function registryReadabilityCheck(): DoctorCheck {
  try {
    const count = registry.listSandboxes().sandboxes.length;
    return {
      group: "Host",
      label: "Sandbox registry",
      status: "ok",
      detail: `readable (${count} registered sandbox${count === 1 ? "" : "es"})`,
    };
  } catch {
    return {
      group: "Host",
      label: "Sandbox registry",
      status: "fail",
      detail: "could not read the host sandbox registry",
      hint: "check the registry file permissions and JSON, then retry",
    };
  }
}

function unavailableGatewayCheck(): DoctorCheck {
  return {
    group: "Gateway",
    label: "OpenShell status",
    status: "fail",
    detail: "skipped because the OpenShell CLI is not installed",
    hint: "install OpenShell, then retry",
  };
}

function globalGatewayGuidance(gatewayName: string): {
  checks: DoctorCheck[];
  unavailableHint: string;
} {
  try {
    return { checks: [], unavailableHint: gatewayDoctorStartHint(gatewayName) };
  } catch {
    const hint =
      "check the gateway-management declaration file permissions and JSON, then retry";
    return {
      checks: [
        {
          group: "Gateway",
          label: "Gateway management",
          status: "fail",
          detail: "could not resolve the gateway lifecycle owner",
          hint,
        },
      ],
      unavailableHint: hint,
    };
  }
}

export async function runGlobalDoctor(
  options: { quiet?: boolean } = {},
): Promise<GlobalDoctorReport> {
  const host = collectDoctorHostChecks(null);
  const gatewayName = resolveGatewayName(GATEWAY_PORT);
  const guidance = globalGatewayGuidance(gatewayName);
  let gatewayChecks: DoctorCheck[] = [...guidance.checks];
  if (host.openshellBin) {
    gatewayChecks = [
      ...gatewayChecks,
      ...(
        await collectDoctorGatewayChecks(gatewayName, null, host.openshellBin, {
          gatewayPort: GATEWAY_PORT,
          ignoreProbeErrors: true,
          recoverGateway: false,
          unavailableHint: guidance.unavailableHint,
        })
      ).checks,
    ];
  } else {
    gatewayChecks.push(unavailableGatewayCheck());
  }
  const report = buildGlobalDoctorReport([
    ...host.checks,
    registryReadabilityCheck(),
    ...gatewayChecks,
  ]);
  if (!options.quiet) renderDoctorReport(report, false);
  return report;
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
