// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  describeGatewayOwner,
  evaluateGatewayAttachment,
  type GatewayAttachmentProbe,
  type GatewayOwner,
  type GatewayOwnerDescription,
  GatewayOwnershipError,
  type GatewayOwnershipFailureCode,
  isExternallySupervised,
} from "../onboard/gateway-ownership";
import type { GatewayReuseState } from "../state/gateway";
import { sanitizeReadinessText } from "./sanitize";
import type {
  EvidenceScalar,
  ReadinessCapability,
  ReadinessEvidence,
  ReadinessFinding,
  ReadinessObservation,
  ReadinessState,
} from "./types";

const DEFAULT_MAX_AGE_MS = 30_000;
const MAX_REPORT_TEXT_LENGTH = 1024;
const projectionSnapshots = new WeakMap<
  GatewayReadinessProjection,
  Readonly<GatewayObservationSnapshot>
>();

export type GatewayAttachmentState = "verified" | "rejected" | "not-applicable" | "unknown";
export type GatewayDriftState = "detected" | "not-detected" | "not-applicable" | "unknown";
export type GatewayPortConflictState =
  | "none"
  | "occupied"
  | "multiple-owners"
  | "owner-mismatch"
  | "unknown";
export type GatewayReuseObservation = GatewayReuseState | "not-applicable" | "unknown";

export interface ManagedGatewayObservations {
  reuseState: GatewayReuseState | "unknown";
  driftState: Exclude<GatewayDriftState, "not-applicable">;
  portConflictState: GatewayPortConflictState;
  portConflictDetail?: string;
}

export interface GatewayReadinessDependencies {
  resolveOwner(): GatewayOwner;
  probeAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
  observeManagedGateway(owner: GatewayOwner): Promise<ManagedGatewayObservations>;
}

export interface GatewayObservations {
  owner: GatewayOwnerDescription;
  attachmentState: GatewayAttachmentState;
  attachmentFailureCode?: GatewayOwnershipFailureCode;
  attachmentFailure?: string;
  reuseState: GatewayReuseObservation;
  driftState: GatewayDriftState;
  portConflictState: GatewayPortConflictState;
  portConflictDetail?: string;
}

export interface GatewayObservationSnapshot {
  observedAt: string;
  observations?: Readonly<GatewayObservations>;
  failure?: string;
  authorityFailure?: boolean;
  reusable?: boolean;
}

export interface CollectGatewayObservationsOptions {
  now?: () => Date;
}

export interface ProjectGatewayReadinessOptions {
  now?: () => Date;
  maxObservationAgeMs?: number;
}

export type CreateGatewayReadinessProjectionOptions = CollectGatewayObservationsOptions &
  ProjectGatewayReadinessOptions;

export interface GatewayReadinessProjection {
  observations: ReadinessObservation[];
  capabilities: ReadinessCapability[];
  findings: ReadinessFinding[];
  evidence: ReadinessEvidence[];
}

function safeReportText(value: string): string {
  return sanitizeReadinessText(value, MAX_REPORT_TEXT_LENGTH);
}

function safeOwnerFailureText(value: string, owner: GatewayOwner): string {
  const withoutPrivateState = owner.stateDir
    ? value.split(owner.stateDir).join("<gateway-state>")
    : value;
  return safeReportText(withoutPrivateState);
}

function conflictFromAttachmentFailure(
  code: GatewayOwnershipFailureCode,
): GatewayPortConflictState {
  if (code === "multiple_owners") return "multiple-owners";
  if (code === "identity_mismatch") return "owner-mismatch";
  return "unknown";
}

function rejectedAttachment(
  owner: GatewayOwner,
  code: GatewayOwnershipFailureCode,
  message: string,
): GatewayObservations {
  return {
    owner: describeGatewayOwner(owner),
    attachmentState: "rejected",
    attachmentFailureCode: code,
    attachmentFailure: safeOwnerFailureText(message, owner),
    reuseState: "not-applicable",
    driftState: "not-applicable",
    portConflictState: conflictFromAttachmentFailure(code),
  };
}

export async function collectGatewayObservations(
  deps: GatewayReadinessDependencies,
  options: CollectGatewayObservationsOptions = {},
): Promise<GatewayObservationSnapshot> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  let owner: GatewayOwner;
  try {
    owner = deps.resolveOwner();
  } catch {
    return {
      observedAt,
      failure: "Gateway lifecycle authority could not be resolved before lifecycle effects.",
      authorityFailure: true,
      reusable: false,
    };
  }

  if (isExternallySupervised(owner)) {
    try {
      const result = evaluateGatewayAttachment(owner, await deps.probeAttachment(owner));
      if (!result.ok) {
        return {
          observedAt,
          observations: rejectedAttachment(owner, result.code, result.message),
          reusable: false,
        };
      }
      return {
        observedAt,
        observations: {
          owner: describeGatewayOwner(owner),
          attachmentState: "verified",
          reuseState: "not-applicable",
          driftState: "not-applicable",
          portConflictState: "none",
        },
        reusable: false,
      };
    } catch (error) {
      if (error instanceof GatewayOwnershipError) {
        return {
          observedAt,
          observations: rejectedAttachment(owner, error.code, error.message),
          reusable: false,
        };
      }
      return {
        observedAt,
        observations: {
          owner: describeGatewayOwner(owner),
          attachmentState: "unknown",
          reuseState: "not-applicable",
          driftState: "not-applicable",
          portConflictState: "unknown",
        },
        failure: "The externally supervised gateway attachment probe failed safely.",
        reusable: false,
      };
    }
  }

  try {
    const managed = await deps.observeManagedGateway(owner);
    return {
      observedAt,
      observations: {
        owner: describeGatewayOwner(owner),
        attachmentState: "not-applicable",
        reuseState: managed.reuseState,
        driftState: managed.driftState,
        portConflictState: managed.portConflictState,
        portConflictDetail: managed.portConflictDetail
          ? safeReportText(managed.portConflictDetail)
          : undefined,
      },
      reusable: false,
    };
  } catch {
    return {
      observedAt,
      observations: {
        owner: describeGatewayOwner(owner),
        attachmentState: "not-applicable",
        reuseState: "unknown",
        driftState: "unknown",
        portConflictState: "unknown",
      },
      failure: "Managed gateway observations could not be collected safely.",
      reusable: false,
    };
  }
}

function observation(
  id: string,
  value: EvidenceScalar | undefined,
  evidenceIds: readonly string[],
): ReadinessObservation {
  return value === undefined || value === "unknown"
    ? { id, state: "unknown", evidenceIds }
    : { id, state: "present", value, evidenceIds };
}

function capability(
  id: string,
  state: ReadinessState,
  evidenceIds: readonly string[],
): ReadinessCapability {
  return { id, state, evidenceIds };
}

function finding(
  id: string,
  severity: ReadinessFinding["severity"],
  summary: string,
  capabilityIds: readonly string[],
  evidenceIds: readonly string[],
): ReadinessFinding {
  return { id, severity, summary, capabilityIds, evidenceIds };
}

const ATTACHMENT_FINDING_IDS: Record<GatewayOwnershipFailureCode, string> = {
  external_supervision_forbids_effect: "gateway.attachment.effect_forbidden",
  gateway_unreachable: "gateway.attachment.unreachable",
  supervisor_inactive: "gateway.supervisor.inactive",
  identity_mismatch: "gateway.ownership.mismatch",
  unknown_listener: "gateway.ownership.unverified",
  multiple_owners: "gateway.ownership.multiple",
  endpoint_port_mismatch: "gateway.endpoint.port_mismatch",
  gateway_registration_failed: "gateway.registration.failed",
  capability_unsupported: "gateway.capability.unsupported",
};

function unknownProjection(
  snapshot: Readonly<GatewayObservationSnapshot>,
  stale = false,
): GatewayReadinessProjection {
  const evidenceIds = [
    ...(snapshot.failure ? ["gateway.probe.failure"] : []),
    ...(stale ? ["gateway.probe.stale"] : []),
  ];
  const capabilityIds = [
    "gateway.authority.resolved",
    "gateway.attachment.valid",
    "gateway.reuse.ready",
    "gateway.version.compatible",
    "gateway.port.uncontested",
  ];
  const projection: GatewayReadinessProjection = {
    observations: [
      "gateway.management.mode",
      "gateway.owner.name",
      "gateway.owner.source",
      "gateway.owner.port",
      "gateway.attachment",
      "gateway.reuse",
      "gateway.version_drift",
      "gateway.port_conflict",
    ].map((id) => ({ id, state: "unknown", evidenceIds })),
    capabilities: capabilityIds.map((id) => ({ id, state: "unknown", evidenceIds })),
    findings: [
      finding(
        snapshot.authorityFailure ? "gateway.authority.invalid" : "gateway.probe.inconclusive",
        snapshot.authorityFailure ? "blocking" : "warning",
        snapshot.authorityFailure
          ? "Gateway lifecycle authority could not be resolved safely."
          : "Gateway observations could not be collected safely.",
        snapshot.authorityFailure ? ["gateway.authority.resolved"] : capabilityIds,
        evidenceIds,
      ),
    ],
    evidence: [
      ...(snapshot.failure
        ? [{ id: "gateway.probe.failure", summary: safeReportText(snapshot.failure) }]
        : []),
      ...(stale
        ? [
            {
              id: "gateway.probe.stale",
              summary: "Gateway observations exceeded their safe reuse window.",
            },
          ]
        : []),
    ],
  };
  projectionSnapshots.set(projection, snapshot);
  return projection;
}

function ownerEvidence(owner: GatewayOwnerDescription): ReadinessEvidence {
  return {
    id: "gateway.owner",
    summary: "Resolved gateway lifecycle authority.",
    details: {
      gatewayName: safeReportText(owner.gatewayName),
      gatewayPort: owner.gatewayPort,
      mode: owner.mode,
      source: owner.source,
      endpoint: owner.endpoint ? safeReportText(owner.endpoint) : null,
      supervisorKind: owner.supervisor?.kind ?? null,
      supervisorService: owner.supervisor ? safeReportText(owner.supervisor.serviceName) : null,
      supervisorExecPath: owner.supervisor ? safeReportText(owner.supervisor.execPath) : null,
      requiredCapabilities: safeReportText(owner.requiredCapabilities.join(",")),
    },
  };
}

/** Re-evaluate the original snapshot after another readiness collection. */
export function refreshGatewayReadinessProjection(
  projection: GatewayReadinessProjection,
  options: ProjectGatewayReadinessOptions = {},
): GatewayReadinessProjection {
  const snapshot = projectionSnapshots.get(projection);
  return snapshot ? projectGatewayReadiness(snapshot, options) : projection;
}

export function projectGatewayReadiness(
  snapshot: Readonly<GatewayObservationSnapshot>,
  options: ProjectGatewayReadinessOptions = {},
): GatewayReadinessProjection {
  const now = (options.now ?? (() => new Date()))();
  const age = now.getTime() - Date.parse(snapshot.observedAt);
  const stale =
    !Number.isFinite(age) || age < 0 || age > (options.maxObservationAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (stale && snapshot.reusable !== true) return unknownProjection(snapshot, true);

  const gateway = snapshot.observations;
  if (!gateway) return unknownProjection(snapshot);

  const evidence: ReadinessEvidence[] = [ownerEvidence(gateway.owner)];
  const evidenceIds = ["gateway.owner"];
  if (snapshot.failure) {
    evidence.push({ id: "gateway.probe.failure", summary: safeReportText(snapshot.failure) });
    evidenceIds.push("gateway.probe.failure");
  }
  if (gateway.attachmentFailure) {
    evidence.push({
      id: "gateway.attachment.failure",
      summary: safeReportText(gateway.attachmentFailure),
    });
    evidenceIds.push("gateway.attachment.failure");
  }
  if (gateway.portConflictDetail) {
    evidence.push({
      id: "gateway.port.conflict",
      summary: safeReportText(gateway.portConflictDetail),
    });
    evidenceIds.push("gateway.port.conflict");
  }

  const external = gateway.owner.mode === "externally-supervised";
  const attachmentState: ReadinessState =
    gateway.attachmentState === "unknown"
      ? "unknown"
      : gateway.attachmentState === "rejected"
        ? "absent"
        : "present";
  const reuseState: ReadinessState =
    gateway.reuseState === "unknown"
      ? "unknown"
      : gateway.reuseState === "healthy" ||
          gateway.reuseState === "missing" ||
          gateway.reuseState === "not-applicable"
        ? "present"
        : "absent";
  const versionState: ReadinessState =
    gateway.driftState === "unknown"
      ? "unknown"
      : gateway.driftState === "detected"
        ? "absent"
        : "present";
  const portState: ReadinessState =
    gateway.portConflictState === "unknown"
      ? "unknown"
      : gateway.portConflictState === "none"
        ? "present"
        : "absent";

  const findings: ReadinessFinding[] = [];
  if (gateway.attachmentState === "rejected" && gateway.attachmentFailureCode) {
    findings.push(
      finding(
        ATTACHMENT_FINDING_IDS[gateway.attachmentFailureCode],
        "blocking",
        "The externally supervised gateway attachment was rejected.",
        ["gateway.attachment.valid", "gateway.port.uncontested"],
        evidenceIds,
      ),
    );
  } else if (gateway.attachmentState === "unknown") {
    findings.push(
      finding(
        "gateway.attachment.inconclusive",
        "warning",
        "The externally supervised gateway attachment could not be verified.",
        ["gateway.attachment.valid", "gateway.port.uncontested"],
        evidenceIds,
      ),
    );
  }

  if (!external) {
    if (gateway.reuseState === "active-unnamed" || gateway.reuseState === "stale") {
      findings.push(
        finding(
          `gateway.reuse.${gateway.reuseState.replace("-", "_")}`,
          "warning",
          "The managed gateway requires reconciliation before reuse.",
          ["gateway.reuse.ready"],
          evidenceIds,
        ),
      );
    } else if (gateway.reuseState === "foreign-active") {
      findings.push(
        finding(
          "gateway.reuse.foreign_active",
          "blocking",
          "A different active gateway conflicts with the configured NemoClaw gateway.",
          ["gateway.reuse.ready", "gateway.port.uncontested"],
          evidenceIds,
        ),
      );
    } else if (gateway.reuseState === "unknown") {
      findings.push(
        finding(
          "gateway.reuse.inconclusive",
          "warning",
          "Managed gateway reuse state could not be determined.",
          ["gateway.reuse.ready"],
          evidenceIds,
        ),
      );
    }

    if (gateway.driftState === "detected") {
      findings.push(
        finding(
          "gateway.version.drift",
          "blocking",
          "The running gateway version does not match the installed OpenShell version.",
          ["gateway.version.compatible"],
          evidenceIds,
        ),
      );
    } else if (gateway.driftState === "unknown") {
      findings.push(
        finding(
          "gateway.version.inconclusive",
          "warning",
          "Gateway version drift could not be determined.",
          ["gateway.version.compatible"],
          evidenceIds,
        ),
      );
    }

    if (gateway.portConflictState !== "none" && gateway.portConflictState !== "unknown") {
      findings.push(
        finding(
          gateway.portConflictState === "multiple-owners"
            ? "gateway.port.multiple_owners"
            : gateway.portConflictState === "owner-mismatch"
              ? "gateway.port.owner_mismatch"
              : "gateway.port.occupied",
          "blocking",
          "The gateway port is held by an incompatible or ambiguous owner.",
          ["gateway.port.uncontested"],
          evidenceIds,
        ),
      );
    } else if (gateway.portConflictState === "unknown") {
      findings.push(
        finding(
          "gateway.port.inconclusive",
          "warning",
          "Gateway port ownership could not be determined.",
          ["gateway.port.uncontested"],
          evidenceIds,
        ),
      );
    }
  }

  const projection: GatewayReadinessProjection = {
    observations: [
      observation("gateway.management.mode", gateway.owner.mode, evidenceIds),
      observation("gateway.owner.name", gateway.owner.gatewayName, evidenceIds),
      observation("gateway.owner.source", gateway.owner.source, evidenceIds),
      observation("gateway.owner.port", gateway.owner.gatewayPort, evidenceIds),
      observation("gateway.attachment", gateway.attachmentState, evidenceIds),
      observation("gateway.reuse", gateway.reuseState, evidenceIds),
      observation("gateway.version_drift", gateway.driftState, evidenceIds),
      observation("gateway.port_conflict", gateway.portConflictState, evidenceIds),
    ],
    capabilities: [
      capability("gateway.authority.resolved", "present", evidenceIds),
      capability("gateway.attachment.valid", attachmentState, evidenceIds),
      capability("gateway.reuse.ready", reuseState, evidenceIds),
      capability("gateway.version.compatible", versionState, evidenceIds),
      capability("gateway.port.uncontested", portState, evidenceIds),
    ],
    findings,
    evidence,
  };
  projectionSnapshots.set(projection, snapshot);
  return projection;
}

/** Collect and project gateway facts against the live post-collection clock. */
export async function createGatewayReadinessProjection(
  deps: GatewayReadinessDependencies,
  options: CreateGatewayReadinessProjectionOptions = {},
): Promise<GatewayReadinessProjection> {
  const now = options.now ?? (() => new Date());
  const snapshot = await collectGatewayObservations(deps, { now });
  return projectGatewayReadiness(snapshot, {
    now,
    maxObservationAgeMs: options.maxObservationAgeMs,
  });
}
