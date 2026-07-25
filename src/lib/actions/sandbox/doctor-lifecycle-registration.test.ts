// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry } from "../../state/registry";
import { buildLifecycleRegistrationCheck } from "./doctor-lifecycle-registration";

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    model: "nvidia/test-model",
    provider: "nvidia-nim",
    openshellDriver: "docker",
    openshellVersion: "0.0.72",
    nemoclawVersion: "0.0.83",
    fromDockerfile: null,
    dashboardPort: 18_789,
    imageTag: "nemoclaw-openclaw:test",
    gatewayName: "nemoclaw-18080",
    gatewayPort: 18_080,
    ...overrides,
  };
}

describe("doctor lifecycle registration checks", () => {
  it("reports a complete managed sandbox registration as ok", () => {
    expect(buildLifecycleRegistrationCheck("alpha", sandbox(), "nemoclaw")).toMatchObject({
      group: "Sandbox",
      label: "Lifecycle registration",
      status: "ok",
      detail: expect.stringContaining("snapshot, rebuild, upgrade, recovery, and reboot"),
    });
  });

  it("warns when a Brev fast-path registry entry lacks lifecycle metadata", () => {
    const incomplete: SandboxEntry = {
      name: "alpha",
      agent: "openclaw",
      model: "nvidia/test-model",
      provider: "nvidia-nim",
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18_080,
    };

    const check = buildLifecycleRegistrationCheck("alpha", incomplete, "nemoclaw");

    expect(check).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("missing"),
      hint: expect.stringContaining("re-register or re-onboard"),
    });
    expect(check.detail).toContain("openshellDriver");
    expect(check.detail).toContain("openshellVersion");
    expect(check.detail).toContain("nemoclawVersion");
    expect(check.detail).toContain("fromDockerfile");
    expect(check.detail).toContain("dashboardPort");
    expect(check.detail).toContain("imageTag");
    expect(check.detail).toContain("snapshot");
    expect(check.detail).toContain("rebuild");
  });

  it("accepts explicit custom-image provenance without a NemoClaw managed-image fingerprint", () => {
    const custom = sandbox({
      fromDockerfile: "/workspace/Dockerfile.custom",
      nemoclawVersion: null,
    });

    expect(buildLifecycleRegistrationCheck("alpha", custom, "nemoclaw")).toMatchObject({
      status: "ok",
    });
  });

  it("warns when registered image metadata is null", () => {
    const check = buildLifecycleRegistrationCheck("alpha", sandbox({ imageTag: null }), "nemoclaw");

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("invalid imageTag");
    expect(check.detail).toContain("snapshot");
  });

  it("warns when registered OpenShell version metadata is null", () => {
    const check = buildLifecycleRegistrationCheck(
      "alpha",
      sandbox({ openshellVersion: null }),
      "nemoclaw",
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("invalid openshellVersion");
    expect(check.detail).toContain("snapshot");
  });

  it("reports blank managed-image version metadata only as invalid", () => {
    const check = buildLifecycleRegistrationCheck(
      "alpha",
      sandbox({ nemoclawVersion: " " }),
      "nemoclaw",
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("invalid nemoclawVersion");
    expect(check.detail).not.toContain("missing nemoclawVersion");
  });

  it("reports invalid durable port metadata without printing values", () => {
    const check = buildLifecycleRegistrationCheck(
      "alpha",
      sandbox({ dashboardPort: 0, gatewayPort: 100_000 }),
      "nemoclaw",
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("invalid dashboardPort, gatewayPort");
    expect(check.detail).not.toContain("100000");
  });

  it("requires a valid dashboard port for dashboard-managed agents", () => {
    const check = buildLifecycleRegistrationCheck(
      "alpha",
      sandbox({ dashboardPort: null }),
      "nemoclaw",
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("invalid dashboardPort");
  });

  it("does not require dashboard metadata for terminal agents without forwarded ports", () => {
    const { dashboardPort: _dashboardPort, ...terminal } = sandbox({
      agent: "langchain-deepagents-code",
    });

    expect(
      buildLifecycleRegistrationCheck("alpha", terminal, "nemoclaw", {
        dashboardPortRequired: false,
      }),
    ).toMatchObject({ status: "ok" });
  });
});
