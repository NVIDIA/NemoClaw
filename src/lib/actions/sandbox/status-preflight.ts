// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalSandboxPhase } from "../../state/gateway";
import type * as registry from "../../state/registry";
import {
  classifyGatewayFailure,
  classifySandboxContainerFailure,
  getLayerHeader,
  isDockerDaemonReachable,
  type SandboxContainerFailureResult,
} from "./gateway-failure-classifier";

// Source-of-truth boundary: this module owns the host-level preflight
// classification for `sandbox status` — host docker daemon reachability,
// per-sandbox container state, and dashboard-port conflict. It is the
// durable owner because:
//   - cached registry metadata, the in-sandbox gateway probe, and the
//     host-side provider probe are all unreliable when the local stack
//     is partly down (the provider probe in particular hits the remote
//     endpoint directly and falsely shows "healthy");
//   - OpenShell does not currently expose a single host-driver health
//     RPC that distinguishes these layers, so the classifier has to
//     consult docker info + container state directly;
//   - status.ts intentionally stays the renderer/report adapter; the
//     classifier here lets the human-readable and `--json` paths share
//     identical failure-layer decisions and inference-probe gating.
// Retire this module when OpenShell exposes a unified host-driver
// preflight RPC that returns the same `docker_unreachable`,
// `sandbox_container_stopped`, and `sandbox_dashboard_port_conflict`
// layers; at that point this classifier becomes a thin adapter over
// that RPC and `printGatewayFailureLayerHeader` can move into the
// renderer.

export type SandboxStatusFailureLayer =
  | "docker_unreachable"
  | "sandbox_container_stopped"
  | "sandbox_dashboard_port_conflict";

export interface SandboxStatusPreflightFailure {
  layer: SandboxStatusFailureLayer;
  dockerUnreachable: boolean;
}

export interface SandboxStatusPreflightResult {
  failure: SandboxStatusPreflightFailure | null;
  failureLayer: SandboxStatusFailureLayer | null;
  suppressInferenceProbe: boolean;
  exitCode: 0 | 1;
}

export type DockerInfoProbe = () => boolean;

export type SandboxContainerFailureProbe = (
  sandboxName: string,
  dashboardPort: number | null,
) => Promise<SandboxContainerFailureResult | null>;

const defaultSandboxContainerFailureProbe: SandboxContainerFailureProbe = (
  sandboxName,
  dashboardPort,
) => classifySandboxContainerFailure(sandboxName, { dashboardPort });

export interface ClassifySandboxStatusPreflightFailureDeps {
  dockerProbe?: DockerInfoProbe;
  sandboxContainerProbe?: SandboxContainerFailureProbe;
}

export function isDockerDaemonUnreachableForStatus(
  sb: registry.SandboxEntry | null,
  probe: DockerInfoProbe = isDockerDaemonReachable,
): boolean {
  if (!sb || sb.openshellDriver !== "docker") return false;
  return !probe();
}

export async function classifySandboxContainerFailureForStatus(
  sb: registry.SandboxEntry | null,
  probe: SandboxContainerFailureProbe = defaultSandboxContainerFailureProbe,
): Promise<SandboxContainerFailureResult | null> {
  if (!sb || sb.openshellDriver !== "docker") return null;
  return probe(sb.name, sb.dashboardPort ?? null);
}

/**
 * Classify pre-snapshot failure layers (host docker daemon down, per-sandbox
 * container stopped, dashboard port held by foreign listener). Returns null
 * when none apply, including when the sandbox is not on the docker driver or
 * the registry has no entry. Shared between the human-readable status
 * renderer and the `--json` report so both paths gate the inference probe
 * consistently and the JSON path can surface the same failure layer.
 */
export async function classifySandboxStatusPreflightFailure(
  sb: registry.SandboxEntry | null,
  deps: ClassifySandboxStatusPreflightFailureDeps = {},
): Promise<SandboxStatusPreflightFailure | null> {
  if (isDockerDaemonUnreachableForStatus(sb, deps.dockerProbe)) {
    return { layer: "docker_unreachable", dockerUnreachable: true };
  }
  const sandboxFailure = await classifySandboxContainerFailureForStatus(
    sb,
    deps.sandboxContainerProbe,
  );
  if (sandboxFailure) {
    return { layer: sandboxFailure.layer, dockerUnreachable: false };
  }
  return null;
}

/**
 * Shared text/JSON adapter for preflight failures. It owns the projection from
 * classifier result to JSON `failureLayer`, inference-probe suppression, and
 * the text renderer's non-zero exit decision so `status.ts` only renders the
 * returned contract.
 */
export async function getSandboxStatusPreflight(
  sb: registry.SandboxEntry | null,
  deps: ClassifySandboxStatusPreflightFailureDeps = {},
): Promise<SandboxStatusPreflightResult> {
  const failure = await classifySandboxStatusPreflightFailure(sb, deps);
  return {
    failure,
    failureLayer: failure ? failure.layer : null,
    suppressInferenceProbe: failure !== null,
    exitCode: failure ? 1 : 0,
  };
}

/**
 * Preserve terminal OpenShell sandbox phases as the primary user-facing cause
 * only for host-wide Docker daemon outages. A terminal `Failed`/`Error` phase
 * is authoritative enough that docker_unreachable guidance would be misleading
 * (#4428). Per-sandbox stopped-container and dashboard-port-conflict failures
 * are more specific local delivery failures and must remain visible even when
 * OpenShell reports `Phase: Error` (#4515).
 */
export function withoutTerminalPhasePreflight(
  preflight: SandboxStatusPreflightResult,
  phase: string | null,
): SandboxStatusPreflightResult {
  if (!phase || !isTerminalSandboxPhase(phase)) return preflight;
  if (preflight.failureLayer !== "docker_unreachable") return preflight;
  return {
    failure: null,
    failureLayer: null,
    suppressInferenceProbe: preflight.suppressInferenceProbe,
    exitCode: 0,
  };
}

/**
 * Print the exact first-line preflight header. Unlike gateway-level fallback
 * headers this intentionally has no leading indentation because users and
 * tests rely on `docker_unreachable` being the first bytes of status output.
 */
export function printSandboxStatusPreflightHeader(
  preflight: SandboxStatusPreflightResult,
  writer: (message: string) => void = console.log,
): void {
  if (preflight.failure) {
    writer(getLayerHeader(preflight.failure.layer));
  }
}

/**
 * Print the gateway-level failure-layer header for `sandbox status`. The
 * preflight classifier (docker_unreachable, sandbox_container_stopped,
 * sandbox_dashboard_port_conflict) is more specific than the downstream
 * gateway-state classifier. When it already emitted a header, skip the
 * gateway-level fallback entirely to avoid a duplicate `Failure layer:`
 * line in the user-visible output.
 */
export async function printGatewayFailureLayerHeader(
  sandboxName: string,
  alreadyPrintedPreflightLayer: SandboxStatusFailureLayer | null = null,
): Promise<void> {
  if (alreadyPrintedPreflightLayer !== null) return;
  const failure = await classifyGatewayFailure(sandboxName);
  console.log(`  ${getLayerHeader(failure.layer)}`);
}
