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
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { B, D, G, R, RD, YW } from "../../cli/terminal-style";
import { GATEWAY_PORT, OLLAMA_PORT } from "../../core/ports";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import { parseGatewayInference } from "../../inference/config";
import { type ProviderHealthStatus, probeProviderHealth } from "../../inference/health";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
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
import { buildToolScopeChecks } from "./doctor-tool-scope";
import { probeSandboxInferenceGatewayHealth } from "./process-recovery";

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

type DoctorStatus = "ok" | "warn" | "fail" | "info";

export type DoctorCheck = {
  group: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
};

export type DoctorReport = {
  schemaVersion: 1;
  sandbox: string;
  status: DoctorStatus;
  failed: number;
  warnings: number;
  checks: DoctorCheck[];
};

function pushInferenceHealthCheck(
  checks: DoctorCheck[],
  probe: ProviderHealthStatus,
): void {
  const label = probe.probeLabel
    ? `Provider health (${probe.probeLabel})`
    : "Provider health";
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

function doctorSummary(checks: DoctorCheck[]): {
  status: DoctorStatus;
  failed: number;
  warned: number;
} {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed > 0) return { status: "fail", failed, warned };
  if (warned > 0) return { status: "warn", failed, warned };
  return { status: "ok", failed, warned };
}

function doctorStatusLabel(status: DoctorStatus): string {
  switch (status) {
    case "ok":
      return `${G}[ok]${R}`;
    case "warn":
      return `${YW}[warn]${R}`;
    case "fail":
      return `${RD}[fail]${R}`;
    case "info":
      return `${D}[info]${R}`;
    default:
      return `[${status}]`;
  }
}

function buildDoctorReport(sandboxName: string, checks: DoctorCheck[]): DoctorReport {
  const summary = doctorSummary(checks);
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    status: summary.status,
    failed: summary.failed,
    warnings: summary.warned,
    checks,
  };
}

function doctorReportExitCode(report: DoctorReport): number {
  return report.failed > 0 ? 1 : 0;
}

function renderDoctorReport(report: DoctorReport, asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return doctorReportExitCode(report);
  }

  console.log("");
  console.log(`  ${B}${CLI_DISPLAY_NAME} doctor:${R} ${report.sandbox}`);
  const groupOrder = ["Host", "Gateway", "Sandbox", "Inference", "Messaging", "Local services"];
  const orderedGroups = [
    ...groupOrder,
    ...report.checks
      .map((check) => check.group)
      .filter((group, index, all) => !groupOrder.includes(group) && all.indexOf(group) === index),
  ];
  for (const group of orderedGroups) {
    const groupChecks = report.checks.filter((check) => check.group === group);
    if (groupChecks.length === 0) continue;
    console.log("");
    console.log(`  ${G}${group}:${R}`);
    for (const check of groupChecks) {
      console.log(`    ${doctorStatusLabel(check.status)} ${check.label}: ${check.detail}`);
      if (check.hint) {
        console.log(`         ${D}hint: ${check.hint}${R}`);
      }
    }
  }

  console.log("");
  if (report.status === "ok") {
    console.log(`  Summary: ${G}healthy${R}`);
  } else if (report.status === "warn") {
    console.log(`  Summary: ${YW}healthy with ${report.warnings} warning(s)${R}`);
  } else {
    console.log(
      `  Summary: ${RD}attention needed${R} (${report.failed} failed, ${report.warnings} warning(s))`,
    );
  }
  console.log("");
  return doctorReportExitCode(report);
}

function dockerInspectGateway(
  containerName: string,
  options: GatewayInspectOptions = {},
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
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

  const [runningRaw, healthRaw, imageRaw] = inspect.stdout.trim().split("\t");
  const running = runningRaw === "true";
  const health = healthRaw || "none";
  const image = imageRaw || "unknown";
  const healthOk = health === "healthy" || health === "none";
  checks.push({
    group: "Gateway",
    label: "Docker container",
    status: running && healthOk ? "ok" : "fail",
    detail: `${containerName} ${running ? "running" : "stopped"} (${health}; ${image})`,
    hint: running ? undefined : "restart the gateway with `openshell gateway start --name nemoclaw`",
  });

  const port = captureHostCommand("docker", ["port", containerName, "30051/tcp"], 5000);
  if (port.status === 0 && port.stdout.trim()) {
    const mapping = oneLine(port.stdout);
    checks.push({
      group: "Gateway",
      label: "Port mapping",
      status: mapping.includes(`:${GATEWAY_PORT}`) ? "ok" : "warn",
      detail: mapping,
      hint: mapping.includes(`:${GATEWAY_PORT}`)
        ? undefined
        : `expected host port ${GATEWAY_PORT} from NEMOCLAW_GATEWAY_PORT`,
    });
  } else {
    checks.push({
      group: "Gateway",
      label: "Port mapping",
      status: "fail",
      detail: "30051/tcp is not published on the host",
      hint: "gateway traffic will not reach OpenShell until the container is recreated with a host port",
    });
  }
  return checks;
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

/**
 * Compare the registry's enabled-channels list with channels the OpenClaw
 * runtime actually acknowledged inside the sandbox (config block in
 * /sandbox/.openclaw/openclaw.json plus a gateway-log mention). Returns
 * null when the probe doesn't apply (no enabled channels, agent has no
 * JSON config) so the caller can skip the check entirely instead of
 * rendering a no-op line. Fixes #4156 — without this, a sandbox where
 * the OpenClaw runtime silently ignored a configured channel looks healthy
 * at `doctor` time even though the dashboard shows "No channels found".
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
  if (!runtime.ok) {
    return {
      group: "Messaging",
      label: "Runtime channel registry",
      status: "warn",
      detail: runtime.detail,
      hint:
        `start the sandbox and rerun \`${CLI_NAME} ${sandboxName} doctor\`, ` +
        `or rebuild with \`${CLI_NAME} ${sandboxName} rebuild\` if the config file is missing`,
    };
  }
  if (runtime.logProbeOk) {
    // Diff against the log-corroborated runtime view. Catches both the
    // stale-rebuild path (channel block missing) and the runtime-startup
    // path (config has it, log doesn't).
    const { missing: notRunning } = compareChannelSets(enabledChannels, runtime.visibleChannels);
    if (notRunning.length > 0) {
      return {
        group: "Messaging",
        label: "Runtime channel registry",
        status: "warn",
        detail: `not visible to OpenClaw runtime: ${notRunning.join(", ")}`,
        hint:
          `the OpenClaw dashboard "Channels" panel will show "No channels found" for ` +
          `${notRunning.join(", ")}; inspect \`${agent.configPaths.dir}/${agent.configPaths.configFile}\` ` +
          `and the gateway log with \`${CLI_NAME} ${sandboxName} logs\`, then re-run ` +
          `\`${CLI_NAME} ${sandboxName} rebuild\` if the channels block needs to be regenerated`,
      };
    }
  } else {
    // Log unavailable: we can still detect a config-only mismatch
    // (registry expects telegram but openclaw.json doesn't have it).
    // Surface that as a warn so a stale rebuild isn't masked by an
    // unreadable log (CodeRabbit on PR #4182). The log-unavailable
    // warning below still runs when configMissing is empty.
    const { missing: configMissing } = compareChannelSets(enabledChannels, runtime.configuredChannels);
    if (configMissing.length > 0) {
      return {
        group: "Messaging",
        label: "Runtime channel registry",
        status: "warn",
        detail: `missing from sandbox config: ${configMissing.join(", ")}`,
        hint:
          `\`${agent.configPaths.dir}/${agent.configPaths.configFile}\` is missing the channel block ` +
          `for ${configMissing.join(", ")}; re-run \`${CLI_NAME} ${sandboxName} rebuild\` so the config is regenerated`,
      };
    }
  }
  if (!runtime.logProbeOk) {
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
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "ok",
    detail: `${enabledChannels.join(", ")} acknowledged by OpenClaw runtime`,
  };
}

function messagingDoctorCheck(sandboxName: string, sb: SandboxEntry): DoctorCheck {
  const registeredChannels = Array.isArray(sb.messagingChannels) ? sb.messagingChannels : [];
  const disabledChannels = new Set(Array.isArray(sb.disabledChannels) ? sb.disabledChannels : []);
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

  const degraded =
    buildStatusCommandDeps(ROOT).checkMessagingBridgeHealth?.(sandboxName, channels) || [];
  const pausedSuffix =
    pausedChannels.length > 0 ? `; paused channels skipped: ${pausedChannels.join(", ")}` : "";
  if (degraded.length === 0) {
    // WhatsApp's inbound delivery cannot be inferred from the conflict-signature
    // heuristic — issue #4386 showed a paired channel with a live Noise
    // WebSocket that never delivered inbound events, while this check rendered
    // "ok". Downgrade to "info" with a pointer to `channels status` so doctor
    // never claims WhatsApp is healthy without running the deep probe.
    if (channels.includes("whatsapp")) {
      return {
        group: "Messaging",
        label: "Channels",
        status: "info",
        detail: `${channels.join(", ")} enabled; whatsapp inbound delivery is not inferred from conflict signatures${pausedSuffix}`,
        hint: `run \`${CLI_NAME} ${sandboxName} channels status --channel whatsapp\` to probe inbound delivery`,
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
    detail:
      degraded
        .map(
          (item: { channel: string; conflicts: number }) =>
            `${item.channel}: ${item.conflicts} conflict(s)`,
        )
        .join("; ") + pausedSuffix,
    hint: `run \`${CLI_NAME} ${sandboxName} logs --follow\` for enabled bridge details`,
  };
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

// eslint-disable-next-line complexity
export async function runSandboxDoctor(
  sandboxName: string,
  args: string[] = [],
  options: RunSandboxDoctorOptions = {},
): Promise<DoctorReport | undefined> {
  const asJson = args.includes("--json");
  const wantsFix = args.includes("--fix");
  const helpRequested = args.includes("--help") || args.includes("-h");
  const unknown = args.filter((arg) => !["--json", "--fix", "--help", "-h"].includes(arg));
  if (helpRequested) {
    console.log(`  Usage: ${CLI_NAME} <name> doctor [--json] [--fix]`);
    console.log(`  --fix   Restore the mutable OpenClaw config permission contract if it was tightened,`);
    console.log(`          and approve pending allowlisted dashboard/CLI tool-scope upgrades`);
    return;
  }
  if (unknown.length > 0) {
    console.error(`  Unknown doctor argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}`);
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
    console.error(`  Run \`${CLI_NAME} ${sandboxName} doctor --json\` to detect, then \`${CLI_NAME} ${sandboxName} doctor --fix\` to repair`);
    process.exit(1);
  }

  const sb = registry.getSandbox(sandboxName);
  const checks: DoctorCheck[] = [];
  // Tracks whether the named sandbox is present-and-Ready, so live-only probes
  // (e.g. the #4616 dashboard tool-scope diagnostic) only run when they can
  // actually reach the sandbox via `openshell sandbox exec`.
  let sandboxReachable = false;

  checks.push({
    group: "Host",
    label: "CLI build",
    status: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js")) ? "ok" : "fail",
    detail: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js"))
      ? "dist/nemoclaw.js present"
      : "dist/nemoclaw.js missing",
    hint: fs.existsSync(path.join(ROOT, "dist", "nemoclaw.js"))
      ? undefined
      : "run `npm run build:cli`",
  });

  const dockerInfo = captureHostCommand("docker", ["info", "--format", "{{.ServerVersion}}"], 8000);
  checks.push({
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
  });

  const openshellBin = resolveOpenshell();
  checks.push({
    group: "Host",
    label: "OpenShell CLI",
    status: openshellBin ? "ok" : "fail",
    detail: openshellBin || "not found on PATH",
    hint: openshellBin ? undefined : "install OpenShell before using sandbox commands",
  });

  let openshellConnected = false;
  if (openshellBin) {
    const recovery = await recoverNamedGatewayRuntime();
    const lifecycle = recovery.after || recovery.before;
    const cleanStatus = stripAnsi(lifecycle?.status || "");
    openshellConnected = lifecycle?.state === "healthy_named";
    checks.push({
      group: "Gateway",
      label: "OpenShell status",
      status: openshellConnected ? "ok" : "fail",
      detail: openshellConnected
        ? "connected to nemoclaw"
        : oneLine(cleanStatus || lifecycle?.gatewayInfo || "not connected to nemoclaw"),
      hint: openshellConnected ? undefined : "run `openshell gateway select nemoclaw` and retry",
    });
  }

  if (shouldInspectLegacyGatewayContainer(sb)) {
    checks.push(
      ...dockerInspectGateway(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`, {
        namedGatewayConnected: openshellConnected,
      }),
    );
  }

  if (openshellBin && openshellConnected) {
    const list = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    const liveNames = parseLiveSandboxNames(list.output || "");
    const present = list.status === 0 && liveNames.has(sandboxName);
    const line = findSandboxListLine(list.output || "", sandboxName);
    const ready = inferSandboxReadyFromLine(line);
    sandboxReachable = present && ready === true;
    checks.push({
      group: "Sandbox",
      label: "Live sandbox",
      status: present && ready === true ? "ok" : "fail",
      detail: present
        ? ready === true
          ? `${sandboxName} present (Ready)`
          : `${sandboxName} present${line ? ` (${oneLine(line)})` : ""}`
        : `${sandboxName} not present in live OpenShell sandbox list`,
      hint: present
        ? ready === true
          ? undefined
          : `run \`${CLI_NAME} ${sandboxName} status\` or \`${CLI_NAME} ${sandboxName} logs --follow\``
        : `run \`${CLI_NAME} ${sandboxName} status\` or recreate with \`${CLI_NAME} onboard\``,
    });
  } else if (openshellBin) {
    checks.push({
      group: "Sandbox",
      label: "Live sandbox",
      status: "fail",
      detail: "skipped because the nemoclaw gateway is not connected",
      hint: "fix the gateway check above before trusting sandbox readiness",
    });
  }

  const live =
    openshellBin && openshellConnected
      ? parseGatewayInference(
          captureOpenshell(["inference", "get"], {
            ignoreError: true,
            timeout: OPENSHELL_PROBE_TIMEOUT_MS,
          }).output,
        )
      : null;
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  checks.push({
    group: "Inference",
    label: "Route",
    status: currentProvider !== "unknown" || currentModel !== "unknown" ? "ok" : "warn",
    detail: `${currentProvider} / ${currentModel}`,
    hint:
      currentProvider !== "unknown" || currentModel !== "unknown"
        ? undefined
        : `run \`${CLI_NAME} ${sandboxName} status\` after the gateway is healthy`,
  });

  if (typeof currentProvider === "string" && currentProvider !== "unknown") {
    const inferenceHealth = probeProviderHealth(currentProvider);
    if (!inferenceHealth) {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: "info",
        detail: `no health probe registered for ${currentProvider}`,
      });
    } else {
      // #3265 optional 3rd line — append gateway-chain probe for local
      // providers so doctor sees the full path the agent uses.
      if (currentProvider === "ollama-local" || currentProvider === "vllm-local") {
        const gatewayChain = await probeSandboxInferenceGatewayHealth(sandboxName);
        if (gatewayChain) {
          inferenceHealth.subprobes = [
            ...(inferenceHealth.subprobes ?? []),
            {
              ok: gatewayChain.ok,
              probed: true,
              providerLabel: "Inference gateway chain",
              endpoint: gatewayChain.endpoint,
              detail: gatewayChain.detail,
              probeLabel: "gateway",
              ...(gatewayChain.ok ? {} : { failureLabel: "unreachable" as const }),
            },
          ];
        }
      }
      pushInferenceHealthCheck(checks, inferenceHealth);
      for (const sub of inferenceHealth.subprobes ?? []) {
        pushInferenceHealthCheck(checks, sub);
      }
    }
  }

  if (sb) {
    try {
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.isStale) {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "warn",
          detail: `${agentName} v${versionCheck.sandboxVersion || "unknown"}; v${versionCheck.expectedVersion} available`,
          hint: `run \`${CLI_NAME} ${sandboxName} rebuild\``,
        });
      } else if (versionCheck.sandboxVersion) {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "ok",
          detail: `${agentName} v${versionCheck.sandboxVersion}`,
        });
      } else {
        checks.push({
          group: "Sandbox",
          label: "Agent version",
          status: "info",
          detail: "could not detect version",
        });
      }
    } catch {
      checks.push({
        group: "Sandbox",
        label: "Agent version",
        status: "info",
        detail: "version check unavailable",
      });
    }

    const shieldsPosture = shields.getShieldsPosture(sandboxName, true);
    const shieldsStatus: DoctorStatus =
      shieldsPosture.mode === "locked"
        ? "ok"
        : shieldsPosture.mode === "temporarily_unlocked" || shieldsPosture.mode === "error"
          ? "warn"
          : "info";
    const shieldsHint =
      shieldsPosture.mode === "mutable_default"
        ? `run \`${CLI_NAME} ${sandboxName} shields up\` to opt into lockdown`
        : shieldsPosture.mode === "locked"
          ? undefined
          : `run \`${CLI_NAME} ${sandboxName} shields status\` for details`;
    checks.push({
      group: "Sandbox",
      label: "Shields",
      status: shieldsStatus,
      detail: shieldsPosture.detail,
      hint: shieldsHint,
    });

    // #4538: detect (and optionally repair with --fix) a mutable OpenClaw config
    // tree that `openclaw doctor --fix` tightened from the NemoClaw contract
    // (setgid + group-writable 2770/660) back to single-user 700/600. When that
    // happens the gateway UID can no longer persist config edits.
    const permsCheck = buildConfigPermsCheck(sandboxName, wantsFix, {
      inspect: shields.inspectMutableConfigPerms,
      repair: shields.repairMutableConfigPerms,
      cliName: CLI_NAME,
    });
    if (permsCheck) checks.push(permsCheck);

    checks.push(messagingDoctorCheck(sandboxName, sb));
    // #4156: bridge the gap between "configured" and "runtime-visible" — the
    // existing messaging check above probes provider attachment, not whether
    // OpenClaw's runtime config actually surfaces each enabled channel.
    const registeredChannels = Array.isArray(sb.messagingChannels) ? sb.messagingChannels : [];
    const disabledChannelsSet = new Set(
      Array.isArray(sb.disabledChannels) ? sb.disabledChannels : [],
    );
    const enabledChannels = registeredChannels.filter(
      (channel: string) => !disabledChannelsSet.has(channel),
    );
    const runtimeCheck = channelRuntimeDoctorCheck(sandboxName, enabledChannels);
    if (runtimeCheck) checks.push(runtimeCheck);
  }

  // #4616: surface (and, with --fix, repair) late OpenClaw dashboard/tool-call
  // device-scope approvals. Dashboard-only users never run `connect`, so a
  // pending tool-scope upgrade — visible as a gateway 1006 close, a "scope
  // upgrade pending approval" error, and a loopback policy denial — has no
  // recovery path. The probe is read-only; `--fix` runs the same narrow
  // allowlisted approval pass that `connect` runs. Only run it when the sandbox
  // is actually reachable so a stopped sandbox doesn't add noise, and only for
  // OpenClaw — the `openclaw devices`/auto-pair scope-upgrade mechanism is
  // OpenClaw-specific. Hermes (device_pairing: false) uses a different tool
  // gateway, so probing it would emit an inaccurate OpenClaw-only check.
  // Legacy registry entries with no recorded agent default to OpenClaw.
  if (sb && sandboxReachable && (sb.agent ?? "openclaw") === "openclaw") {
    const toolScopeChecks = buildToolScopeChecks(sandboxName, CLI_NAME, wantsFix, {
      // OpenShell exec rejects multi-line args, so base64-wrap the probe payload.
      exec: (name, script) =>
        executeSandboxCommandForVerification(name, wrapSandboxShellScript(script)),
      runApprovalPass: (name) => {
        const result = runSandboxAutoPairApprovalPass(name, { capture: true });
        return { reported: result.reported, approved: result.approved };
      },
    });
    for (const check of toolScopeChecks) checks.push(check);
  }

  checks.push(ollamaDoctorCheck(currentProvider));
  checks.push(cloudflaredDoctorCheck(sandboxName));

  const report = buildDoctorReport(sandboxName, checks);
  if (asJson && options.quietJson) return report;

  const exitCode = renderDoctorReport(report, asJson);
  if (exitCode !== 0) process.exit(exitCode);
  return undefined;
}
