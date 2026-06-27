// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { buildValidatedCurlCommandArgs } from "../../adapters/http/curl-args";
import { stripAnsi } from "../../adapters/openshell/client";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { captureOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { compareChannelSets, probeChannelRuntimeStatus } from "../../channel-runtime-status";
import { CLI_NAME } from "../../cli/branding";
import { GATEWAY_PORT, OLLAMA_PORT } from "../../core/ports";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import { parseGatewayInference } from "../../inference/config";
import { type ProviderHealthStatus, probeProviderHealth } from "../../inference/health";
import {
  collectBuiltInMessagingChannelDiagnostics,
  type MessagingChannelDiagnosticSpec,
} from "../../messaging/diagnostics";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import { ROOT } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { buildStatusCommandDeps } from "../../status-command-deps";
import { readCloudflaredState } from "../../tunnel/services";
import { runSandboxAutoPairApprovalPass, wrapSandboxShellScript } from "./auto-pair-approval";
import { buildConfigPermsCheck } from "./doctor-config-perms";
import {
  buildGatewayInspectFailureChecks,
  type GatewayInspectOptions,
} from "./doctor-gateway-fallback";
import { captureHostCommand } from "./doctor-host-command";
import {
  buildDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  renderDoctorReport,
} from "./doctor-report";
import { buildToolScopeChecks } from "./doctor-tool-scope";
import { probeSandboxInferenceGatewayHealth } from "./process-recovery";

export type { DoctorCheck, DoctorReport } from "./doctor-report";

const CHANNEL_STATUS_DIAGNOSTICS = collectBuiltInMessagingChannelDiagnostics();

function pushInferenceHealthCheck(checks: DoctorCheck[], probe: ProviderHealthStatus): void {
  const label = probe.probeLabel ? `Provider health (${probe.probeLabel})` : "Provider health";
  if (!probe.probed) {
    checks.push({ group: "Inference", label, status: "info", detail: probe.detail });
    return;
  }
  checks.push({
    group: "Inference",
    label,
    status: probe.ok ? "ok" : "fail",
    detail: probe.ok ? `${probe.endpoint} reachable` : probe.detail,
    hint: probe.ok ? undefined : "check network access or provider credentials",
  });
}

function oneLine(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function gatewayContainerCheck(
  containerName: string,
  output: string,
  options: GatewayInspectOptions,
): DoctorCheck {
  const [runningRaw, healthRaw, imageRaw] = output.trim().split("\t");
  const running = runningRaw === "true";
  const health = healthRaw || "none";
  const image = imageRaw || "unknown";
  const healthy = health === "healthy" || health === "none";
  return {
    group: "Gateway",
    label: "Docker container",
    status: running && healthy ? "ok" : "fail",
    detail: `${containerName} ${running ? "running" : "stopped"} (${health}; ${image})`,
    hint: running
      ? undefined
      : `restart the gateway with \`openshell gateway start --name ${options.gatewayName ?? "nemoclaw"}\``,
  };
}

function gatewayPortCheck(containerName: string): DoctorCheck {
  const port = captureHostCommand("docker", ["port", containerName, "30051/tcp"], 5000);
  if (port.status !== 0 || !port.stdout.trim()) {
    return {
      group: "Gateway",
      label: "Port mapping",
      status: "fail",
      detail: "30051/tcp is not published on the host",
      hint: "gateway traffic will not reach OpenShell until the container is recreated with a host port",
    };
  }
  const mapping = oneLine(port.stdout);
  const expected = mapping.includes(`:${GATEWAY_PORT}`);
  return {
    group: "Gateway",
    label: "Port mapping",
    status: expected ? "ok" : "warn",
    detail: mapping,
    hint: expected ? undefined : `expected host port ${GATEWAY_PORT} from NEMOCLAW_GATEWAY_PORT`,
  };
}

function dockerInspectGateway(
  containerName: string,
  options: GatewayInspectOptions = {},
): DoctorCheck[] {
  const inspect = captureHostCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Config.Image}}",
      containerName,
    ],
    5000,
  );
  if (inspect.status !== 0) {
    return buildGatewayInspectFailureChecks(containerName, options);
  }
  return [
    gatewayContainerCheck(containerName, inspect.stdout, options),
    gatewayPortCheck(containerName),
  ];
}

function findSandboxListLine(output: string, sandboxName: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  return (
    lines.find((line: string) => {
      const columns = line.trim().split(/\s+/);
      return columns.includes(sandboxName);
    }) || null
  );
}

function inferSandboxReadyFromLine(line: string | null): boolean | null {
  if (!line) return null;
  if (/\bReady\b/i.test(line)) return true;
  if (/\b(Failed|Error|CrashLoopBackOff|ImagePullBackOff|Unknown|Evicted)\b/i.test(line)) {
    return false;
  }
  return null;
}

function stoppedCloudflaredCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "info",
    detail: "stopped",
    hint: `no cloudflared process; run \`${CLI_NAME} tunnel start\` to start it`,
  };
}

function staleCloudflaredPidFileCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: "stale PID file",
    hint: `no cloudflared process (stored PID is invalid); run \`${CLI_NAME} tunnel start\` to restart it`,
  };
}

function staleCloudflaredPidCheck(pid: number): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: `stale PID ${pid}`,
    hint: `no cloudflared process (PID ${pid} is dead or not cloudflared); run \`${CLI_NAME} tunnel start\` to restart it`,
  };
}

function cloudflaredDoctorCheck(sandboxName: string): DoctorCheck {
  const state = readCloudflaredState(path.join("/tmp", `nemoclaw-services-${sandboxName}`));
  switch (state.kind) {
    case "stopped":
      return stoppedCloudflaredCheck();
    case "stale-pid-file":
      return staleCloudflaredPidFileCheck();
    case "stale-pid-process":
      return staleCloudflaredPidCheck(state.pid);
    case "running":
      return {
        group: "Local services",
        label: "cloudflared",
        status: "ok",
        detail: `running (PID ${state.pid})`,
      };
  }
}

function ollamaDoctorCheck(currentProvider: string): DoctorCheck {
  const endpoint = `http://127.0.0.1:${OLLAMA_PORT}/api/tags`;
  const result = captureHostCommand(
    "curl",
    buildValidatedCurlCommandArgs(["-sS", "--connect-timeout", "2", "--max-time", "4", endpoint]),
    6000,
  );
  const required = currentProvider === "ollama-local";
  if (result.status !== 0) {
    return {
      group: "Local services",
      label: "Ollama",
      status: required ? "fail" : "info",
      detail: `not reachable at ${endpoint}`,
      hint: required ? "start Ollama or change the sandbox inference provider" : undefined,
    };
  }

  let modelCount = "unknown model count";
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed.models)) {
      modelCount = `${parsed.models.length} model(s)`;
    }
  } catch {
    /* keep generic detail */
  }
  return {
    group: "Local services",
    label: "Ollama",
    status: "ok",
    detail: `reachable at ${endpoint} (${modelCount})`,
  };
}

function runtimeProbeUnavailableCheck(sandboxName: string, detail: string): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail,
    hint:
      `start the sandbox and rerun \`${CLI_NAME} ${sandboxName} doctor\`, ` +
      `or rebuild with \`${CLI_NAME} ${sandboxName} rebuild\` if the config file is missing`,
  };
}

function runtimeVisibilityCheck(
  sandboxName: string,
  enabledChannels: string[],
  visibleChannels: string[],
  configDir: string,
  configFile: string,
): DoctorCheck | null {
  const { missing } = compareChannelSets(enabledChannels, visibleChannels);
  if (missing.length === 0) return null;
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `not visible to OpenClaw runtime: ${missing.join(", ")}`,
    hint:
      `the OpenClaw dashboard "Channels" panel will show "No channels found" for ` +
      `${missing.join(", ")}; inspect \`${configDir}/${configFile}\` ` +
      `and the gateway log with \`${CLI_NAME} ${sandboxName} logs\`, then re-run ` +
      `\`${CLI_NAME} ${sandboxName} rebuild\` if the channels block needs to be regenerated`,
  };
}

function runtimeConfigCheck(
  sandboxName: string,
  enabledChannels: string[],
  configuredChannels: string[],
  configDir: string,
  configFile: string,
): DoctorCheck | null {
  const { missing } = compareChannelSets(enabledChannels, configuredChannels);
  if (missing.length === 0) return null;
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `missing from sandbox config: ${missing.join(", ")}`,
    hint:
      `\`${configDir}/${configFile}\` is missing the channel block ` +
      `for ${missing.join(", ")}; re-run \`${CLI_NAME} ${sandboxName} rebuild\` so the config is regenerated`,
  };
}

function runtimeLogUnavailableCheck(sandboxName: string, enabledChannels: string[]): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `${enabledChannels.join(", ")} present in config; gateway log unavailable, runtime startup not confirmed`,
    hint:
      `start the sandbox and rerun \`${CLI_NAME} ${sandboxName} doctor\`, or inspect ` +
      `the gateway log with \`${CLI_NAME} ${sandboxName} logs\``,
  };
}

function healthyRuntimeCheck(enabledChannels: string[]): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "ok",
    detail: `${enabledChannels.join(", ")} acknowledged by OpenClaw runtime`,
  };
}

/**
 * Compare the registry's enabled channels with the runtime's config and log
 * evidence. A null result means the probe does not apply, so the caller omits
 * the line instead of rendering a no-op diagnostic.
 */
function channelRuntimeDoctorCheck(
  sandboxName: string,
  enabledChannels: string[],
): DoctorCheck | null {
  if (enabledChannels.length === 0) return null;
  let agent: ReturnType<typeof loadAgent>;
  try {
    const sb = registry.getSandbox(sandboxName);
    agent = loadAgent(sb?.agent || "openclaw");
  } catch {
    return null;
  }
  if (agent.configPaths.format !== "json") return null;
  const configFilePath = `${agent.configPaths.dir}/${agent.configPaths.configFile}`;
  const runtime = probeChannelRuntimeStatus({
    configFilePath,
    executeSandboxCommand: (script: string) =>
      executeSandboxCommandForVerification(sandboxName, script),
  });
  if (!runtime.ok) return runtimeProbeUnavailableCheck(sandboxName, runtime.detail);
  if (runtime.logProbeOk) {
    return (
      runtimeVisibilityCheck(
        sandboxName,
        enabledChannels,
        runtime.visibleChannels,
        agent.configPaths.dir,
        agent.configPaths.configFile,
      ) ?? healthyRuntimeCheck(enabledChannels)
    );
  }
  return (
    runtimeConfigCheck(
      sandboxName,
      enabledChannels,
      runtime.configuredChannels,
      agent.configPaths.dir,
      agent.configPaths.configFile,
    ) ?? runtimeLogUnavailableCheck(sandboxName, enabledChannels)
  );
}

function messagingDoctorCheck(sandboxName: string, sb: SandboxEntry): DoctorCheck {
  const registeredChannels = registry.getConfiguredMessagingChannelsFromEntry(sb);
  const disabledChannels = new Set(registry.getDisabledMessagingChannelsFromEntry(sb));
  const channels = registeredChannels.filter((channel: string) => !disabledChannels.has(channel));
  const pausedChannels = registeredChannels.filter((channel: string) =>
    disabledChannels.has(channel),
  );
  if (registeredChannels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: "no messaging channels registered",
    };
  }

  if (channels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: `all messaging channels paused (${pausedChannels.join(", ")})`,
      hint: `run \`${CLI_NAME} ${sandboxName} channels start <channel>\` to re-enable one`,
    };
  }

  const statusDeps = buildStatusCommandDeps(ROOT);
  const degraded = statusDeps.checkMessagingBridgeHealth?.(sandboxName, channels, sb.agent) || [];
  const overlaps = (statusDeps.findMessagingOverlaps?.() ?? []).filter(
    (overlap) => channels.includes(overlap.channel) && overlap.sandboxes.includes(sandboxName),
  );
  const pausedSuffix =
    pausedChannels.length > 0 ? `; paused channels skipped: ${pausedChannels.join(", ")}` : "";
  const warningDetails = [
    ...degraded.map(
      (item: { channel: string; conflicts: number }) =>
        `${item.channel}: ${item.conflicts} conflict(s)`,
    ),
    ...overlaps.map(formatMessagingOverlapDoctorDetail),
  ];
  if (warningDetails.length === 0) {
    const deepProbeDiagnostic = channels
      .map(getChannelStatusDiagnostic)
      .find((diagnostic) => diagnostic?.doctorWhenNoHealthSignals);
    if (deepProbeDiagnostic?.doctorWhenNoHealthSignals) {
      const templateContext = {
        channel: deepProbeDiagnostic.channelId,
        channels: channels.join(", "),
        cli: CLI_NAME,
        pausedSuffix,
        sandbox: sandboxName,
      };
      return {
        group: "Messaging",
        label: "Channels",
        status: "info",
        detail: formatDiagnosticTemplate(
          deepProbeDiagnostic.doctorWhenNoHealthSignals.detail,
          templateContext,
        ),
        hint: formatDiagnosticTemplate(
          deepProbeDiagnostic.doctorWhenNoHealthSignals.hint,
          templateContext,
        ),
      };
    }
    return {
      group: "Messaging",
      label: "Channels",
      status: "ok",
      detail: `${channels.join(", ")} enabled; no recent conflict signatures${pausedSuffix}`,
    };
  }

  return {
    group: "Messaging",
    label: "Channels",
    status: "warn",
    detail: warningDetails.join("; ") + pausedSuffix,
    hint: `run \`${CLI_NAME} ${sandboxName} logs --follow\` for enabled bridge details`,
  };
}

function getChannelStatusDiagnostic(channelName: string): MessagingChannelDiagnosticSpec | null {
  return (
    CHANNEL_STATUS_DIAGNOSTICS.find((diagnostic) => diagnostic.channelId === channelName) ?? null
  );
}

function formatMessagingOverlapDoctorDetail(overlap: {
  readonly channel: string;
  readonly sandboxes: readonly [string, string];
  readonly message?: string;
}): string {
  const detail = overlap.message
    ? formatDiagnosticTemplate(overlap.message, {
        channel: overlap.channel,
        first: overlap.sandboxes[0],
        second: overlap.sandboxes[1],
      })
    : `'${overlap.sandboxes[0]}' and '${overlap.sandboxes[1]}' overlap`;
  return `${overlap.channel}: ${detail}`;
}

function formatDiagnosticTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/**
 * Decide whether to inspect the legacy k3s gateway container
 * (`openshell-cluster-<name>`). That container only exists for the legacy
 * Kubernetes gateway driver. The current Linux/arm64 Docker-driver gateway runs
 * as a host process (or a separate `nemoclaw-openshell-gateway` compatibility
 * container), so inspecting `openshell-cluster-nemoclaw` there always fails and
 * produces a false doctor failure even when OpenShell reports the named gateway
 * as connected (#4502). Prefer the sandbox's recorded driver; fall back to
 * platform detection for older registry entries that predate the field.
 */
function shouldInspectLegacyGatewayContainer(sb: SandboxEntry | null | undefined): boolean {
  const driver = sb?.openshellDriver;
  if (driver === "docker" || driver === "vm") return false;
  if (driver === "kubernetes") return true;
  return !isLinuxDockerDriverGatewayEnabled();
}

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

type InferenceRoute = {
  model: string;
  provider: string;
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
): Promise<GatewayProbe> {
  const checks: DoctorCheck[] = [];
  const gateway = openshellBin
    ? await probeOpenShellGateway(gatewayName)
    : { check: null, connected: false };
  if (gateway.check) checks.push(gateway.check);
  if (shouldInspectLegacyGatewayContainer(sb)) {
    checks.push(
      ...dockerInspectGateway(`openshell-cluster-${gatewayName}`, {
        namedGatewayConnected: gateway.connected,
        gatewayName,
      }),
    );
  }
  return { checks, connected: gateway.connected };
}

async function probeOpenShellGateway(gatewayName: string): Promise<{
  check: DoctorCheck;
  connected: boolean;
}> {
  const recovery = await recoverNamedGatewayRuntime({ gatewayName });
  const lifecycle = recovery.after || recovery.before;
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
): InferenceRoute {
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

function inferenceRouteCheck(sandboxName: string, route: InferenceRoute): DoctorCheck {
  const known = route.provider !== "unknown" || route.model !== "unknown";
  return {
    group: "Inference",
    label: "Route",
    status: known ? "ok" : "warn",
    detail: `${route.provider} / ${route.model}`,
    hint: known
      ? undefined
      : `run \`${CLI_NAME} ${sandboxName} status\` after the gateway is healthy`,
  };
}

function isLocalInferenceProvider(provider: string): boolean {
  return provider === "ollama-local" || provider === "vllm-local";
}

async function collectInferenceChecks(
  sandboxName: string,
  route: InferenceRoute,
): Promise<DoctorCheck[]> {
  const checks = [inferenceRouteCheck(sandboxName, route)];
  if (route.provider === "unknown") return checks;
  const health = probeProviderHealth(route.provider);
  if (!health) {
    checks.push({
      group: "Inference",
      label: "Provider health",
      status: "info",
      detail: `no health probe registered for ${route.provider}`,
    });
    return checks;
  }

  let subprobes = health.subprobes ?? [];
  if (isLocalInferenceProvider(route.provider)) {
    const gateway = await probeSandboxInferenceGatewayHealth(sandboxName);
    if (gateway) {
      subprobes = [
        ...subprobes,
        {
          ok: gateway.ok,
          probed: true,
          providerLabel: "Inference gateway chain",
          endpoint: gateway.endpoint,
          detail: gateway.detail,
          probeLabel: "gateway",
          ...(gateway.ok ? {} : { failureLabel: "unreachable" as const }),
        },
      ];
    }
  }
  pushInferenceHealthCheck(checks, health);
  for (const subprobe of subprobes) pushInferenceHealthCheck(checks, subprobe);
  return checks;
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
  const posture = shields.getShieldsPosture(sandboxName, true);
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

function messagingDoctorChecks(sandboxName: string, sb: SandboxEntry): DoctorCheck[] {
  const checks = [messagingDoctorCheck(sandboxName, sb)];
  const registered = registry.getConfiguredMessagingChannelsFromEntry(sb);
  const disabled = new Set(registry.getDisabledMessagingChannelsFromEntry(sb));
  const enabled = registered.filter((channel: string) => !disabled.has(channel));
  const runtimeCheck = channelRuntimeDoctorCheck(sandboxName, enabled);
  if (runtimeCheck) checks.push(runtimeCheck);
  return checks;
}

function collectRegisteredSandboxChecks(
  sandboxName: string,
  sb: SandboxEntry | null | undefined,
  wantsFix: boolean,
): DoctorCheck[] {
  if (!sb) return [];
  const checks = [agentVersionDoctorCheck(sandboxName), shieldsDoctorCheck(sandboxName)];
  const permsCheck = buildConfigPermsCheck(sandboxName, wantsFix, {
    inspect: shields.inspectMutableConfigPerms,
    repair: shields.repairMutableConfigPerms,
    cliName: CLI_NAME,
  });
  if (permsCheck) checks.push(permsCheck);
  checks.push(...messagingDoctorChecks(sandboxName, sb));
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
  wantsFix: boolean,
): Promise<DoctorCheck[]> {
  const host = collectHostChecks();
  const gateway = await collectGatewayChecks(gatewayName, sb, host.openshellBin);
  const sandbox = collectSandboxReadinessChecks(sandboxName, host.openshellBin, gateway.connected);
  const route = resolveInferenceRoute(sb, host.openshellBin, gateway.connected);
  return [
    ...host.checks,
    ...gateway.checks,
    ...sandbox.checks,
    ...(await collectInferenceChecks(sandboxName, route)),
    ...collectRegisteredSandboxChecks(sandboxName, sb, wantsFix),
    ...collectToolScopeChecks(sandboxName, sb, sandbox.reachable, wantsFix),
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
  const checks = await collectDoctorChecks(sandboxName, sb, gatewayName, intent.wantsFix);
  const report = buildDoctorReport(sandboxName, checks);
  if (intent.asJson && options.quietJson) return report;

  const exitCode = renderDoctorReport(report, intent.asJson);
  if (exitCode !== 0) process.exit(exitCode);
  return undefined;
}
