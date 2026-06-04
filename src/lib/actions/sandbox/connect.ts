// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import {
  OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import { getNamedGatewayLifecycleState } from "../../gateway-runtime-action";
import {
  parseGatewayInference,
  planInferenceRouteReconcile,
  sanitizeRouteValueForDisplay,
} from "../../inference/config";
import { findReachableOllamaHost, probeLocalProviderHealth } from "../../inference/local";
import {
  ensureOllamaAuthProxy,
  probeOllamaAuthProxyHealth,
} from "../../inference/ollama/proxy";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../onboard/env";
import { isWsl } from "../../platform";
import { ROOT } from "../../runner";
import * as sandboxVersion from "../../sandbox/version";
import {
  isTerminalSandboxPhase,
  parseSandboxPhase,
  TERMINAL_SANDBOX_PHASES,
} from "../../state/gateway";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { runSetupDnsProxy } from "../dns";
import { preflightVllmModelEnvOrExit } from "./connect-vllm-preflight";
import {
  isDockerRuntimeDown,
  printDockerRuntimeDownGuidance,
} from "./gateway-failure-classifier";
import { ensureLiveSandboxOrExit, printGatewayLifecycleHint } from "./gateway-state";
import { checkAndRecoverSandboxProcesses } from "./process-recovery";
import {
  applyOpenShellVmDnsMonkeypatch,
  shouldApplyVmDnsMonkeypatch,
} from "./vm-dns-monkeypatch";

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

export type SandboxConnectOptions = {
  probeOnly?: boolean;
};

type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
};

type SandboxListProbe = {
  status: number | null;
  output: string;
};

type SandboxInferenceRouteProbe = {
  healthy: boolean;
  broken: boolean;
  detail: string;
};

type SandboxInferenceRouteEnsureResult = {
  sandbox: SandboxEntry | null;
  routeHealthy: boolean | null;
};

type InferenceRouteProbeOptions = {
  attempts?: number;
  delayMs?: number;
};

const INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS = 3;
const INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS = 2_000;

const SANDBOX_CONNECT_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--probe-only",
  "--help",
  "-h",
]);

export function isSandboxConnectFlag(arg: string | undefined): boolean {
  return typeof arg === "string" && SANDBOX_CONNECT_FLAGS.has(arg);
}

export function printSandboxConnectHelp(sandboxName = "<name>"): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} ${sandboxName} connect [--probe-only]`);
  console.log("");
  console.log("  Options:");
  console.log(
    "    --probe-only                    Run recovery checks and exit without opening SSH",
  );
  console.log("    -h, --help                      Show this help");
  console.log("");
}

export function parseSandboxConnectArgs(
  sandboxName: string,
  actionArgs: string[],
): SandboxConnectOptions {
  const options: SandboxConnectOptions = {};
  for (const arg of actionArgs) {
    if (!isSandboxConnectFlag(arg)) {
      console.error(`  Unknown flag for connect: ${arg}`);
      printSandboxConnectHelp(sandboxName);
      process.exit(1);
    }
    switch (arg) {
      case "--dangerously-skip-permissions":
        console.error("  --dangerously-skip-permissions was removed; use shields commands instead.");
        printSandboxConnectHelp(sandboxName);
        process.exit(1);
        break;
      case "--probe-only":
        options.probeOnly = true;
        break;
      case "--help":
      case "-h":
        printSandboxConnectHelp(sandboxName);
        process.exit(0);
        break;
    }
  }
  return options;
}

function runSandboxConnectProbe(sandboxName: string): void {
  const processCheck = checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);
  if (!processCheck.checked) {
    console.error(
      `  Probe failed: could not inspect the ${agentName} gateway inside sandbox '${sandboxName}'.`,
    );
    process.exit(1);
  }
  if (processCheck.wasRunning) {
    ensureSandboxInferenceRoute(sandboxName, { quiet: true });
    if (processCheck.forwardRecovered) {
      console.log(
        `  Probe complete: ${agentName} gateway is running in '${sandboxName}'; restored dashboard port forward.`,
      );
    } else {
      console.log(`  Probe complete: ${agentName} gateway is running in '${sandboxName}'.`);
    }
    return;
  }
  if (processCheck.recovered) {
    ensureSandboxInferenceRoute(sandboxName, { quiet: true });
    console.log(`  Probe complete: recovered ${agentName} gateway in '${sandboxName}'.`);
    return;
  }
  ensureSandboxInferenceRoute(sandboxName, { quiet: true });
  console.error(
    `  Probe failed: ${agentName} gateway is not running in '${sandboxName}' and automatic recovery failed.`,
  );
  console.error("  Check /tmp/gateway.log inside the sandbox for details.");
  process.exit(1);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], {
    stdio: "ignore",
    timeout: ms + 1_000,
  });
}

const GATEWAY_UNAVAILABLE_RE =
  /No gateway configured|No active gateway|Connection refused|client error \(Connect\)|tcp connect error|Status:\s*Disconnected/i;

function isBlockingGatewayLifecycle(
  lifecycle: ReturnType<typeof getNamedGatewayLifecycleState>,
): boolean {
  if (lifecycle.state === "named_unreachable" || lifecycle.state === "named_unhealthy") {
    return true;
  }
  return lifecycle.state === "missing_named" && GATEWAY_UNAVAILABLE_RE.test(lifecycle.status || "");
}

function failConnectReadinessGatewayUnavailable(
  sandboxName: string,
  detailOutput = "",
): never {
  console.error("");
  console.error(
    `  OpenShell gateway is not running or unreachable; cannot verify sandbox '${sandboxName}' readiness.`,
  );
  if (detailOutput.trim()) {
    console.error(detailOutput.trimEnd());
    printGatewayLifecycleHint(detailOutput, sandboxName, console.error);
  }
  console.error("  Recovery:");
  console.error("    1. Run: openshell gateway start --name nemoclaw");
  console.error(`    2. If the gateway cannot be restarted, run: ${CLI_NAME} onboard`);
  console.error(`    3. Retry: ${CLI_NAME} ${sandboxName} connect`);
  process.exit(1);
}

function outputShowsGatewayUnavailable(output = ""): boolean {
  return GATEWAY_UNAVAILABLE_RE.test(output);
}

// Fail fast with Docker-outage guidance instead of polling to the readiness
// timeout. Only fires for Docker-driver sandboxes whose `docker info` is
// failing (#4428).
function failConnectReadinessDockerRuntimeDown(sandboxName: string): never {
  console.error("");
  printDockerRuntimeDownGuidance(sandboxName, { writer: console.error, retryCommand: "connect" });
  process.exit(1);
}

function failIfGatewayBlocksConnectReadiness(sandboxName: string): void {
  const lifecycle = getNamedGatewayLifecycleState();
  if (isBlockingGatewayLifecycle(lifecycle)) {
    failConnectReadinessGatewayUnavailable(
      sandboxName,
      lifecycle.status || lifecycle.gatewayInfo || "",
    );
  }
}

function probeSandboxInferenceRoute(
  sandboxName: string,
  { attempts = 1, delayMs = 0 }: InferenceRouteProbeOptions = {},
): SandboxInferenceRouteProbe {
  let lastProbe: SandboxInferenceRouteProbe | null = null;
  const boundedAttempts = Math.max(1, attempts);

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    // Keep the shell string inside the sandbox: curl write-out, body capture,
    // and status classification must run as one bounded probe. sandboxName
    // remains an argv value, so no user input is interpolated into the script.
    const probe = captureOpenshell(
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        "--",
        "sh",
        "-c",
        [
          "OUT=/tmp/nemoclaw-inference-route-probe.out",
          "HTTP_CODE=$(curl -sk -o \"$OUT\" -w '%{http_code}' --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
          "case \"$HTTP_CODE\" in 000|5*) printf 'BROKEN %s ' \"$HTTP_CODE\"; head -c 160 \"$OUT\" 2>/dev/null || true ;; *) printf 'OK %s' \"$HTTP_CODE\" ;; esac",
        ].join("; "),
      ],
      { ignoreError: true, timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS },
    );
    const detail = probe.output.trim();
    lastProbe = {
      healthy: probe.status === 0 && /^OK\s+[0-9]{3}\b/.test(detail),
      broken: /^BROKEN\s+[0-9]{3}\b/.test(detail),
      detail: detail || `openshell sandbox exec exited with status ${String(probe.status)}`,
    };
    if (lastProbe.healthy || attempt === boundedAttempts) return lastProbe;
    sleepSync(delayMs);
  }

  return lastProbe ?? {
    healthy: false,
    broken: false,
    detail: "inference route probe did not run",
  };
}

function shouldUseLegacyDnsProxyRepair(sb: SandboxEntry | null): boolean {
  // The legacy repair patches CoreDNS inside an `openshell-cluster-<name>`
  // container, which only the k3s/kubernetes gateway runs. The docker driver
  // runs the gateway as `nemoclaw-openshell-gateway` with host networking, and
  // the vm driver has no cluster container either, so both recover the route via
  // `openshell inference set` instead of the cluster CoreDNS patch. Mirrors
  // usesGatewayMetadataProbe (snapshot.ts) and the `!== "docker"` guard on the
  // snapshot DNS-proxy step. (#3403)
  const driver = sb?.openshellDriver;
  return driver !== "vm" && driver !== "docker";
}

function buildInferenceSetArgs(provider: string, model: string): string[] {
  const args = [
    "inference",
    "set",
    "--provider",
    provider,
    "--model",
    model,
    "--no-verify",
  ];
  if (["compatible-endpoint", "ollama-local", "vllm-local"].includes(provider)) {
    args.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
  }
  return args;
}

function reapplyVmInferenceRoute(
  sandboxName: string,
  sb: SandboxEntry | null,
): SandboxInferenceRouteProbe | null {
  if (!sb?.provider || !sb.model) return null;
  runOpenshell(buildInferenceSetArgs(sb.provider, sb.model), {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  return probeSandboxInferenceRoute(sandboxName);
}

function repairSandboxInferenceRouteIfNeeded(
  sandboxName: string,
  sb: SandboxEntry | null,
  { quiet = false }: { quiet?: boolean } = {},
): { healthy: boolean; repairAttempted: boolean; detail: string } {
  if (process.env.NEMOCLAW_DISABLE_INFERENCE_ROUTE_REPAIR === "1") {
    return { healthy: true, repairAttempted: false, detail: "route repair disabled" };
  }
  const initialProbe = probeSandboxInferenceRoute(sandboxName);
  if (initialProbe.healthy) {
    return { healthy: true, repairAttempted: false, detail: initialProbe.detail };
  }
  if (!initialProbe.broken) {
    return { healthy: true, repairAttempted: false, detail: initialProbe.detail };
  }

  if (!shouldUseLegacyDnsProxyRepair(sb)) {
    if (shouldApplyVmDnsMonkeypatch(sb)) {
      if (!quiet) {
        console.log("");
        console.log(
          `  inference.local is unavailable inside '${sandboxName}'. Applying OpenShell VM DNS monkeypatch...`,
        );
      }
      const patch = applyOpenShellVmDnsMonkeypatch(sandboxName, sb);
      const patchedProbe = patch.ok ? probeSandboxInferenceRoute(sandboxName, {
        attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
        delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
      }) : null;
      if (patchedProbe?.healthy) {
        if (!quiet) {
          console.log("  inference.local route repaired.");
        }
        return {
          healthy: true,
          repairAttempted: true,
          detail: patchedProbe.detail,
        };
      }
      if (!quiet) {
        if (!patch.ok && patch.reason) {
          console.error(
            `  Warning: OpenShell VM DNS monkeypatch did not apply: ${patch.reason}`,
          );
        } else if (patchedProbe?.broken) {
          console.error(
            "  Warning: OpenShell VM DNS monkeypatch completed but inference.local is still unavailable.",
          );
        }
      }
    }

    if (!quiet) {
      console.log("");
      console.log(`  inference.local is unavailable inside '${sandboxName}'. Reapplying OpenShell inference route...`);
    }
    const finalProbe = reapplyVmInferenceRoute(sandboxName, sb);
    if (!quiet) {
      if (finalProbe?.healthy) {
        console.log("  inference.local route repaired.");
      } else if (finalProbe?.broken) {
        console.error(
          `  Warning: inference.local is still unavailable through the OpenShell ${sb?.openshellDriver || "non-legacy"} gateway path.`,
        );
      }
    }
    if (!finalProbe) {
      return {
        healthy: false,
        repairAttempted: true,
        detail: "missing sandbox provider or model",
      };
    }
    if (!finalProbe.healthy && !finalProbe.broken) {
      return {
        healthy: true,
        repairAttempted: true,
        detail: finalProbe.detail,
      };
    }
    return {
      healthy: finalProbe.healthy,
      repairAttempted: true,
      detail: finalProbe.detail,
    };
  }

  if (!quiet) {
    console.log("");
    console.log(`  inference.local is unavailable inside '${sandboxName}'. Repairing sandbox DNS proxy...`);
  }
  const repair = runSetupDnsProxy(
    { gatewayName: NEMOCLAW_GATEWAY_NAME, sandboxName },
    { log: quiet ? () => undefined : console.log },
  );
  if (repair.exitCode !== 0) {
    if (!quiet) {
      console.error("  Warning: failed to repair sandbox DNS proxy.");
      if (repair.message) console.error(`  ${repair.message}`);
    }
    return {
      healthy: false,
      repairAttempted: true,
      detail: repair.message || initialProbe.detail,
    };
  }

  const repairedProbe = probeSandboxInferenceRoute(sandboxName, {
    attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
    delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
  });
  if (!quiet) {
    if (repairedProbe.healthy) {
      console.log("  inference.local route repaired.");
    } else if (repairedProbe.broken) {
      console.error("  Warning: inference.local is still unavailable after DNS proxy repair.");
    }
  }
  if (!repairedProbe.healthy && !repairedProbe.broken) {
    return {
      healthy: true,
      repairAttempted: true,
      detail: repairedProbe.detail,
    };
  }
  return {
    healthy: repairedProbe.healthy,
    repairAttempted: true,
    detail: repairedProbe.detail,
  };
}

function verifyLocalInferenceRouteDependencies(
  provider: string,
  { quiet = false }: { quiet?: boolean } = {},
): boolean {
  const isOllamaLocal = provider === "ollama-local";
  if (isOllamaLocal) {
    findReachableOllamaHost();
    if (!isWsl()) {
      ensureOllamaAuthProxy();
    }
  }
  const localHealth = probeLocalProviderHealth(provider, {
    skipOllamaAuthProxySubprobe: isOllamaLocal,
  });
  if (!localHealth) return true;
  if (!localHealth.ok) {
    if (!quiet) {
      console.error(`  Error: ${localHealth.detail}`);
    }
    return false;
  }

  if (isOllamaLocal && !isWsl()) {
    const proxyHealth = probeOllamaAuthProxyHealth();
    if (!proxyHealth.ok) {
      if (!quiet) {
        console.error(`  Error: ${proxyHealth.detail}`);
      }
      return false;
    }
  }

  return true;
}

function printUnrecoverableInferenceRoute(
  sandboxName: string,
  sb: SandboxEntry,
  detail: string,
): void {
  console.error(
    `  Error: inference.local is still unavailable inside '${sandboxName}' after DNS and route repair.`,
  );
  console.error(`  Route: ${sb.provider}/${sb.model}`);
  if (detail) {
    console.error(`  Last probe: ${detail}`);
  }
  console.error(`  Run:  ${CLI_NAME} ${sandboxName} doctor`);
  console.error("  Connect is stopping because the sandbox inference route is known to be broken.");
}

function resetManagedInferenceRoute(
  sandboxName: string,
  sb: SandboxEntry,
  { detail, quiet = false }: { detail: string; quiet?: boolean },
): boolean {
  if (!sb.provider || !sb.model) return false;

  if (!verifyLocalInferenceRouteDependencies(sb.provider, { quiet })) {
    if (!quiet) {
      printUnrecoverableInferenceRoute(sandboxName, sb, detail);
    }
    return false;
  }

  if (!quiet) {
    console.log(`  Resetting inference route to ${sb.provider}/${sb.model}.`);
  }
  const resetResult = runOpenshell(buildInferenceSetArgs(sb.provider, sb.model), {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (resetResult.status !== 0) {
    const finalProbe = probeSandboxInferenceRoute(sandboxName, {
      attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
      delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
    });
    if (finalProbe.healthy) {
      if (!quiet) {
        console.log("  inference.local route repaired.");
      }
      return true;
    }

    if (!quiet) {
      console.error("  Error: failed to reset the OpenShell inference route.");
      printUnrecoverableInferenceRoute(sandboxName, sb, finalProbe.detail || detail);
    }
    return false;
  }

  if (!verifyLocalInferenceRouteDependencies(sb.provider, { quiet })) {
    if (!quiet) {
      printUnrecoverableInferenceRoute(sandboxName, sb, detail);
    }
    return false;
  }

  const finalProbe = probeSandboxInferenceRoute(sandboxName, {
    attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
    delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
  });
  if (finalProbe.healthy) {
    if (!quiet) {
      console.log("  inference.local route repaired.");
    }
    return true;
  }

  if (!quiet) {
    printUnrecoverableInferenceRoute(sandboxName, sb, finalProbe.detail);
  }
  return false;
}

function ensureSandboxInferenceRoute(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
): SandboxInferenceRouteEnsureResult {
  let sb: SandboxEntry | null = null;
  try {
    sb = registry.getSandbox(sandboxName);
    if (sb && sb.provider && sb.model) {
      const live = parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
      );
      const plan = planInferenceRouteReconcile(live, { provider: sb.provider, model: sb.model });
      if (plan.kind !== "aligned") {
        if (plan.kind === "diverged") {
          // Shared gateway: re-point loudly (even when quiet) — silent revert was
          // #3726. Values sanitized: registry/gateway strings are untrusted.
          const liveProvider = sanitizeRouteValueForDisplay(plan.live.provider);
          const liveModel = sanitizeRouteValueForDisplay(plan.live.model);
          const recordedRoute = `${sanitizeRouteValueForDisplay(sb.provider)}/${sanitizeRouteValueForDisplay(sb.model)}`;
          console.error(
            `  ${YW}Warning: gateway inference route (${liveProvider}/${liveModel}) ` +
              `differs from the recorded route for sandbox '${sandboxName}' (${recordedRoute}).${R}`,
          );
          console.error(
            `  ${YW}Aligning the gateway to ${recordedRoute}. To keep ` +
              `${liveProvider}/${liveModel}, set it the supported way:${R}`,
          );
          console.error(
            `    ${CLI_NAME} inference set --provider ${liveProvider} --model ${liveModel} --sandbox ${sandboxName}`,
          );
        } else if (!quiet) {
          // plan.kind === "repair": empty gateway, genuine repair — quiet-aware.
          console.log(
            `  Setting inference route to ${sb.provider}/${sb.model} for sandbox '${sandboxName}'`,
          );
        }
        const swapResult = runOpenshell(buildInferenceSetArgs(sb.provider, sb.model), {
          ignoreError: true,
          timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
        });
        if (swapResult.status !== 0 && (plan.kind === "diverged" || !quiet)) {
          console.error(
            `  ${YW}Warning: failed to switch inference route — connect will proceed anyway.${R}`,
          );
        }
      }
      const repairResult = repairSandboxInferenceRouteIfNeeded(sandboxName, sb, { quiet });
      if (!repairResult.healthy && repairResult.repairAttempted) {
        const resetResult = resetManagedInferenceRoute(sandboxName, sb, {
          detail: repairResult.detail,
          quiet,
        });
        return { sandbox: sb, routeHealthy: resetResult };
      }
      return { sandbox: sb, routeHealthy: repairResult.healthy };
    }
  } catch (error) {
    if (sb?.provider && sb.model) {
      const detail = error instanceof Error && error.message ? error.message : String(error);
      if (!quiet) {
        console.error(`  Error: failed to verify or repair inference route: ${detail}`);
        printUnrecoverableInferenceRoute(sandboxName, sb, detail);
      }
      return { sandbox: sb, routeHealthy: false };
    }
  }
  return { sandbox: sb, routeHealthy: null };
}

function ensureSandboxInferenceRouteOrExit(
  sandboxName: string,
  { quiet = false }: { quiet?: boolean } = {},
): SandboxEntry | null {
  const result = ensureSandboxInferenceRoute(sandboxName, { quiet });
  if (result.routeHealthy === false) {
    process.exit(1);
  }
  return result.sandbox;
}

// One-shot, defense-in-depth approval pass for late OpenClaw CLI/webchat
// scope upgrades (NemoClaw#4263). The in-sandbox auto-pair watcher keeps
// approving allowlisted requests in slow-mode for hours after startup; this
// pass covers the case where the watcher has exited or is otherwise stuck
// when the user runs `nemoclaw <sandbox> connect`. The script sources
// `/tmp/nemoclaw-proxy-env.sh` (written by `nemoclaw-start.sh`) so the
// in-sandbox `openclaw devices list` invocation targets the running gateway
// with its token. Approvals then use OpenClaw's local fallback by removing
// OPENCLAW_GATEWAY_URL only from the child env, and apply the same allowlist
// as the startup watcher — `openclaw-control-ui` clients plus `webchat`/`cli`
// modes. Unknown clients are ignored, not approved.
//
// Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing approval
// semantics. In OpenClaw 2026.5.x, a gateway-pinned `devices approve` for a
// scope-upgrade can request the upgraded scopes for its own connection and
// return the pending-scope failure it is trying to resolve. Remove this local
// fallback path when OpenClaw approve can complete scope upgrades through the
// gateway using only operator.pairing.
//
// Failure modes (timeout, sandbox-exec errors, missing openclaw, gateway
// unreachable) are swallowed: the connect flow must not be blocked by a
// best-effort approval. Internal timeouts (2s list + 1s x MAX_APPROVALS
// attempts) fit within the outer spawnSync cap, so a partial-completion
// mid-loop kill cannot strand allowlisted requests within a normal batch.
const CONNECT_AUTO_PAIR_MAX_APPROVALS = 8;
const CONNECT_AUTO_PAIR_TIMEOUT_MS = 12_000;

function runConnectAutoPairApprovalPass(sandboxName: string): void {
  const script = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
OPENCLAW_BIN="$(command -v openclaw)" python3 - <<'PYAPPROVE'
import json
import os
import subprocess
import sys

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
ALLOWED_CLIENTS = {'openclaw-control-ui'}
ALLOWED_MODES = {'webchat', 'cli'}
ALLOWED_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}
MAX_APPROVALS = ${CONNECT_AUTO_PAIR_MAX_APPROVALS}


def requested_scopes(device):
    if 'scopes' in device:
        scopes = device.get('scopes')
    elif 'requestedScopes' in device:
        scopes = device.get('requestedScopes')
    else:
        return set()
    if not isinstance(scopes, list):
        return None
    return {str(scope).strip() for scope in scopes if str(scope or '').strip()}

try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=2,
    )
except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
    sys.exit(0)
if proc.returncode != 0 or not proc.stdout.strip():
    sys.exit(0)
try:
    data = json.loads(proc.stdout)
except ValueError:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
pending = data.get('pending')
if not isinstance(pending, list):
    sys.exit(0)
approved_count = 0
attempted_count = 0
seen_request_ids = set()
for device in pending:
    if attempted_count >= MAX_APPROVALS:
        break
    if not isinstance(device, dict):
        continue
    request_id = device.get('requestId')
    if not request_id or request_id in seen_request_ids:
        continue
    client_id = device.get('clientId', '')
    client_mode = device.get('clientMode', '')
    if client_id not in ALLOWED_CLIENTS and client_mode not in ALLOWED_MODES:
        continue
    scopes = requested_scopes(device)
    if scopes is None or (scopes and not scopes.issubset(ALLOWED_SCOPES)):
        continue
    seen_request_ids.add(request_id)
    approve_env = os.environ.copy()
    approve_env.pop('OPENCLAW_GATEWAY_URL', None)
    approve_env.pop('OPENCLAW_GATEWAY_PORT', None)
    approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)
    attempted_count += 1
    try:
        approve_proc = subprocess.run(
            [OPENCLAW, 'devices', 'approve', request_id, '--json'],
            capture_output=True, text=True, timeout=1, env=approve_env,
        )
        if approve_proc.returncode == 0:
            approved_count += 1
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        continue
PYAPPROVE
exit 0
`;
  try {
    // Best-effort: discard stdout/stderr. Outer cap is sized to cover the
    // internal budget (2s list + 1s × MAX_APPROVALS plus shell/python
    // startup slack) so a wedged sandbox can never block the connect flow.
    spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: CONNECT_AUTO_PAIR_TIMEOUT_MS,
      },
    );
  } catch {
    /* defense-in-depth — never throw from the connect path */
  }
}

function maybeEnsureHermesToolGatewayBroker(sb: SandboxEntry | null): void {
  if (
    !sb ||
    sb.agent !== "hermes" ||
    !Array.isArray(sb.hermesToolGateways) ||
    sb.hermesToolGateways.length === 0
  ) {
    return;
  }
  try {
    const hermesToolGatewayBroker = require("../../hermes-tool-gateway-broker");
    hermesToolGatewayBroker.ensureHermesToolGatewayBrokerForSandboxEntry(sb);
  } catch {
    /* non-fatal — managed-tool calls will surface broker guidance if needed */
  }
}

function exitWithSpawnResult(result: SpawnLikeResult): void {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

export async function connectSandbox(
  sandboxName: string,
  { probeOnly = false }: SandboxConnectOptions = {},
): Promise<void> {
  // probe-only / recover never install or serve a model, so skip the
  // express-vLLM model preflight for them (it only steers the install path
  // and would otherwise hard-exit a recovery on a stale NEMOCLAW_VLLM_MODEL).
  if (!probeOnly) preflightVllmModelEnvOrExit();
  const { isSandboxReady, parseSandboxStatus } = require("../../onboard");
  const live = await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  // Fast-fail on a Docker daemon outage before the probe-only health check and
  // the session/recovery probes below (each can spawn 15s `openshell sandbox
  // exec`/`ssh-config` calls) and before the readiness wait loop. When Docker
  // is down and the sandbox is not yet ready, connect cannot make progress;
  // surface the outage immediately so the user is not left waiting tens of
  // seconds (or killed by an external `timeout`). Terminal phases keep their
  // normal handling below (#4428).
  const livePhase = parseSandboxPhase(live.output || "");
  if (
    livePhase &&
    livePhase !== "Ready" &&
    livePhase !== "Running" &&
    !isTerminalSandboxPhase(livePhase) &&
    isDockerRuntimeDown(sandboxName)
  ) {
    failConnectReadinessDockerRuntimeDown(sandboxName);
  }

  if (probeOnly) {
    return runSandboxConnectProbe(sandboxName);
  }

  // Version staleness check — warn but don't block
  try {
    const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
    if (versionCheck.isStale) {
      for (const line of sandboxVersion.formatStalenessWarning(sandboxName, versionCheck)) {
        console.error(line);
      }
    }
  } catch {
    /* non-fatal — don't block connect on version check failure */
  }

  // Active session hint — inform if already connected in another terminal
  try {
    const opsBinConnect = resolveOpenshell();
    if (opsBinConnect) {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinConnect));
      if (sessionResult.detected && sessionResult.sessions.length > 0) {
        const count = sessionResult.sessions.length;
        console.log(
          `  ${D}Note: ${count} existing SSH session${count > 1 ? "s" : ""} to '${sandboxName}' detected (another terminal).${R}`,
        );
      }
    }
  } catch {
    /* non-fatal — don't block connect on session detection failure */
  }

  checkAndRecoverSandboxProcesses(sandboxName);
  // Ensure Ollama auth proxy is running (recovers from host reboots)
  ensureOllamaAuthProxy();

  let sb: SandboxEntry | null = null;

  const rawTimeout = process.env.NEMOCLAW_CONNECT_TIMEOUT;
  let timeout = 120;
  if (rawTimeout !== undefined) {
    const parsed = parseInt(rawTimeout, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.warn(
        `  Warning: invalid NEMOCLAW_CONNECT_TIMEOUT="${rawTimeout}", using default 120s`,
      );
    } else {
      timeout = parsed;
    }
  }
  const interval = 3;
  const startedAt = Date.now();
  const deadline = startedAt + timeout * 1000;
  const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000);
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const runSandboxList = (): SandboxListProbe => {
    const result = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      timeout: remainingMs(),
    });
    return { status: result.status, output: result.output };
  };

  const listProbe = runSandboxList();
  const listCommandFailed = listProbe.status !== 0;
  if (listCommandFailed) {
    if (outputShowsGatewayUnavailable(listProbe.output)) {
      failConnectReadinessGatewayUnavailable(sandboxName, listProbe.output);
    }
  }
  const list = listProbe.output;
  if (!isSandboxReady(list, sandboxName)) {
    const status = parseSandboxStatus(list, sandboxName);
    if (!listCommandFailed && status && /^unknown$/i.test(status)) {
      failIfGatewayBlocksConnectReadiness(sandboxName);
    }
    if (status && TERMINAL_SANDBOX_PHASES.has(status)) {
      console.error("");
      console.error(`  Sandbox '${sandboxName}' is in '${status}' state.`);
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
      process.exit(1);
    }

    // Probe-disagreement safety net: `sandbox get` may have reported Ready/no
    // phase (so the early guard was skipped) while `sandbox list` shows a
    // non-terminal status. Status is non-terminal here, so re-check Docker and
    // fail fast rather than entering the readiness loop (#4428).
    if (isDockerRuntimeDown(sandboxName)) {
      failConnectReadinessDockerRuntimeDown(sandboxName);
    }

    console.log(`  Waiting for sandbox '${sandboxName}' to be ready...`);
    let ready = false;
    let everSeen = status !== null;
    while (Date.now() < deadline) {
      const sleepFor = Math.min(interval, remainingMs() / 1000);
      if (sleepFor <= 0) break;
      spawnSync("sleep", [String(sleepFor)]);
      const pollProbe = runSandboxList();
      const pollCommandFailed = pollProbe.status !== 0;
      if (pollCommandFailed) {
        if (outputShowsGatewayUnavailable(pollProbe.output)) {
          failConnectReadinessGatewayUnavailable(sandboxName, pollProbe.output);
        }
      }
      const poll = pollProbe.output;
      const elapsed = elapsedSec();
      if (isSandboxReady(poll, sandboxName)) {
        ready = true;
        break;
      }
      const parsedCur = parseSandboxStatus(poll, sandboxName);
      const cur = parsedCur || "unknown";
      if (!pollCommandFailed && parsedCur && /^unknown$/i.test(parsedCur)) {
        failIfGatewayBlocksConnectReadiness(sandboxName);
      }
      if (cur !== "unknown") everSeen = true;
      if (TERMINAL_SANDBOX_PHASES.has(cur)) {
        console.error("");
        console.error(`  Sandbox '${sandboxName}' entered '${cur}' state.`);
        console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
        console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
        process.exit(1);
      }
      // Catch a Docker daemon that dies mid-wait so we stop polling instead of
      // running out the full readiness timeout (#4428).
      if (isDockerRuntimeDown(sandboxName)) {
        failConnectReadinessDockerRuntimeDown(sandboxName);
      }
      if (!everSeen && elapsed >= 30) {
        console.error("");
        console.error(`  Sandbox '${sandboxName}' not found after ${elapsed}s.`);
        console.error("  Check: openshell sandbox list");
        process.exit(1);
      }
      process.stdout.write(`\r    Status: ${cur.padEnd(20)} (${elapsed}s elapsed)`);
    }

    if (!ready) {
      console.error("");
      console.error(`  Timed out after ${timeout}s waiting for sandbox '${sandboxName}'.`);
      console.error("  Check: openshell sandbox list");
      console.error(
        `  Override timeout: NEMOCLAW_CONNECT_TIMEOUT=300 ${CLI_NAME} ${sandboxName} connect`,
      );
      process.exit(1);
    }
    console.log(`\r    Status: ${"Ready".padEnd(20)} (${elapsedSec()}s elapsed)`);
    console.log("  Sandbox is ready. Connecting...");
  }

  // ── Inference route swap (#1248, #3390) ───────────────────────────
  // When the user has multiple sandboxes with different providers, the
  // cluster-wide inference.local route may still point at the other provider.
  // After the sandbox is Ready, verify and recover the route before SSH.
  sb = ensureSandboxInferenceRouteOrExit(sandboxName);
  maybeEnsureHermesToolGatewayBroker(sb);

  // ── Auto-pair late scope-upgrade approval (#4263) ───────────────
  // Defense in depth: even with the in-sandbox watcher running in
  // slow-mode keepalive, a brief approval pass before opening SSH
  // catches any pending allowlisted CLI/webchat scope upgrades that
  // piled up between startup and now (e.g., watcher crashed, watcher
  // deadline exhausted, multi-sandbox gateway contention).
  runConnectAutoPairApprovalPass(sandboxName);

  // Print a one-shot hint before dropping the user into the sandbox
  // shell so a fresh user knows the first thing to type. Without this,
  // `nemoclaw <name> connect` lands on a bare bash prompt and users
  // ask "now what?" — see #465. Suppress the hint when stdout isn't a
  // TTY so scripted callers don't get noise in their pipelines.
  if (
    process.stdout.isTTY &&
    !["1", "true"].includes(String(process.env.NEMOCLAW_NO_CONNECT_HINT || ""))
  ) {
    console.log("");
    const agentName = sb?.agent || "openclaw";
    const agentCmd = agentName === "openclaw" ? "openclaw tui" : agentName;
    console.log(`  ${G}✓${R} Connecting to sandbox '${sandboxName}'`);
    console.log(
      `  ${D}Inside the sandbox, run \`${agentCmd}\` to start chatting with the agent.${R}`,
    );
    console.log(
      `  ${D}Type \`/exit\` to leave the chat, then \`exit\` to return to the host shell.${R}`,
    );
    console.log("");
  }
  const result = spawnSync(getOpenshellBinary(), ["sandbox", "connect", sandboxName], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}
