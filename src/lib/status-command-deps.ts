// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { CaptureOpenshellResult } from "./adapters/openshell/client";
import { captureOpenshellCommand } from "./adapters/openshell/client";
import { resolveOpenshell } from "./adapters/openshell/resolve";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { GATEWAY_PORT } from "./core/ports";
import { getNamedGatewayLifecycleState } from "./gateway-runtime-action";
import { resolveGatewayName } from "./onboard/gateway-binding";
import { getLiveGatewayInference } from "./inference/live";
import type {
  GatewayHealth,
  MessagingBridgeHealth,
  MessagingOverlap,
  ShowStatusCommandDeps,
} from "./inventory";
import { findAllOverlaps } from "./messaging/applier";
import { createBuiltInChannelManifestRegistry } from "./messaging/channels";
import { createBuiltInMessagingHookRegistry, runMessagingHookSync } from "./messaging/hooks";
import type {
  ChannelHookSpec,
  MessagingAgentId,
  MessagingSerializableValue,
} from "./messaging/manifest";
import * as registry from "./state/registry";
import { createSystemDeps, parseSshProcesses } from "./state/sandbox-session";
import { getServiceStatuses, showStatus as showServiceStatus } from "./tunnel/services";

function captureOpenshell(
  rootDir: string,
  args: string[],
  opts: { timeout?: number } = {},
): CaptureOpenshellResult {
  const openshell = resolveOpenshell();
  if (!openshell) {
    return { status: 1, output: "" };
  }
  return captureOpenshellCommand(openshell, args, {
    cwd: rootDir,
    ignoreError: true,
    timeout: opts.timeout,
  });
}

function checkMessagingBridgeHealth(
  rootDir: string,
  sandboxName: string,
  channels: string[],
  agent: string | null | undefined = "openclaw",
): MessagingBridgeHealth[] {
  const channelSet = new Set(Array.isArray(channels) ? channels : []);
  const openshell = resolveOpenshell();
  if (!openshell) return [];

  return runMessagingStatusHooks({
    agent: normalizeMessagingAgentId(agent),
    channels: channelSet,
    currentSandbox: sandboxName,
    registryEntries: safeListRegistryEntries(),
    hookRegistry: createBuiltInMessagingHookRegistry({
      telegram: {
        gatewayConflictStatus: {
          executeSandboxCommand: (name, command, timeoutMs) =>
            executeSandboxCommand(rootDir, openshell, name, command, timeoutMs),
        },
      },
    }),
  }).flatMap(readBridgeHealthOutputs);
}

function findMessagingOverlaps() {
  // Non-critical path: status must remain usable even if overlap detection
  // throws, so any failure yields an empty overlap list.
  try {
    // Report both conflict axes independently and without deduping. They are
    // distinct, both-true facts: a shared messaging credential conflicts on any
    // gateway, while channel-owned status hooks can report non-credential
    // runtime exclusivity such as Slack Socket Mode on one gateway.
    const { sandboxes } = registry.listSandboxes();
    const credentialOverlaps = findAllOverlaps({
      listSandboxes: () => ({ sandboxes }),
    });
    const statusOverlaps = runMessagingStatusHooks({
      agents: uniqueAgentsForEntries(sandboxes),
      registryEntries: sandboxes,
    }).flatMap(readOverlapOutputs);
    return [...credentialOverlaps, ...statusOverlaps];
  } catch {
    return [];
  }
}

function normalizeMessagingAgentId(agent: string | null | undefined): MessagingAgentId {
  return agent === "hermes" ? "hermes" : "openclaw";
}

interface MessagingStatusHookRunOptions {
  readonly agent?: MessagingAgentId;
  readonly agents?: ReadonlySet<MessagingAgentId>;
  readonly channels?: ReadonlySet<string>;
  readonly currentSandbox?: string;
  readonly registryEntries?: readonly registry.SandboxEntry[];
  readonly hookRegistry?: ReturnType<typeof createBuiltInMessagingHookRegistry>;
}

type MessagingStatusHookRunResult = {
  readonly channelId: string;
  readonly hookId: string;
  readonly outputs: ReturnType<typeof runMessagingHookSync>["outputs"];
};

function runMessagingStatusHooks(
  options: MessagingStatusHookRunOptions,
): MessagingStatusHookRunResult[] {
  const hookRegistry = options.hookRegistry ?? createBuiltInMessagingHookRegistry();
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const agents: ReadonlySet<MessagingAgentId> = options.agent
    ? new Set<MessagingAgentId>([options.agent])
    : (options.agents ?? new Set<MessagingAgentId>(["openclaw"]));
  const hookResults: MessagingStatusHookRunResult[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    for (const manifest of manifestRegistry.listAvailable({ agent })) {
      if (options.channels && !options.channels.has(manifest.id)) continue;
      for (const hook of manifest.hooks) {
        if (!shouldRunStatusHook(hook, agent)) continue;
        const key = `${manifest.id}\0${hook.id}\0${hook.handler}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const result = runMessagingHookSync(hook, hookRegistry, {
            channelId: manifest.id,
            inputs: createMessagingStatusHookInputs(options),
          });
          hookResults.push({
            channelId: manifest.id,
            hookId: hook.id,
            outputs: result.outputs,
          });
        } catch {
          // Status hooks are advisory; a broken hook must not hide the rest of
          // `nemoclaw status`.
        }
      }
    }
  }
  return hookResults;
}

function shouldRunStatusHook(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return hook.phase === "status" && (!hook.agents || hook.agents.includes(agent));
}

function executeSandboxCommand(
  rootDir: string,
  openshell: string,
  sandboxName: string,
  command: string,
  timeoutMs: number,
): {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
} | null {
  try {
    const result = spawnSync(
      openshell,
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", command],
      { cwd: rootDir, encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch {
    return null;
  }
}

function createMessagingStatusHookInputs(
  options: MessagingStatusHookRunOptions,
): Record<string, MessagingSerializableValue> {
  const inputs: Record<string, MessagingSerializableValue> = {};
  if (options.currentSandbox) inputs.currentSandbox = options.currentSandbox;
  if (options.registryEntries) {
    inputs.registryEntries = options.registryEntries.map(serializeRegistryEntry);
  }
  return inputs;
}

function serializeRegistryEntry(entry: registry.SandboxEntry): MessagingSerializableValue {
  return {
    name: entry.name,
    gatewayName: entry.gatewayName ?? null,
    messaging: entry.messaging?.plan
      ? {
          plan: entry.messaging.plan as unknown as MessagingSerializableValue,
        }
      : null,
  };
}

function safeListRegistryEntries(): readonly registry.SandboxEntry[] {
  try {
    return registry.listSandboxes().sandboxes;
  } catch {
    return [];
  }
}

function uniqueAgentsForEntries(
  entries: readonly registry.SandboxEntry[],
): ReadonlySet<MessagingAgentId> {
  const agents = new Set<MessagingAgentId>();
  for (const entry of entries) {
    agents.add(normalizeMessagingAgentId(entry.agent));
  }
  if (agents.size === 0) agents.add("openclaw");
  return agents;
}

function readBridgeHealthOutputs(result: MessagingStatusHookRunResult): MessagingBridgeHealth[] {
  return Object.values(result.outputs).flatMap((output) => {
    if (output.kind !== "status" || !isObjectRecord(output.value)) return [];
    if (output.value.type !== "messaging-bridge-health") return [];
    const channel = stringField(output.value.channel) ?? result.channelId;
    const conflicts = numberField(output.value.conflicts);
    return conflicts > 0 ? [{ channel, conflicts }] : [];
  });
}

function readOverlapOutputs(result: MessagingStatusHookRunResult): MessagingOverlap[] {
  return Object.values(result.outputs).flatMap((output) => {
    if (output.kind !== "status" || !isObjectRecord(output.value)) return [];
    if (output.value.type !== "messaging-overlaps" || !Array.isArray(output.value.overlaps)) {
      return [];
    }
    return output.value.overlaps.flatMap((entry) => {
      if (!isObjectRecord(entry) || !isStringPair(entry.sandboxes)) return [];
      return [
        {
          channel: stringField(entry.channel) ?? result.channelId,
          sandboxes: entry.sandboxes,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
          ...(typeof entry.message === "string" ? { message: entry.message } : {}),
        },
      ];
    });
  });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGatewayLog(rootDir: string, sandboxName: string): string | null {
  const openshell = resolveOpenshell();
  if (!openshell) return null;
  try {
    const result = spawnSync(
      openshell,
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-c",
        "tail -n 10 /tmp/gateway.log 2>/dev/null",
      ],
      { cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = (result.stdout || "").trim();
    return output || null;
  } catch {
    return null;
  }
}

function probeGatewayHealth(): GatewayHealth {
  try {
    const expectedGateway = resolveGatewayName(GATEWAY_PORT);
    const lifecycle = getNamedGatewayLifecycleState(expectedGateway);
    if (lifecycle.state === "healthy_named") {
      return { healthy: true, state: lifecycle.state };
    }
    const reasonByState: Record<string, string> = {
      named_unreachable: "host port held or container not running",
      named_unhealthy: "named gateway present but not Connected",
      connected_other: `connected to '${lifecycle.activeGateway ?? "unknown"}', not '${expectedGateway}'`,
      missing_named: "named gateway not configured",
    };
    return {
      healthy: false,
      state: lifecycle.state,
      reason: reasonByState[lifecycle.state],
    };
  } catch {
    // A transient probe failure must not mask a real gateway problem, but
    // we also can't claim it's unhealthy when we genuinely couldn't tell.
    // Report it as a soft degraded state so the user still sees a hint.
    return { healthy: false, state: "probe_error", reason: "could not reach OpenShell CLI" };
  }
}

export function buildStatusCommandDeps(rootDir: string): ShowStatusCommandDeps {
  const opsBin = resolveOpenshell();
  const sessionDeps = opsBin ? createSystemDeps(opsBin) : null;
  // Cache the SSH process probe once per command invocation — avoids
  // spawning ps per sandbox row. #2604; mirrors buildListCommandDeps.
  let cachedSshOutput: string | null | undefined;
  const getCachedSshOutput = (): string | null => {
    if (cachedSshOutput === undefined && sessionDeps) {
      try {
        cachedSshOutput = sessionDeps.getSshProcesses();
      } catch {
        cachedSshOutput = null;
      }
    }
    return cachedSshOutput ?? null;
  };

  return {
    listSandboxes: () => registry.listSandboxes(),
    getLiveInference: () =>
      getLiveGatewayInference(
        (args, opts) =>
          captureOpenshell(rootDir, args, {
            timeout: opts?.timeout,
          }),
        { timeout: OPENSHELL_PROBE_TIMEOUT_MS },
      ).inference,
    showServiceStatus,
    getServiceStatuses,
    getGatewayHealth: probeGatewayHealth,
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            return parseSshProcesses(sshOutput, name).length;
          } catch {
            return null;
          }
        }
      : undefined,
    checkMessagingBridgeHealth: (sandboxName, channels, agent) =>
      checkMessagingBridgeHealth(rootDir, sandboxName, channels, agent),
    findMessagingOverlaps,
    readGatewayLog: (sandboxName) => readGatewayLog(rootDir, sandboxName),
    log: console.log,
  };
}
