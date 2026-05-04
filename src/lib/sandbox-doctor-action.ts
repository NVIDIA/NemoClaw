// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess doctor tests. */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CLI_DISPLAY_NAME, CLI_NAME } from "./branding";
import { isErrnoException } from "./errno";
import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";
import { probeProviderHealth } from "./inference-health";
import { parseGatewayInference } from "./inference-config";
import { stripAnsi } from "./openshell";
import { captureOpenshell } from "./openshell-runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { GATEWAY_PORT, OLLAMA_PORT } from "./ports";
import * as registry from "./registry";
import type { SandboxEntry } from "./registry";
import { resolveOpenshell } from "./resolve-openshell";
import { ROOT } from "./runner";
import { parseLiveSandboxNames } from "./runtime-recovery";
import * as sandboxVersion from "./sandbox-version";
import * as shields from "./shields";
import { buildStatusCommandDeps } from "./status-command-deps";
import { B, D, G, R, RD, YW } from "./terminal-style";

const agentRuntime = require("../../bin/lib/agent-runtime");

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

type DoctorStatus = "ok" | "warn" | "fail" | "info";

type DoctorCheck = {
  group: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
};

type CommandCapture = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
};

function captureHostCommand(
  command: string,
  args: string[],
  timeout = 5000,
): CommandCapture {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
  };
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

function renderDoctorReport(sandboxName: string, checks: DoctorCheck[], asJson: boolean): number {
  const summary = doctorSummary(checks);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          sandbox: sandboxName,
          status: summary.status,
          failed: summary.failed,
          warnings: summary.warned,
          checks,
        },
        null,
        2,
      ),
    );
    return summary.failed > 0 ? 1 : 0;
  }

  console.log("");
  console.log(`  ${B}${CLI_DISPLAY_NAME} doctor:${R} ${sandboxName}`);
  const groupOrder = ["Host", "Gateway", "Sandbox", "Inference", "Messaging", "Local services"];
  const orderedGroups = [
    ...groupOrder,
    ...checks
      .map((check) => check.group)
      .filter((group, index, all) => !groupOrder.includes(group) && all.indexOf(group) === index),
  ];
  for (const group of orderedGroups) {
    const groupChecks = checks.filter((check) => check.group === group);
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
  if (summary.status === "ok") {
    console.log(`  Summary: ${G}healthy${R}`);
  } else if (summary.status === "warn") {
    console.log(`  Summary: ${YW}healthy with ${summary.warned} warning(s)${R}`);
  } else {
    console.log(
      `  Summary: ${RD}attention needed${R} (${summary.failed} failed, ${summary.warned} warning(s))`,
    );
  }
  console.log("");
  return summary.failed > 0 ? 1 : 0;
}

function dockerInspectGateway(containerName: string): DoctorCheck[] {
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
    checks.push({
      group: "Gateway",
      label: "Docker container",
      status: "fail",
      detail: `${containerName} not found or not inspectable`,
      hint: "run `docker ps --filter name=openshell-cluster-nemoclaw`",
    });
    return checks;
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
    hint: `start when needed with \`${CLI_NAME} tunnel start\``,
  };
}

function staleCloudflaredPidFileCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: "stale PID file",
    hint: `run \`${CLI_NAME} tunnel stop\` and start it again if you need a public tunnel`,
  };
}

function staleCloudflaredPidCheck(pid: number): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: `stale PID ${pid}`,
    hint: `run \`${CLI_NAME} tunnel stop\` to clean up the service state`,
  };
}

function readCloudflaredPidFile(pidFile: string): string | null {
  try {
    return fs.readFileSync(pidFile, "utf-8").trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function commandLineNamesCloudflared(commandLine: string): boolean {
  return commandLine
    .split(/\0|\s+/)
    .filter(Boolean)
    .some((token) => path.basename(token) === "cloudflared");
}

function readProcessCommandLine(pid: number): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "comm=", "-o", "args="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      });
    } catch {
      return null;
    }
  }
}

function isCloudflaredProcess(pid: number): boolean {
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === null) {
    return false;
  }
  return commandLineNamesCloudflared(commandLine);
}

function cloudflaredDoctorCheck(sandboxName: string): DoctorCheck {
  const pidFile = path.join(`/tmp/nemoclaw-services-${sandboxName}`, "cloudflared.pid");
  if (!fs.existsSync(pidFile)) {
    return stoppedCloudflaredCheck();
  }
  const rawPid = readCloudflaredPidFile(pidFile);
  if (rawPid === null) {
    return stoppedCloudflaredCheck();
  }
  const pid = Number(rawPid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return staleCloudflaredPidFileCheck();
  }
  try {
    process.kill(pid, 0);
    if (!isCloudflaredProcess(pid)) {
      return staleCloudflaredPidCheck(pid);
    }
    return {
      group: "Local services",
      label: "cloudflared",
      status: "ok",
      detail: `running (PID ${pid})`,
    };
  } catch {
    return staleCloudflaredPidCheck(pid);
  }
}

function ollamaDoctorCheck(currentProvider: string): DoctorCheck {
  const endpoint = `http://127.0.0.1:${OLLAMA_PORT}/api/tags`;
  const result = captureHostCommand(
    "curl",
    ["-sS", "--connect-timeout", "2", "--max-time", "4", endpoint],
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

// eslint-disable-next-line complexity
export async function runSandboxDoctor(sandboxName: string, args: string[] = []): Promise<void> {
  const asJson = args.includes("--json");
  const helpRequested = args.includes("--help") || args.includes("-h");
  const unknown = args.filter((arg) => !["--json", "--help", "-h"].includes(arg));
  if (helpRequested) {
    console.log(`  Usage: ${CLI_NAME} <name> doctor [--json]`);
    return;
  }
  if (unknown.length > 0) {
    console.error(`  Unknown doctor argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(" ")}`);
    console.error(`  Usage: ${CLI_NAME} <name> doctor [--json]`);
    process.exit(1);
  }

  const sb = registry.getSandbox(sandboxName);
  const checks: DoctorCheck[] = [];

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

  checks.push(...dockerInspectGateway(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`));

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

  if (openshellBin && openshellConnected) {
    const list = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    const liveNames = parseLiveSandboxNames(list.output || "");
    const present = list.status === 0 && liveNames.has(sandboxName);
    const line = findSandboxListLine(list.output || "", sandboxName);
    const ready = inferSandboxReadyFromLine(line);
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
    } else if (!inferenceHealth.probed) {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: "info",
        detail: inferenceHealth.detail,
      });
    } else {
      checks.push({
        group: "Inference",
        label: "Provider health",
        status: inferenceHealth.ok ? "ok" : "fail",
        detail: inferenceHealth.ok
          ? `${inferenceHealth.endpoint} reachable`
          : inferenceHealth.detail,
        hint: inferenceHealth.ok ? undefined : "check network access or provider credentials",
      });
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

    checks.push({
      group: "Sandbox",
      label: "Shields",
      status: shields.isShieldsDown(sandboxName) ? "warn" : "ok",
      detail: shields.isShieldsDown(sandboxName) ? "down" : "up",
      hint: shields.isShieldsDown(sandboxName)
        ? `run \`${CLI_NAME} ${sandboxName} shields status\` for details`
        : undefined,
    });
    checks.push(messagingDoctorCheck(sandboxName, sb));
  }

  checks.push(ollamaDoctorCheck(currentProvider));
  checks.push(cloudflaredDoctorCheck(sandboxName));

  const exitCode = renderDoctorReport(sandboxName, checks, asJson);
  if (exitCode !== 0) process.exit(exitCode);
}
