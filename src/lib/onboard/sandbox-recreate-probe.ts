// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CaptureOpenshellOptions,
  type CaptureOpenshellResult,
  captureOpenshellCommand,
  stripAnsi,
} from "../adapters/openshell/client";
import { captureOpenshell } from "../adapters/openshell/runtime";
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { parseSandboxPhase } from "../state/gateway";
import {
  fingerprintSandboxLiveIdentity,
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

/**
 * Strict absence classifier for destructive owner-gateway reconciliation.
 * Bare NotFound is not sufficient because OpenShell uses it for missing
 * gateways and providers as well as sandboxes.
 */
export function isExplicitMissingSandboxGatewayOutput(
  output: string,
  sandboxName: string,
): boolean {
  const clean = stripAnsi(String(output)).replace(/\r/g, "").trim();
  const exactNoSpec =
    /^(?:error:\s*)?status:\s*Internal,\s*message:\s*["']sandbox has no spec["'](?:,\s*details:\s*\[\])?(?:,\s*metadata:\s*MetadataMap\s*\{\s*\})?$/i;
  if (exactNoSpec.test(clean)) return true;
  // OpenShell can omit the requested name from an owner-scoped lookup.
  // Require both exact structured fields so gateway/provider absence and
  // transport diagnostics remain ambiguous.
  const exactStructuredNotFound =
    /^(?:error:\s*)?(?:×\s*)?code:\s*["']Some requested entity was not found["']\s*,\s*message:\s*["']sandbox not found["']$/i;
  if (exactStructuredNotFound.test(clean)) return true;

  const escapedName = sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namedSandbox = `(?:['\"]${escapedName}['\"]|${escapedName})`;
  return (
    new RegExp(
      `^(?:error:\\s*)?sandbox\\s+${namedSandbox}\\s+(?:(?:is\\s+)?not\\s+(?:found|present)|does\\s+not\\s+exist)[.!]?$`,
      "i",
    ).test(clean) ||
    new RegExp(`^(?:error:\\s*)?no\\s+such\\s+sandbox\\s+${namedSandbox}[.!]?$`, "i").test(clean)
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
): SandboxRecreateObservation {
  if (runtimeSelection && runtimeSelection.gatewayName !== target.gatewayName) {
    throw new Error(
      `Cannot journal sandbox '${target.sandboxName}' replacement: selected gateway does not match the recorded target.`,
    );
  }
  const probe = capture(["sandbox", "get", "-g", target.gatewayName, target.sandboxName], {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    ...(runtimeSelection
      ? {
          env: buildSelectedOpenShellSubprocessEnv(runtimeSelection),
          replaceEnv: true,
        }
      : {}),
  });
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
  const combined = `${stdout}\n${String(probe.stderr ?? probe.output ?? "")}`.trim();
  const failedCleanly =
    !probe.error && !probe.signal && probe.status !== null && probe.status !== 0;
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
