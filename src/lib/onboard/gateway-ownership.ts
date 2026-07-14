// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Gateway lifecycle authority (#6576).
 *
 * At every point exactly one component owns the OpenShell gateway lifecycle.
 * This module resolves that owner, decides which lifecycle effects the owner
 * permits, and evaluates whether NemoClaw may attach to a gateway it does not
 * own — all as pure functions, so the decision can be made and tested before
 * any provider, policy, sandbox, or registry effect runs.
 *
 * The failure this prevents: when an external supervisor (for example a
 * platform image's own gateway service) owns the process and NemoClaw silently
 * falls back to launching a standalone gateway, both layers believe they own
 * the same port. One replaces the live listener, the other restarts it, and the
 * host is left with a persistent bind conflict and no authoritative owner.
 * Externally supervised mode therefore never permits a standalone fallback: it
 * attaches and validates, or it fails.
 *
 * Source boundary: OpenShell exposes no gateway capability-discovery endpoint,
 * so `requiredCapabilities` is enforced against what this NemoClaw build
 * implements rather than interrogated from the running gateway. That still
 * fails closed when a newer platform profile declares a capability an older
 * NemoClaw cannot honor, which is the case this contract must not let through.
 * Gateway-side discovery can replace this check when OpenShell reports it.
 */

import type { JsonObject } from "../core/json-types";
import { redactUrl } from "../security/redact";
import {
  type GatewayCapability,
  type GatewayManagementDeclaration,
  type GatewayManagementMode,
  type GatewaySupervisorDeclaration,
  SUPPORTED_GATEWAY_CAPABILITIES,
} from "./gateway-management";

/**
 * Port named by a declared endpoint, defaulting to the scheme's port when the
 * URL omits one. Returns null when no endpoint was declared.
 */
function declaredEndpointPort(endpoint: string | null): number | null {
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * How the owner was established. `declared` means a profile or operator
 * declaration named it; the other two are NemoClaw's own detected defaults when
 * nothing was declared.
 */
export type GatewayOwnerSource = "declared" | "packaged-service" | "standalone";

export interface GatewayOwner {
  mode: GatewayManagementMode;
  source: GatewayOwnerSource;
  /** Present only when declared. */
  endpoint: string | null;
  /** Present only when declared. */
  stateDir: string | null;
  /** Present only for an externally supervised owner. */
  supervisor: GatewaySupervisorDeclaration | null;
  requiredCapabilities: readonly GatewayCapability[];
}

/** Lifecycle effects whose legality depends on who owns the gateway. */
export type GatewayLifecycleEffect =
  | "start"
  | "stop"
  | "restart"
  | "destroy"
  | "replace"
  | "standalone-fallback";

export type GatewayOwnershipFailureCode =
  | "external_supervision_forbids_effect"
  | "gateway_unreachable"
  | "supervisor_inactive"
  | "identity_mismatch"
  | "unknown_listener"
  | "multiple_owners"
  | "endpoint_port_mismatch"
  | "capability_unsupported";

export class GatewayOwnershipError extends Error {
  readonly code: GatewayOwnershipFailureCode;
  readonly owner: GatewayOwner;

  constructor(code: GatewayOwnershipFailureCode, message: string, owner: GatewayOwner) {
    super(message);
    this.name = "GatewayOwnershipError";
    this.code = code;
    this.owner = owner;
  }
}

export interface ResolveGatewayOwnerOptions {
  /** Validated declaration, or null when nothing was declared. */
  declaration: GatewayManagementDeclaration | null;
  /** Whether the packaged canonical gateway user service is installed. */
  hasPackagedService: boolean;
}

/**
 * Establish the single lifecycle authority for this run.
 *
 * A declaration is authoritative. Without one, NemoClaw keeps its historical
 * behavior — prefer the packaged canonical service, otherwise manage a
 * standalone gateway — but the owner is now explicit rather than implied by
 * whichever code path happened to run first.
 */
export function resolveGatewayOwner({
  declaration,
  hasPackagedService,
}: ResolveGatewayOwnerOptions): GatewayOwner {
  if (declaration) {
    return {
      mode: declaration.mode,
      source: "declared",
      endpoint: declaration.endpoint,
      stateDir: declaration.stateDir,
      supervisor: declaration.supervisor,
      requiredCapabilities: declaration.requiredCapabilities,
    };
  }
  return {
    mode: "nemoclaw-managed",
    source: hasPackagedService ? "packaged-service" : "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
}

export function isExternallySupervised(owner: GatewayOwner): boolean {
  return owner.mode === "externally-supervised";
}

function describeEffect(effect: GatewayLifecycleEffect): string {
  switch (effect) {
    case "standalone-fallback":
      return "start a standalone gateway";
    case "replace":
      return "replace the gateway";
    default:
      return `${effect} the gateway`;
  }
}

/**
 * Guard every lifecycle effect against the declared owner. An externally
 * supervised gateway is attached to and validated, never started, stopped, or
 * replaced — including via the standalone fallback.
 *
 * Callers must invoke this before the effect, not after.
 */
export function assertGatewayEffectAllowed(
  owner: GatewayOwner,
  effect: GatewayLifecycleEffect,
): void {
  if (!isExternallySupervised(owner)) return;
  const supervisor = owner.supervisor?.serviceName ?? "an external supervisor";
  throw new GatewayOwnershipError(
    "external_supervision_forbids_effect",
    `Refusing to ${describeEffect(effect)}: the gateway lifecycle is owned by ${supervisor}. ` +
      "NemoClaw attaches to an externally supervised gateway but never manages its process. " +
      "Fix the supervisor, or declare mode nemoclaw-managed to hand the lifecycle back to NemoClaw.",
    owner,
  );
}

/** Observations about the running gateway, gathered before any effect. */
export interface GatewayAttachmentProbe {
  /**
   * The port this NemoClaw process is configured to operate the gateway on.
   * Every downstream consumer — sandbox bridge, registry, dashboard forwards —
   * is bound to it, so a declaration naming a different port is a
   * misconfiguration rather than a second gateway to probe.
   */
  gatewayPort: number;
  /** The declared endpoint answered a health check. */
  httpReady: boolean;
  /** Anything at all holds the gateway port. */
  portOccupied: boolean;
  /** Identity-verified gateway processes listening on the port. */
  listenerPids: readonly number[];
  /** False when the listener set could not be authoritatively enumerated. */
  listenerScanComplete: boolean;
  /** Whether the declared supervisor unit reports active; null when unprobeable. */
  supervisorActive: boolean | null;
  /**
   * Executable backing the listening process, when it could be read. A value
   * that disagrees with the declared `execPath` means someone else owns the
   * port.
   */
  listenerExecPath: string | null;
}

export type GatewayAttachmentResult =
  | { ok: true; owner: GatewayOwner }
  | { ok: false; code: GatewayOwnershipFailureCode; message: string };

/**
 * Decide whether NemoClaw may attach to an externally supervised gateway.
 *
 * Every failure here must be raised before provider, policy, sandbox, or
 * registry mutation: an ambiguous or multiply owned gateway is precisely the
 * state that must not be papered over by starting another one.
 */
export function evaluateGatewayAttachment(
  owner: GatewayOwner,
  probe: GatewayAttachmentProbe,
): GatewayAttachmentResult {
  if (!isExternallySupervised(owner)) {
    return { ok: true, owner };
  }

  const supervisorName = owner.supervisor?.serviceName ?? "the declared supervisor";

  // Configuration errors are reported before any runtime observation: probing
  // is only meaningful once we know the declaration describes the gateway this
  // process actually operates on.
  const declaredPort = declaredEndpointPort(owner.endpoint);
  if (declaredPort !== null && declaredPort !== probe.gatewayPort) {
    return {
      ok: false,
      code: "endpoint_port_mismatch",
      message:
        `The declared gateway endpoint uses port ${declaredPort}, but this NemoClaw process operates ` +
        `the gateway on port ${probe.gatewayPort}. Attaching would validate one gateway and then use ` +
        `another. Point the declaration at port ${probe.gatewayPort}, or re-run with ` +
        `NEMOCLAW_GATEWAY_PORT=${declaredPort}.`,
    };
  }

  const unsupported = owner.requiredCapabilities.filter(
    (capability) => !SUPPORTED_GATEWAY_CAPABILITIES.includes(capability),
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: "capability_unsupported",
      message:
        `The declaration requires gateway capability ${unsupported.join(", ")}, which this NemoClaw ` +
        `build does not provide. Onboarding stops before any effect rather than attaching to a gateway ` +
        `it cannot drive as declared.`,
    };
  }

  if (probe.listenerPids.length > 1) {
    return {
      ok: false,
      code: "multiple_owners",
      message:
        `The gateway port has ${probe.listenerPids.length} listening processes, so ownership is ambiguous. ` +
        `Leave exactly one process — the one supervised by ${supervisorName} — and retry.`,
    };
  }

  if (probe.supervisorActive === false) {
    return {
      ok: false,
      code: "supervisor_inactive",
      message:
        `${supervisorName} is not active, and NemoClaw does not start an externally supervised gateway. ` +
        `Start it through the platform supervisor, then re-run onboarding.`,
    };
  }

  if (!probe.portOccupied) {
    return {
      ok: false,
      code: "gateway_unreachable",
      message:
        `No process is listening on the declared gateway endpoint and ${supervisorName} owns its lifecycle. ` +
        `NemoClaw will not start a competing gateway. Bring the supervised gateway up and re-run onboarding.`,
    };
  }

  if (probe.listenerPids.length === 0) {
    return {
      ok: false,
      code: "unknown_listener",
      message:
        `The gateway port is held by a process that is not a recognizable OpenShell gateway. ` +
        `NemoClaw will not attach to it or replace it. Identify the process holding the port, ` +
        `stop only that process, and let ${supervisorName} own the gateway.`,
    };
  }

  if (!probe.listenerScanComplete) {
    return {
      ok: false,
      code: "unknown_listener",
      message:
        `The set of processes holding the gateway port could not be enumerated, so a second gateway ` +
        `cannot be ruled out. NemoClaw fails closed rather than attach to an unproven single owner.`,
    };
  }

  const declaredExecPath = owner.supervisor?.execPath ?? null;
  if (declaredExecPath && probe.listenerExecPath && probe.listenerExecPath !== declaredExecPath) {
    return {
      ok: false,
      code: "identity_mismatch",
      message:
        `The process holding the gateway port does not match the declared gateway identity ` +
        `(running ${probe.listenerExecPath}, declared ${declaredExecPath}). ` +
        `NemoClaw will not attach to an unrecognized gateway.`,
    };
  }

  if (declaredExecPath && !probe.listenerExecPath) {
    return {
      ok: false,
      code: "unknown_listener",
      message:
        `The gateway port is held by a process whose identity could not be verified against ` +
        `the declared gateway (${declaredExecPath}). NemoClaw will not attach to an unverified listener.`,
    };
  }

  if (!probe.httpReady) {
    return {
      ok: false,
      code: "gateway_unreachable",
      message:
        `The gateway supervised by ${supervisorName} is running but did not answer a health check. ` +
        `NemoClaw will not replace it. Check the supervisor and re-run onboarding.`,
    };
  }

  return { ok: true, owner };
}

/**
 * Redacted owner identity for status, read-only diagnostics, and machine
 * events. The declaration cannot carry credentials by construction, but the
 * endpoint still goes through URL redaction so this stays safe if the contract
 * ever widens.
 */
export function describeGatewayOwner(owner: GatewayOwner): JsonObject {
  return {
    mode: owner.mode,
    source: owner.source,
    endpoint: owner.endpoint ? (redactUrl(owner.endpoint) ?? null) : null,
    supervisor: owner.supervisor
      ? {
          kind: owner.supervisor.kind,
          serviceName: owner.supervisor.serviceName,
          execPath: owner.supervisor.execPath,
        }
      : null,
    requiredCapabilities: [...owner.requiredCapabilities],
  };
}
