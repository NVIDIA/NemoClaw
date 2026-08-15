// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const receiptReadinessMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
}));

vi.mock("../../onboard/experimental/portable-runtime-receipt-readiness", () => ({
  inspectPortableRuntimeReceiptReadiness: receiptReadinessMocks.inspect,
}));

import type { PortablePodmanReadinessResult } from "../../onboard/experimental/portable-runtime-readiness";
import type { SandboxEntry } from "../../state/registry";
import {
  buildLifecycleRegistrationCheck,
  buildPortableRuntimeCheck,
} from "./doctor-lifecycle-registration";

const READY_PORTABLE_RUNTIME = {
  ok: true,
  authority: {
    directoryChain: [],
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: "1001",
    socketPath: "/run/user/1001/podman/podman.sock",
  },
  dockerHost: "unix:///run/user/1001/podman/podman.sock",
  serverVersion: "5.6.1",
  timing: { mode: "warm", activationMs: 0, apiMs: 7, totalMs: 7 },
} satisfies PortablePodmanReadinessResult;

const FAILED_PORTABLE_RUNTIME = {
  ok: false,
  stage: "startup API health",
  detail: "Podman did not report a server version.",
  socketPath: "/run/user/1001/podman/podman.sock",
  timing: { mode: "cold", activationMs: 21, apiMs: 9, totalMs: 30 },
} satisfies PortablePodmanReadinessResult;

const PORTABLE_ONBOARDING_FAILURES = [
  {
    name: "invalid",
    result: {
      ok: false,
      stage: "socket authority",
      detail: "The portable lifecycle receipt is unsafe or invalid; rerun onboarding.",
      recovery: "portable-onboarding",
      timing: { mode: "warm", activationMs: 0, apiMs: 0, totalMs: 0 },
    } satisfies PortablePodmanReadinessResult,
  },
  {
    name: "legacy",
    result: {
      ok: false,
      stage: "socket authority",
      detail:
        "The lifecycle receipt predates recorded portable Podman authority; rerun onboarding.",
      recovery: "portable-onboarding",
      timing: { mode: "warm", activationMs: 0, apiMs: 0, totalMs: 0 },
    } satisfies PortablePodmanReadinessResult,
  },
] as const;

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
  beforeEach(() => {
    receiptReadinessMocks.inspect.mockReset();
  });

  it("renders server and timing detail for a ready portable Podman API", () => {
    receiptReadinessMocks.inspect.mockReturnValue(READY_PORTABLE_RUNTIME);

    expect(buildPortableRuntimeCheck("alpha")).toEqual({
      group: "Host",
      label: "Portable Podman API",
      status: "ok",
      detail: "server 5.6.1; warm; activation 0 ms; API 7 ms; total 7 ms",
    });
    expect(receiptReadinessMocks.inspect).toHaveBeenCalledWith("alpha");
  });

  it("renders the failure stage, recorded socket, and recovery hint", () => {
    receiptReadinessMocks.inspect.mockReturnValue(FAILED_PORTABLE_RUNTIME);

    expect(buildPortableRuntimeCheck("alpha")).toEqual({
      group: "Host",
      label: "Portable Podman API",
      status: "fail",
      detail:
        "startup API health: Podman did not report a server version. Recorded socket: /run/user/1001/podman/podman.sock.",
      hint: "repair the recorded current-user Podman endpoint, then retry",
    });
    expect(receiptReadinessMocks.inspect).toHaveBeenCalledWith("alpha");
  });

  it.each(PORTABLE_ONBOARDING_FAILURES)(
    "sends a $name receipt failure to portable onboarding without endpoint repair",
    ({ result }) => {
      receiptReadinessMocks.inspect.mockReturnValue(result);

      const check = buildPortableRuntimeCheck("alpha");

      expect(check).toMatchObject({
        status: "fail",
        detail: expect.not.stringContaining("Recorded socket"),
        hint: "rerun portable onboarding with `nemoclaw onboard --experimental-profile portable`, then retry",
      });
      expect(check?.hint).not.toContain("endpoint");
    },
  );

  it("routes a current-user authority mismatch to its recorded user or current-user onboarding", () => {
    receiptReadinessMocks.inspect.mockReturnValue({
      ok: false,
      stage: "socket authority",
      detail: "The recorded portable Podman authority does not match the current Linux user.",
      recovery: "current-user-authority",
      timing: { mode: "warm", activationMs: 0, apiMs: 0, totalMs: 0 },
    } satisfies PortablePodmanReadinessResult);

    expect(buildPortableRuntimeCheck("alpha")).toMatchObject({
      hint: "run NemoClaw as the user who created the portable state, or rerun portable onboarding as the current user",
    });
  });

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
