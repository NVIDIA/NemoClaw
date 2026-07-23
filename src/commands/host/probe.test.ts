// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with {
  type: "json",
};
import type { SystemReadinessReport } from "../../lib/readiness/types";

const mocks = vi.hoisted(() => ({
  createHostReadinessReport: vi.fn(),
  createPublicReadinessReport: vi.fn(),
  renderReadinessReport: vi.fn(),
}));

vi.mock("../../lib/readiness/index", () => ({
  createHostReadinessReport: mocks.createHostReadinessReport,
  createPublicReadinessReport: mocks.createPublicReadinessReport,
  renderReadinessReport: mocks.renderReadinessReport,
}));

import HostProbeCommand from "./probe";

function assertSchemaValid(value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", true);
  const validate = ajv.compile(systemReadinessSchema as AnySchema);
  if (!validate(value)) throw new Error(JSON.stringify(validate.errors));
}

function report(
  status: SystemReadinessReport["status"],
  exitCode: SystemReadinessReport["exitCode"],
): SystemReadinessReport {
  return {
    schemaVersion: "1.0.0",
    status,
    exitCode,
    mutated: false,
    provenance: { nemoclawVersion: "0.1.0", observedAt: "2026-06-01T12:00:00.000Z" },
    observations: [],
    capabilities: [],
    qualifications: [],
    findings: [],
    evidence: [],
  };
}

describe("host probe command (#7412)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createHostReadinessReport.mockReturnValue(report("supported", 0));
    mocks.createPublicReadinessReport.mockImplementation((value) => value);
    mocks.renderReadinessReport.mockReturnValue("System readiness: supported");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["supported", 0],
    ["incompatible", 2],
    ["inconclusive", 3],
  ] as const)("returns the deterministic %s exit code", async (status, exitCode) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.createHostReadinessReport.mockReturnValueOnce(report(status, exitCode));

    try {
      await HostProbeCommand.run([], process.cwd());
      expect(process.exitCode).toBe(exitCode);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    ["incompatible", 2],
    ["inconclusive", 3],
  ] as const)("emits schema-valid JSON for %s hosts", async (status, exitCode) => {
    const expectedReport = report(status, exitCode);
    mocks.createHostReadinessReport.mockReturnValueOnce(expectedReport);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await HostProbeCommand.run(["--json"], process.cwd());
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

      expect(() => assertSchemaValid(output)).not.toThrow();
      expect(output).toEqual(expectedReport);
      expect(process.exitCode).toBe(exitCode);
      expect(mocks.renderReadinessReport).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("runs before gateway or sandbox registration and uses one report for human output", async () => {
    const publicReport = report("supported", 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.createPublicReadinessReport.mockReturnValueOnce(publicReport);

    await HostProbeCommand.run([], process.cwd());

    expect(mocks.createHostReadinessReport).toHaveBeenCalledWith({ nemoclawVersion: "0.1.0" });
    expect(mocks.createPublicReadinessReport).toHaveBeenCalledWith(
      mocks.createHostReadinessReport.mock.results[0]?.value,
    );
    expect(mocks.renderReadinessReport).toHaveBeenCalledWith(publicReport);
    expect(log).toHaveBeenCalledWith("System readiness: supported");
  });

  it("repeats through the observation-only dependency graph", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HostProbeCommand.run([], process.cwd());
    await HostProbeCommand.run(["--json"], process.cwd());

    expect(mocks.createHostReadinessReport).toHaveBeenCalledTimes(2);
    expect(mocks.createPublicReadinessReport).toHaveBeenCalledTimes(2);
    expect(mocks.renderReadinessReport).toHaveBeenCalledTimes(1);
  });
});
