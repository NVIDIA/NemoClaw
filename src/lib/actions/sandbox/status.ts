// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { parseSandboxPhase } from "../../state/gateway";
import { getNamedGatewayLifecycleState } from "../../gateway-runtime-action";
import { parseGatewayInference } from "../../inference/config";
import {
  probeProviderHealth,
  type ProviderHealthProbeOptions,
  type ProviderHealthStatus,
} from "../../inference/health";
import * as nim from "../../inference/nim";
import * as onboardSession from "../../state/onboard-session";
import type { Session } from "../../state/onboard-session";
import {
  captureOpenshellForStatus,
  isCommandTimeout,
} from "../../adapters/openshell/runtime";
import * as registry from "../../state/registry";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import type { SandboxGatewayState } from "./gateway-state";
import {
  getReconciledSandboxGatewayState,
  getSandboxGatewayStateForStatus,
  printGatewayLifecycleHint,
  printWrongGatewayActiveGuidance,
} from "./gateway-state";
import {
  isSandboxGatewayRunningForStatus,
  probeSandboxInferenceGatewayHealth,
} from "./process-recovery";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import { D, G, R, RD, YW } from "../../cli/terminal-style";

const agentRuntime = require("../../../../bin/lib/agent-runtime");

type ProbeProviderHealth = (
  provider: string,
  options?: ProviderHealthProbeOptions,
) => ProviderHealthStatus | null;

export function getSandboxStatusInferenceHealth(
  gatewayPresent: boolean,
  currentProvider: unknown,
  currentModel: unknown,
  probeProviderHealthImpl: ProbeProviderHealth = probeProviderHealth,
): ProviderHealthStatus | null {
  if (!gatewayPresent || typeof currentProvider !== "string") return null;
  return probeProviderHealthImpl(currentProvider, {
    model: typeof currentModel === "string" ? currentModel : undefined,
  });
}

/**
 * Render one Inference status line. The main probe and each subprobe go
 * through this helper so multi-hop providers (e.g. ollama-local backend +
 * auth proxy) get parallel formatting and the failure of any hop is
 * surfaced individually instead of being hidden by a healthy hop. (#3265)
 */
function printInferenceProbeLine(probe: ProviderHealthStatus): void {
  const label = probe.probeLabel ? `Inference (${probe.probeLabel})` : "Inference";
  if (!probe.probed) {
    console.log(`    ${label}: ${D}not probed${R} (${probe.detail})`);
    return;
  }
  if (probe.ok) {
    console.log(`    ${label}: ${G}healthy${R} (${probe.endpoint})`);
    return;
  }
  // `failureLabel` is set by the probe (e.g. `unauthorized` for HTTP 401 on
  // the auth proxy in `inference/local.ts:probeOllamaAuthProxyHealth`); the
  // `|| "unreachable"` fallback only applies when an upstream forgot to set
  // one. Don't infer the failure mode here — preserve what the probe said. (#3265)
  console.log(
    `    ${label}: ${RD}${probe.failureLabel || "unreachable"}${R} (${probe.endpoint})`,
  );
  console.log(`      ${probe.detail}`);
}

// eslint-disable-next-line complexity
export async function showSandboxStatus(sandboxName: string): Promise<void> {
  const sb = registry.getSandbox(sandboxName);
  // #2666: never let an unexpected throw from the gateway probe (e.g. openshell
  // hanging when its container is stopped and the published port is held by a
  // foreign listener) suppress the sandbox header. The downstream switch
  // handles `gateway_error` by printing an actionable block + exit(1), so a
  // synthesized fallback keeps the user-visible contract intact.
  let lookup: SandboxGatewayState;
  try {
    lookup = await getReconciledSandboxGatewayState(sandboxName, {
      getState: getSandboxGatewayStateForStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lookup = {
      state: "gateway_error",
      output: `  Could not probe live gateway state: ${message}`,
    };
  }
  let liveResult: Awaited<ReturnType<typeof captureOpenshellForStatus>> | null = null;
  if (lookup.state === "present") {
    try {
      liveResult = await captureOpenshellForStatus(["inference", "get"], {
        ignoreError: true,
      });
    } catch {
      liveResult = null;
    }
  }
  const live =
    liveResult && !isCommandTimeout(liveResult) ? parseGatewayInference(liveResult.output) : null;
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  const inferenceHealth = getSandboxStatusInferenceHealth(
    lookup.state === "present",
    currentProvider,
    currentModel,
  );
  // #3265 optional 3rd line: probe the full inference chain (openclaw gateway
  // → auth proxy → backend) from inside the sandbox so a broken hop the
  // host-side probes can't see still surfaces in `status`.
  if (
    inferenceHealth &&
    lookup.state === "present" &&
    (currentProvider === "ollama-local" || currentProvider === "vllm-local")
  ) {
    const gatewayChain = await probeSandboxInferenceGatewayHealth(sandboxName);
    if (gatewayChain) {
      const gatewaySubprobe: ProviderHealthStatus = {
        ok: gatewayChain.ok,
        probed: true,
        providerLabel: "Inference gateway chain",
        endpoint: gatewayChain.endpoint,
        detail: gatewayChain.detail,
        probeLabel: "gateway",
        ...(gatewayChain.ok ? {} : { failureLabel: "unreachable" as const }),
      };
      inferenceHealth.subprobes = [...(inferenceHealth.subprobes ?? []), gatewaySubprobe];
    }
  }
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${currentModel}`);
    console.log(`    Provider: ${currentProvider}`);
    if (inferenceHealth) {
      printInferenceProbeLine(inferenceHealth);
      for (const sub of inferenceHealth.subprobes ?? []) {
        printInferenceProbeLine(sub);
      }
    }
    if (lookup.state !== "present") {
      console.log("    Inference: not verified (gateway/sandbox state not verified)");
    }
    const hostGpu = sb.hostGpuDetected ? "yes" : "no";
    const sandboxGpuEnabled = sb.sandboxGpuEnabled ?? (sb.gpuEnabled === true);
    const sandboxGpu = sandboxGpuEnabled ? "enabled" : "disabled";
    const sandboxGpuMode = sb.sandboxGpuMode ? ` (${sb.sandboxGpuMode})` : "";
    const sandboxGpuDevice = sb.sandboxGpuDevice ? ` device=${sb.sandboxGpuDevice}` : "";
    const openshellDriver = sb.openshellDriver || "unknown";
    const openshellVersion = sb.openshellVersion || "unknown";
    console.log(`    Host GPU: ${hostGpu}`);
    console.log(`    Sandbox GPU: ${sandboxGpu}${sandboxGpuMode}${sandboxGpuDevice}`);
    console.log(`    OpenShell: ${openshellVersion} (${openshellDriver})`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);

    // Active session indicator
    try {
      const opsBinStatus = resolveOpenshell();
      if (opsBinStatus) {
        const sessionResult = getActiveSandboxSessions(
          sandboxName,
          createSessionDeps(opsBinStatus),
        );
        if (sessionResult.detected) {
          const count = sessionResult.sessions.length;
          console.log(
            `    Connected: ${count > 0 ? `${G}yes${R} (${count} session${count > 1 ? "s" : ""})` : "no"}`,
          );
        }
      }
    } catch {
      /* non-fatal */
    }

    if (shields.isShieldsDown(sandboxName, true)) {
      console.log("    Permissions: shields down (check `shields status` for details)");
    }

    // Agent version check
    try {
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName, { skipProbe: true });
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.sandboxVersion) {
        console.log(`    Agent:    ${agentName} v${versionCheck.sandboxVersion}`);
      }
      if (versionCheck.isStale) {
        console.log(`    ${YW}Update:   v${versionCheck.expectedVersion} available${R}`);
        console.log(`              Run \`${CLI_NAME} ${sandboxName} rebuild\` to upgrade`);
      }
    } catch {
      /* non-fatal */
    }
  }

  if (lookup.state === "present") {
    console.log("");
    if ("recoveredGateway" in lookup && lookup.recoveredGateway) {
      console.log(
        `  Recovered ${CLI_DISPLAY_NAME} gateway runtime via ${("recoveryVia" in lookup ? lookup.recoveryVia : null) || "gateway reattach"}.`,
      );
      console.log("");
    }
    console.log(lookup.output);
    const phase = parseSandboxPhase(lookup.output || "");
    if (phase && phase !== "Ready") {
      console.log("");
      console.log(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
      console.log(
        "  This usually happens when a process crash inside the sandbox prevented clean startup.",
      );
      console.log("");
      console.log(
        `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
      );
    }
  } else if (lookup.state === "wrong_gateway_active") {
    const activeGateway =
      "activeGateway" in lookup && typeof lookup.activeGateway === "string"
        ? lookup.activeGateway
        : undefined;
    console.log("");
    printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.log);
    process.exit(1);
  } else if (lookup.state === "missing") {
    // Belt-and-suspenders: only destroy registry state if the nemoclaw gateway
    // is demonstrably the healthy active gateway. Guards against regressions
    // in the reconciler.
    const guard = getNamedGatewayLifecycleState();
    if (guard.state !== "healthy_named") {
      console.log("");
      if (guard.state === "connected_other") {
        printWrongGatewayActiveGuidance(sandboxName, guard.activeGateway, console.log);
      } else {
        printGatewayLifecycleHint(guard.status || "", sandboxName, console.log);
      }
    } else {
      registry.removeSandbox(sandboxName);
      const session = onboardSession.loadSession();
      if (session && session.sandboxName === sandboxName) {
        onboardSession.updateSession((s: Session) => {
          s.sandboxName = null;
          return s;
        });
      }
      console.log("");
      console.log(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
      console.log("  Removed stale local registry entry.");
    }
    process.exit(1);
  } else if (lookup.state === "identity_drift") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.log(
      `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
    );
    process.exit(1);
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.log(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.log(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    process.exit(1);
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
    process.exit(1);
  }

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    const running = await isSandboxGatewayRunningForStatus(sandboxName);
    if (running !== null) {
      const sessionAgent = agentRuntime.getSessionAgent(sandboxName);
      const sessionAgentName = agentRuntime.getAgentDisplayName(sessionAgent);
      if (running) {
        console.log(`    ${sessionAgentName}: ${G}running${R}`);
      } else {
        console.log(`    ${sessionAgentName}: ${RD}not running${R}`);
        console.log("");
        console.log(
          `  The sandbox is alive but the ${sessionAgentName} gateway process is not running.`,
        );
        console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
        console.log("");
        console.log("  To recover, run:");
        console.log(`    ${D}${CLI_NAME} ${sandboxName} connect${R}  (auto-recovers on connect)`);
        console.log("  Or manually inside the sandbox:");
        console.log(`    ${D}${agentRuntime.getGatewayCommand(sessionAgent)}${R}`);
      }
    }
  }

  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  if (nim.shouldShowNimLine(sb && sb.nimContainer, nimStat.running)) {
    console.log(
      `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
    );
    if (nimStat.running) {
      console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
    }
  }
  console.log("");
}
