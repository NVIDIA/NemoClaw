// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerInspectGateway: vi.fn(),
  gatewayDoctorStartHint: vi.fn(),
  getNamedGatewayLifecycleState: vi.fn(),
  inspectHost: vi.fn(),
  listSandboxes: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn(),
  resolveOpenshell: vi.fn(),
  shouldInspectLegacyGatewayContainer: vi.fn(),
}));

vi.mock("../adapters/openshell/resolve", () => ({
  resolveOpenshell: mocks.resolveOpenshell,
}));

vi.mock("../gateway-runtime-action", () => ({
  getNamedGatewayLifecycleState: mocks.getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

vi.mock("../onboard/gateway-binding", () => ({
  resolveGatewayName: () => "nemoclaw",
  resolveSandboxGatewayName: vi.fn(),
}));

vi.mock("../onboard/runtime-provider/access", () => ({
  CURRENT_RUNTIME_PROVIDER_BUNDLES: [],
  RuntimeProviderSelectionError: class RuntimeProviderSelectionError extends Error {},
  requireRuntimeProviderBundle: vi.fn(),
  resolveCurrentRuntimeProviderBundle: () => ({
    preflightDoctor: { inspectHost: mocks.inspectHost },
  }),
}));

vi.mock("../runner", () => ({ ROOT: "/repo" }));

vi.mock("../state/registry", () => ({
  listSandboxes: mocks.listSandboxes,
}));

vi.mock("./sandbox/doctor-lifecycle-registration", () => ({
  buildPortableRuntimeCheck: () => null,
}));

vi.mock("./sandbox/doctor-system-checks", () => ({
  dockerInspectGateway: mocks.dockerInspectGateway,
  gatewayDoctorStartHint: mocks.gatewayDoctorStartHint,
  oneLine: (value = "") => String(value).replace(/\s+/g, " ").trim(),
  shouldInspectLegacyGatewayContainer: mocks.shouldInspectLegacyGatewayContainer,
}));

import { runGlobalDoctor } from "./sandbox/doctor";

describe("global doctor action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mocks.resolveOpenshell.mockReturnValue("/usr/bin/openshell");
    mocks.inspectHost.mockReturnValue({
      group: "Host",
      label: "Runtime provider",
      status: "ok",
      detail: "available",
    });
    mocks.listSandboxes.mockReturnValue({ sandboxes: [], defaultSandbox: null });
    mocks.gatewayDoctorStartHint.mockReturnValue(
      "Start the gateway again with `nemoclaw onboard`. Then retry this command.",
    );
    mocks.getNamedGatewayLifecycleState.mockReturnValue({
      state: "healthy_named",
      status: "Status: Connected",
      gatewayInfo: "Gateway: nemoclaw",
      activeGateway: "nemoclaw",
    });
    mocks.shouldInspectLegacyGatewayContainer.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks host and gateway health with zero sandboxes without recovery (#10212)", async () => {
    const report = await runGlobalDoctor({ quiet: true });

    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: "global",
      status: "ok",
      failed: 0,
      warnings: 0,
    });
    expect(report).not.toHaveProperty("sandbox");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "Host", label: "CLI build", status: "ok" }),
        expect.objectContaining({ group: "Host", label: "Runtime provider", status: "ok" }),
        expect.objectContaining({ group: "Host", label: "OpenShell CLI", status: "ok" }),
        expect.objectContaining({ group: "Host", label: "Sandbox registry", status: "ok" }),
        expect.objectContaining({ group: "Gateway", label: "OpenShell status", status: "ok" }),
      ]),
    );
    expect(report.checks.some((check) => check.group === "Sandbox")).toBe(false);
    expect(report.checks.some((check) => check.group === "Inference")).toBe(false);
    expect(report.checks.some((check) => check.group === "Messaging")).toBe(false);
    expect(report.checks.some((check) => check.group === "Local services")).toBe(false);
    expect(mocks.getNamedGatewayLifecycleState).toHaveBeenCalledWith("nemoclaw", {
      ignoreProbeErrors: true,
    });
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("reports a registry read failure without exposing its error text (#10212)", async () => {
    mocks.listSandboxes.mockImplementationOnce(() => {
      throw new Error("Authorization: Bearer sk-secret-value in /private/registry.json");
    });

    const report = await runGlobalDoctor({ quiet: true });
    const registryCheck = report.checks.find((check) => check.label === "Sandbox registry");

    expect(report.status).toBe("fail");
    expect(registryCheck).toMatchObject({
      status: "fail",
      detail: "could not read the host sandbox registry",
    });
    expect(JSON.stringify(report)).not.toContain("sk-secret-value");
    expect(JSON.stringify(report)).not.toContain("/private/registry.json");
  });

  it("reports skipped gateway health when the OpenShell CLI is missing (#10212)", async () => {
    mocks.resolveOpenshell.mockReturnValueOnce(null);

    const report = await runGlobalDoctor({ quiet: true });

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "OpenShell CLI", status: "fail" }),
        expect.objectContaining({
          group: "Gateway",
          label: "OpenShell status",
          status: "fail",
          detail: "skipped because the OpenShell CLI is not installed",
        }),
      ]),
    );
    expect(mocks.getNamedGatewayLifecycleState).not.toHaveBeenCalled();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("reports invalid gateway management when the OpenShell CLI is missing (#10212)", async () => {
    mocks.resolveOpenshell.mockReturnValueOnce(null);
    mocks.gatewayDoctorStartHint.mockImplementationOnce(() => {
      throw new Error("Authorization: Bearer sk-secret-value in /private/gateway-management.json");
    });

    const report = await runGlobalDoctor({ quiet: true });

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Gateway",
          label: "Gateway management",
          status: "fail",
          detail: "could not resolve the gateway lifecycle owner",
        }),
        expect.objectContaining({
          group: "Gateway",
          label: "OpenShell status",
          status: "fail",
          detail: "skipped because the OpenShell CLI is not installed",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("sk-secret-value");
    expect(JSON.stringify(report)).not.toContain("/private/gateway-management.json");
    expect(mocks.getNamedGatewayLifecycleState).not.toHaveBeenCalled();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("reports invalid gateway management without hiding gateway health (#10212)", async () => {
    mocks.gatewayDoctorStartHint.mockImplementationOnce(() => {
      throw new Error("invalid declaration at /private/gateway-management.json");
    });
    mocks.getNamedGatewayLifecycleState.mockReturnValueOnce({
      state: "missing_named",
      status: "Status: Disconnected",
      gatewayInfo: "",
      activeGateway: null,
    });

    const report = await runGlobalDoctor({ quiet: true });

    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: "global",
      status: "fail",
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Gateway",
          label: "Gateway management",
          status: "fail",
          hint: "check the gateway-management declaration file permissions and JSON, then retry",
        }),
        expect.objectContaining({
          group: "Gateway",
          label: "OpenShell status",
          status: "fail",
          hint: "check the gateway-management declaration file permissions and JSON, then retry",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("/private/gateway-management.json");
    expect(mocks.getNamedGatewayLifecycleState).toHaveBeenCalledWith("nemoclaw", {
      ignoreProbeErrors: true,
    });
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("renders actionable text without naming a sandbox (#10212)", async () => {
    mocks.getNamedGatewayLifecycleState.mockReturnValueOnce({
      state: "missing_named",
      status: "Status: Disconnected",
      gatewayInfo: "",
      activeGateway: null,
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));

    const report = await runGlobalDoctor();
    const output = lines.join("\n");

    expect(report.status).toBe("fail");
    expect(output).toContain("NemoClaw doctor");
    expect(output).not.toContain("NemoClaw doctor:");
    expect(output).toContain(
      "Start the gateway again with `nemoclaw onboard`. Then retry this command.",
    );
  });
});
