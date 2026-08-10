// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type GatewayAttachmentProbe,
  type GatewayOwner,
  GatewayOwnershipError,
} from "../onboard/gateway-ownership";
import {
  collectGatewayObservations,
  createGatewayReadinessProjection,
  type GatewayReadinessDependencies,
  projectGatewayReadiness,
} from "./gateway";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function managedOwner(): GatewayOwner {
  return {
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
}

function externalOwner(): GatewayOwner {
  return {
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    mode: "externally-supervised",
    source: "declared",
    endpoint: "https://127.0.0.1:8080",
    stateDir: "/var/lib/private-gateway-state",
    supervisor: {
      kind: "systemd-system",
      serviceName: "openshell-gateway.service",
      execPath: "/opt/platform/gatewayd",
    },
    requiredCapabilities: ["gateway.health"],
  };
}

function attachment(overrides: Partial<GatewayAttachmentProbe> = {}): GatewayAttachmentProbe {
  return {
    gatewayPort: 8080,
    httpReady: true,
    portOccupied: true,
    listenerPids: [4242],
    listenerScanComplete: true,
    listenerStartTime: "12345",
    supervisorActive: true,
    listenerExecPath: "/opt/platform/gatewayd",
    listenerSupervisorMatch: true,
    ...overrides,
  };
}

function dependencies(owner: GatewayOwner): GatewayReadinessDependencies {
  return {
    resolveOwner: vi.fn(() => owner),
    probeAttachment: vi.fn(async () => attachment()),
    observeManagedGateway: vi.fn(async () => ({
      reuseState: "healthy" as const,
      driftState: "not-detected" as const,
      portConflictState: "none" as const,
    })),
  };
}

describe("gateway readiness projection (#7411)", () => {
  it("rejects a snapshot made stale by a slow onboarding collection", async () => {
    let currentTime = NOW.getTime();
    const deps = dependencies(managedOwner());
    vi.mocked(deps.observeManagedGateway).mockImplementationOnce(async () => {
      currentTime += 30_001;
      return {
        reuseState: "healthy",
        driftState: "not-detected",
        portConflictState: "none",
      };
    });

    const projection = await createGatewayReadinessProjection(deps, {
      now: () => new Date(currentTime),
    });

    expect(projection.capabilities.every(({ state }) => state === "unknown")).toBe(true);
    expect(projection.evidence).toContainEqual(
      expect.objectContaining({ id: "gateway.probe.stale" }),
    );
  });

  it("collects managed reuse, drift, and port ownership without attachment effects", async () => {
    const deps = dependencies(managedOwner());
    const snapshot = await collectGatewayObservations(deps, { now: () => NOW });
    const projection = projectGatewayReadiness(snapshot, { now: () => NOW });

    expect(deps.observeManagedGateway).toHaveBeenCalledOnce();
    expect(deps.probeAttachment).not.toHaveBeenCalled();
    expect(projection.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gateway.management.mode",
          state: "present",
          value: "nemoclaw-managed",
        }),
        expect.objectContaining({ id: "gateway.reuse", value: "healthy" }),
        expect.objectContaining({ id: "gateway.version_drift", value: "not-detected" }),
        expect.objectContaining({ id: "gateway.port_conflict", value: "none" }),
      ]),
    );
    expect(projection.capabilities.every(({ state }) => state === "present")).toBe(true);
    expect(projection.findings).toEqual([]);
  });

  it("verifies an externally supervised attachment and does not run managed reuse", async () => {
    const owner = externalOwner();
    const deps = dependencies(owner);
    const snapshot = await collectGatewayObservations(deps, { now: () => NOW });
    const projection = projectGatewayReadiness(snapshot, { now: () => NOW });

    expect(deps.probeAttachment).toHaveBeenCalledWith(owner);
    expect(deps.observeManagedGateway).not.toHaveBeenCalled();
    expect(projection.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gateway.attachment", value: "verified" }),
        expect.objectContaining({ id: "gateway.reuse", value: "not-applicable" }),
      ]),
    );
    expect(projection.findings).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain(owner.stateDir);
  });

  it.each([
    [{ listenerPids: [4242, 4343] }, "gateway.ownership.multiple", "multiple-owners"],
    [{ listenerSupervisorMatch: false }, "gateway.ownership.mismatch", "owner-mismatch"],
  ] as const)("rejects ambiguous external ownership before any managed operation", async (probeOverrides, findingId, conflictState) => {
    const owner = externalOwner();
    const deps = dependencies(owner);
    vi.mocked(deps.probeAttachment).mockResolvedValueOnce(attachment(probeOverrides));

    const projection = projectGatewayReadiness(
      await collectGatewayObservations(deps, { now: () => NOW }),
      { now: () => NOW },
    );

    expect(deps.observeManagedGateway).not.toHaveBeenCalled();
    expect(projection.findings).toContainEqual(
      expect.objectContaining({ id: findingId, severity: "blocking" }),
    );
    expect(projection.observations).toContainEqual(
      expect.objectContaining({ id: "gateway.port_conflict", value: conflictState }),
    );
    expect(projection.capabilities).toContainEqual(
      expect.objectContaining({ id: "gateway.attachment.valid", state: "absent" }),
    );
  });

  it("redacts probe failures and omits private gateway state", async () => {
    const token = `nvapi-${"a".repeat(24)}`;
    const owner = externalOwner();
    const deps = dependencies(owner);
    vi.mocked(deps.probeAttachment).mockRejectedValueOnce(
      new GatewayOwnershipError(
        "gateway_unreachable",
        `Authorization: Bearer ${token} request failed at ${owner.stateDir}/tls/client/tls.key`,
        owner,
      ),
    );

    const projection = projectGatewayReadiness(
      await collectGatewayObservations(deps, { now: () => NOW }),
      { now: () => NOW },
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(owner.stateDir);
    expect(serialized).toContain("<REDACTED>");
    expect(serialized).toContain("<gateway-state>");
  });

  it("fails closed when lifecycle authority cannot be resolved", async () => {
    const deps = dependencies(managedOwner());
    vi.mocked(deps.resolveOwner).mockImplementationOnce(() => {
      throw new Error("invalid declaration");
    });

    const projection = projectGatewayReadiness(
      await collectGatewayObservations(deps, { now: () => NOW }),
      { now: () => NOW },
    );

    expect(deps.probeAttachment).not.toHaveBeenCalled();
    expect(deps.observeManagedGateway).not.toHaveBeenCalled();
    expect(projection.findings).toContainEqual(
      expect.objectContaining({ id: "gateway.authority.invalid", severity: "blocking" }),
    );
    expect(projection.capabilities.every(({ state }) => state === "unknown")).toBe(true);
  });

  it("rejects observations older than 30 seconds unless collection marked them reusable", async () => {
    const snapshot = await collectGatewayObservations(dependencies(managedOwner()), {
      now: () => NOW,
    });
    const stale = { ...snapshot, observedAt: "2026-08-07T11:00:00.000Z", reusable: false };

    const projection = projectGatewayReadiness(stale, { now: () => NOW });

    expect(projection.capabilities.every(({ state }) => state === "unknown")).toBe(true);
    expect(projection.evidence).toContainEqual(
      expect.objectContaining({ id: "gateway.probe.stale" }),
    );
  });

  it("carries redacted managed port diagnostics as bounded evidence", async () => {
    const deps = dependencies(managedOwner());
    const token = `nvapi-${"b".repeat(24)}`;
    vi.mocked(deps.observeManagedGateway).mockResolvedValueOnce({
      reuseState: "stale",
      driftState: "not-detected",
      portConflictState: "owner-mismatch",
      portConflictDetail: `Port 8080 belongs to Bearer ${token}`,
    });

    const projection = projectGatewayReadiness(
      await collectGatewayObservations(deps, { now: () => NOW }),
      { now: () => NOW },
    );
    const detail = projection.evidence.find(({ id }) => id === "gateway.port.conflict");

    expect(detail?.summary).toContain("<REDACTED>");
    expect(detail?.summary).not.toContain(token);
    expect(projection.findings).toContainEqual(
      expect.objectContaining({ id: "gateway.port.owner_mismatch", severity: "blocking" }),
    );
  });

  it("escapes terminal controls before onboarding can print gateway evidence", async () => {
    const deps = dependencies(managedOwner());
    vi.mocked(deps.observeManagedGateway).mockResolvedValueOnce({
      reuseState: "stale",
      driftState: "not-detected",
      portConflictState: "owner-mismatch",
      portConflictDetail: "forged\n\u001b[31merror \u202efailure",
    });

    const projection = projectGatewayReadiness(
      await collectGatewayObservations(deps, { now: () => NOW }),
      { now: () => NOW },
    );
    const detail = projection.evidence.find(({ id }) => id === "gateway.port.conflict");

    expect(detail?.summary).toBe("forged\\u000a\\u001b[31merror \\u202efailure");
    expect(detail?.summary).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });
});
