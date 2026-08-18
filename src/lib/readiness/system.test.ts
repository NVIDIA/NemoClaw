// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with { type: "json" };
import type { HostAssessment } from "../onboard/preflight";
import { type GatewayObservationSnapshot, projectGatewayReadiness } from "./gateway";
import { createPublicReadinessReport } from "./presentation";
import { getSystemReadinessReferenceErrors } from "./references";
import { composeSystemReadinessReport, createSystemReadinessReport } from "./system";
import type { SystemReadinessReport } from "./types";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function hostReport(): SystemReadinessReport {
  return {
    schemaVersion: "1.1.0",
    status: "supported",
    exitCode: 0,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: NOW.toISOString(),
    },
    observations: [{ id: "host.os.platform", state: "present", value: "linux" }],
    capabilities: [{ id: "host.platform.supported", state: "present" }],
    qualifications: [],
    findings: [],
    evidence: [],
  };
}

function gatewaySnapshot(): GatewayObservationSnapshot {
  return {
    observedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    observations: {
      owner: {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        supervisor: null,
        requiredCapabilities: [],
      },
      attachmentState: "not-applicable",
      reuseState: "healthy",
      driftState: "not-detected",
      portConflictState: "none",
    },
  };
}

function supportedHost(): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker",
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

describe("composite system readiness (#7411)", () => {
  // source-shape-contract: compatibility -- Composite readiness output must conform to the published schema before external consumers receive it
  it("publishes a schema-valid host and gateway report with resolved references (#7411)", () => {
    const report = composeSystemReadinessReport(
      hostReport(),
      projectGatewayReadiness(gatewaySnapshot(), { now: () => NOW }),
    );
    const publicReport = createPublicReadinessReport(report);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addFormat("date-time", true);
    const validate = ajv.compile(systemReadinessSchema as AnySchema);

    expect(validate(publicReport), JSON.stringify(validate.errors)).toBe(true);
    expect(getSystemReadinessReferenceErrors(publicReport)).toEqual([]);
    expect(publicReport.observations).toContainEqual(
      expect.objectContaining({
        id: "gateway.management.mode",
        value: "nemoclaw-managed",
      }),
    );
  });

  it("rejects duplicate entity IDs before onboarding can consume them", () => {
    const host = hostReport();
    const gateway = projectGatewayReadiness(gatewaySnapshot(), { now: () => NOW });
    gateway.observations[0] = { id: "host.os.platform", state: "present" };

    expect(() => composeSystemReadinessReport(host, gateway)).toThrow(
      "System readiness report failed internal reference validation.",
    );
  });

  it("rejects dangling gateway references at composition", () => {
    const gateway = projectGatewayReadiness(gatewaySnapshot(), { now: () => NOW });
    gateway.capabilities[0] = {
      ...gateway.capabilities[0],
      evidenceIds: ["gateway.evidence.missing"],
    };

    expect(() => composeSystemReadinessReport(hostReport(), gateway)).toThrow(
      "System readiness report failed internal reference validation.",
    );
  });

  it("marks facts held across a slow gateway probe stale, but not the probe itself (#9310)", async () => {
    let currentTime = NOW.getTime();
    const report = await createSystemReadinessReport(
      {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        now: () => new Date(currentTime),
      },
      {
        host: {
          assess: supportedHost,
          collectPlatformIdentity: () => ({
            productName: null,
            nvidiaPlatform: null,
            stationProfile: null,
            stationGb300PciGpu: null,
          }),
        },
        gateway: {
          resolveOwner: () => ({
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
            mode: "nemoclaw-managed",
            source: "standalone",
            endpoint: null,
            stateDir: null,
            supervisor: null,
            requiredCapabilities: [],
          }),
          probeAttachment: async () => {
            throw new Error("managed attachment probe must not run");
          },
          observeManagedGateway: async () => {
            currentTime += 30_001;
            return {
              reuseState: "healthy",
              driftState: "not-detected",
              portConflictState: "none",
            };
          },
        },
      },
    );

    // The host facts were collected before the probe and held across it, so
    // they age out. The gateway facts are as fresh as collection can make them.
    expect(report.status).toBe("inconclusive");
    expect(report.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "host.probe.stale" })]),
    );
    expect(report.evidence).not.toContainEqual(
      expect.objectContaining({ id: "gateway.probe.stale" }),
    );
    expect(report.capabilities.length).toBeGreaterThan(0);
  });
});
