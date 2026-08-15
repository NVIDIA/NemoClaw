// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with {
  type: "json",
};
import type { SystemReadinessReport } from "../../lib/readiness/types";

const mocks = vi.hoisted(() => ({
  createProductionGatewayReadinessDependencies: vi.fn(),
  createPublicHostProbeReadinessReport: vi.fn(),
  createSystemReadinessReport: vi.fn(),
  getBuildIdentity: vi.fn(),
  renderReadinessReport: vi.fn(),
}));

vi.mock("../../lib/readiness/index", () => ({
  createPublicHostProbeReadinessReport: mocks.createPublicHostProbeReadinessReport,
  createSystemReadinessReport: mocks.createSystemReadinessReport,
  renderReadinessReport: mocks.renderReadinessReport,
}));

vi.mock("../../lib/readiness/gateway-production", () => ({
  createProductionGatewayReadinessDependencies: mocks.createProductionGatewayReadinessDependencies,
}));

vi.mock("../../lib/core/version", () => ({
  getBuildIdentity: mocks.getBuildIdentity,
}));

import HostProbeCommand from "./probe";

type ReadinessOutcome =
  | { status: "supported"; exitCode: 0 }
  | { status: "incompatible"; exitCode: 2 }
  | { status: "inconclusive"; exitCode: 3 };

const READINESS_OUTCOMES = [
  { status: "supported", exitCode: 0 },
  { status: "incompatible", exitCode: 2 },
  { status: "inconclusive", exitCode: 3 },
] as const satisfies readonly ReadinessOutcome[];

function throwSchemaErrors(errors: unknown): never {
  throw new Error(JSON.stringify(errors));
}

function assertSchemaValid(value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", true);
  const validate = ajv.compile(systemReadinessSchema as AnySchema);
  validate(value) || throwSchemaErrors(validate.errors);
}

function report(outcome: ReadinessOutcome): SystemReadinessReport {
  return {
    schemaVersion: "1.1.0",
    ...outcome,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.0.96-35-g8bfff4526",
      sourceRevision: `8bfff4526${"a".repeat(31)}`,
      observedAt: "2026-06-01T12:00:00.000Z",
    },
    observations: [],
    capabilities: [],
    qualifications: [],
    findings: [],
    evidence: [],
  };
}

describe("host probe command (#7412)", () => {
  const gatewayDependencies = {
    resolveOwner: vi.fn(),
    probeAttachment: vi.fn(),
    observeManagedGateway: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBuildIdentity.mockReturnValue({
      nemoclawVersion: "0.0.96-35-g8bfff4526",
      sourceRevision: `8bfff4526${"a".repeat(31)}`,
    });
    mocks.createProductionGatewayReadinessDependencies.mockReturnValue(gatewayDependencies);
    mocks.createSystemReadinessReport.mockResolvedValue(report(READINESS_OUTCOMES[0]));
    mocks.createPublicHostProbeReadinessReport.mockImplementation((value) => value);
    mocks.renderReadinessReport.mockReturnValue("System readiness: supported");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(READINESS_OUTCOMES)("returns the deterministic $status exit code", async (outcome) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.createSystemReadinessReport.mockResolvedValueOnce(report(outcome));

    try {
      await HostProbeCommand.run([], process.cwd());
      expect(process.exitCode).toBe(outcome.exitCode);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each(READINESS_OUTCOMES)("emits schema-valid JSON for $status hosts", async (outcome) => {
    const expectedReport = report(outcome);
    mocks.createSystemReadinessReport.mockResolvedValueOnce(expectedReport);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await HostProbeCommand.run(["--json"], process.cwd());
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

      assertSchemaValid(output);
      expect(output).toEqual(expectedReport);
      expect(process.exitCode).toBe(outcome.exitCode);
      expect(mocks.renderReadinessReport).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("uses one readiness report for human output (#7412)", async () => {
    const publicReport = report(READINESS_OUTCOMES[0]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.createPublicHostProbeReadinessReport.mockReturnValueOnce(publicReport);

    await HostProbeCommand.run([], process.cwd());

    expect(mocks.createSystemReadinessReport).toHaveBeenCalledWith(
      {
        nemoclawVersion: "0.0.96-35-g8bfff4526",
        sourceRevision: `8bfff4526${"a".repeat(31)}`,
      },
      { gateway: gatewayDependencies },
    );
    expect(mocks.createProductionGatewayReadinessDependencies).toHaveBeenCalledOnce();
    expect(mocks.createPublicHostProbeReadinessReport).toHaveBeenCalledWith(
      await mocks.createSystemReadinessReport.mock.results[0]?.value,
    );
    expect(mocks.renderReadinessReport).toHaveBeenCalledWith(publicReport);
    expect(log).toHaveBeenCalledWith("System readiness: supported");
  });

  it("repeats through the observation-only dependency graph", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HostProbeCommand.run([], process.cwd());
    await HostProbeCommand.run(["--json"], process.cwd());

    expect(mocks.createSystemReadinessReport).toHaveBeenCalledTimes(2);
    expect(mocks.createProductionGatewayReadinessDependencies).toHaveBeenCalledTimes(2);
    expect(mocks.createPublicHostProbeReadinessReport).toHaveBeenCalledTimes(2);
    expect(mocks.renderReadinessReport).toHaveBeenCalledTimes(1);
  });
});
