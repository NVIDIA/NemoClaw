// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CaptureOpenshellOptions,
  type CaptureOpenshellResult,
  captureOpenshellCommand,
} from "../adapters/openshell/client";
import { captureOpenshell } from "../adapters/openshell/runtime";
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { observeOpenShellSandboxIdentity } from "../adapters/openshell/sandbox-presence";
import {
  isExplicitMissingOpenShellSandboxOutput,
  isLegacyOpenShellSandboxConfigUnavailableOutput,
} from "../adapters/openshell/sandbox-observer-cli";
import { parseSandboxPhase } from "../state/gateway";
import {
  fingerprintSandboxLiveIdentity,
  fingerprintSandboxRecreateValue,
  type SandboxRecreateObservation,
} from "./sandbox-recreate-transaction";

export const SANDBOX_RECREATE_PROBE_TIMEOUT_MS = OPENSHELL_PROBE_TIMEOUT_MS;

export type { CaptureOpenshellOptions, CaptureOpenshellResult };

export function captureSandboxRecreateOpenshellCommand(
  binary: string,
  args: string[],
  options: CaptureOpenshellOptions,
): CaptureOpenshellResult {
  return captureOpenshellCommand(binary, args, options);
}

export interface SandboxRecreateTarget {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
}

export type SandboxGatewayPresence = "present" | "missing";

type SandboxGatewayPresenceTarget = Pick<SandboxRecreateTarget, "sandboxName" | "gatewayName">;

export type SandboxRecreateObserver = (target: SandboxRecreateTarget) => SandboxRecreateObservation;
export type SandboxRecreateCapture = typeof captureOpenshell;

export const isExplicitMissingSandboxGatewayOutput = isExplicitMissingOpenShellSandboxOutput;

/** Resolve a retained legacy identity without treating unreadable config as deletion. */
export function observeLegacySandboxOnGateway(
  target: SandboxGatewayPresenceTarget,
  probe: CaptureOpenshellResult,
  capture: SandboxRecreateCapture,
  options: Parameters<SandboxRecreateCapture>[1],
): SandboxRecreateObservation | null {
  const combined = `${probe.stdout ?? ""}\n${probe.stderr ?? probe.output ?? ""}`.trim();
  if (
    probe.error ||
    probe.signal ||
    probe.status === null ||
    probe.status === 0 ||
    !isLegacyOpenShellSandboxConfigUnavailableOutput(combined)
  )
    return null;
  const gatewayArgs = target.gatewayName ? ["-g", target.gatewayName] : [];
  const inventory = capture(["sandbox", "list", ...gatewayArgs, "-o", "json"], options);
  const listed = observeOpenShellSandboxIdentity(target.sandboxName, inventory);
  if (!inventory.error && !inventory.signal && listed.kind === "present") {
    return {
      state: listed.phase === "Ready" || listed.phase === "Running" ? "ready" : "not_ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue(listed.id),
    };
  }
  throw new Error(
    `Cannot journal sandbox '${target.sandboxName}' replacement: gateway '${target.gatewayName}' reported neither a live sandbox nor explicit absence. Legacy config is unreadable; inventory=${listed.kind}, exit=${String(inventory.status)}, interrupted=${Boolean(inventory.error || inventory.signal)}.`,
  );
}

/** Observe only whether the named sandbox exists on its recorded gateway. */
export function observeSandboxPresenceOnGateway(
  target: SandboxGatewayPresenceTarget,
): SandboxGatewayPresence {
  const probe = captureOpenshell(["sandbox", "get", "-g", target.gatewayName, target.sandboxName], {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const legacy = observeLegacySandboxOnGateway(target, probe, captureOpenshell, {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (legacy) return "present";
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
  const combined = `${stdout}\n${String(probe.stderr ?? probe.output ?? "")}`.trim();
  const failedCleanly =
    !probe.error && !probe.signal && probe.status !== null && probe.status !== 0;
  if (failedCleanly && isExplicitMissingSandboxGatewayOutput(combined, target.sandboxName)) {
    return "missing";
  }
  if (probe.status === 0 && stdout.length > 0) return "present";
  throw new Error(
    `Cannot inspect sandbox '${target.sandboxName}' on gateway '${target.gatewayName}': OpenShell reported neither presence nor explicit absence.`,
  );
}

export function observeSandboxOnGateway(
  target: SandboxRecreateTarget,
  capture: SandboxRecreateCapture = captureOpenshell,
  runtimeSelection?: OpenShellRuntimeSelection,
  timeoutMs?: number,
): SandboxRecreateObservation {
  if (runtimeSelection && runtimeSelection.gatewayName !== target.gatewayName) {
    throw new Error(
      `Cannot journal sandbox '${target.sandboxName}' replacement: selected gateway does not match the recorded target.`,
    );
  }
  const boundedTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(1, Math.min(OPENSHELL_PROBE_TIMEOUT_MS, Math.floor(timeoutMs)))
      : OPENSHELL_PROBE_TIMEOUT_MS;
  const probeDeadlineMs = performance.now() + boundedTimeoutMs;
  const remainingProbeTimeoutMs = (): number =>
    Math.max(1, Math.min(boundedTimeoutMs, Math.floor(probeDeadlineMs - performance.now())));
  const captureOptions = {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: boundedTimeoutMs,
    ...(runtimeSelection
      ? {
          env: buildSelectedOpenShellSubprocessEnv(runtimeSelection),
          replaceEnv: true,
        }
      : {}),
  } as const;
  const probe = capture(
    ["sandbox", "get", "-g", target.gatewayName, target.sandboxName],
    captureOptions,
  );
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
  const combined = `${stdout}\n${String(probe.stderr ?? probe.output ?? "")}`.trim();
  const failedCleanly =
    !probe.error && !probe.signal && probe.status !== null && probe.status !== 0;
  const legacy = observeLegacySandboxOnGateway(target, probe, capture, {
    ...captureOptions,
    timeout: timeoutMs === undefined ? boundedTimeoutMs : remainingProbeTimeoutMs(),
  });
  if (legacy) return legacy;
  if (failedCleanly && isExplicitMissingSandboxGatewayOutput(combined, target.sandboxName)) {
    return { state: "missing", liveIdentityFingerprint: null };
  }
  if (probe.status === 0 && stdout.length > 0) {
    const liveIdentityFingerprint = fingerprintSandboxLiveIdentity(stdout);
    if (!liveIdentityFingerprint) {
      throw new Error(
        `Cannot journal sandbox '${target.sandboxName}' replacement: OpenShell did not report a stable sandbox Id on gateway '${target.gatewayName}'.`,
      );
    }
    const phase = parseSandboxPhase(combined);
    return {
      state: phase === "Ready" || phase === "Running" ? "ready" : "not_ready",
      liveIdentityFingerprint,
    };
  }
  throw new Error(
    `Cannot journal sandbox '${target.sandboxName}' replacement: gateway '${target.gatewayName}' reported neither a live sandbox nor explicit absence.`,
  );
}
