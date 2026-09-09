// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SanitizedExternalOpenShellTargetPlan } from "./openshell-external-target-boundary.cjs";
import { EXTERNAL_OPENSHELL_RELEASE } from "./openshell-observation-boundary.cjs";
import { createOpenShellSdkGatewayHealthObserver } from "./openshell-gateway-health-sdk.js";

const officialSdkMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  health: vi.fn(),
}));

vi.mock("@nvidia/openshell-sdk", () => ({
  OpenShellClient: { connect: officialSdkMocks.connect },
}));

vi.mock("@nvidia/openshell-sdk/raw", () => ({
  ServiceStatus: { UNSPECIFIED: 0, HEALTHY: 1, DEGRADED: 2, UNHEALTHY: 3 },
}));

const TARGET: SanitizedExternalOpenShellTargetPlan = {
  endpoint: "https://openshell.example.test:8443",
  workspace: "default",
  expected_release: EXTERNAL_OPENSHELL_RELEASE,
  lifecycle: "external",
  authentication_source: "file",
  ca_fingerprint: `sha256:${"a".repeat(64)}`,
};
const CA_BUNDLE = Buffer.from("public-ca-certificate");
const SERVICE_STATUS = Object.freeze({
  UNSPECIFIED: 0,
  HEALTHY: 1,
  DEGRADED: 2,
  UNHEALTHY: 3,
});

describe("OpenShell SDK gateway health observer", () => {
  const health = vi.fn();
  const connect = vi.fn();
  const loadSdk = vi.fn();
  const timeoutSignal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    health.mockResolvedValue({ status: SERVICE_STATUS.HEALTHY, version: "0.0.106" });
    connect.mockResolvedValue({ raw: { health } });
    loadSdk.mockResolvedValue({ connect, serviceStatus: SERVICE_STATUS });
    timeoutSignal.mockReturnValue(new AbortController().signal);
    officialSdkMocks.health.mockResolvedValue({
      status: SERVICE_STATUS.HEALTHY,
      version: "0.0.106",
    });
    officialSdkMocks.connect.mockResolvedValue({ raw: { health: officialSdkMocks.health } });
  });

  function request(overrides: Record<string, unknown> = {}) {
    return {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  it("uses the official SDK client and its generated health client with one deadline (#9872)", async () => {
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    const signal = timeoutSignal.mock.results[0]?.value;
    expect(timeoutSignal).toHaveBeenCalledWith(5_000);
    expect(loadSdk).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({
      gateway: TARGET.endpoint,
      caCert: CA_BUNDLE,
    });
    expect(health).toHaveBeenCalledWith({}, { signal });
    expect(result).toEqual({ ok: true, value: { status: "healthy", release: "0.0.106" } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ok ? result.value : {})).toBe(true);
  });

  it("loads the approved SDK exports through the default adapter (#9872)", async () => {
    const observer = createOpenShellSdkGatewayHealthObserver({ timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(officialSdkMocks.connect).toHaveBeenCalledWith({
      gateway: TARGET.endpoint,
      caCert: CA_BUNDLE,
    });
    expect(officialSdkMocks.health).toHaveBeenCalledWith(
      {},
      {
        signal: timeoutSignal.mock.results[0]?.value,
      },
    );
    expect(result).toEqual({ ok: true, value: { status: "healthy", release: "0.0.106" } });
  });

  it.each([
    ["missing client", null],
    ["incompatible service status", { connect, serviceStatus: {} }],
  ])("rejects an SDK with %s exports (#9872)", async (_name, loadedSdk) => {
    loadSdk.mockResolvedValue(loadedSdk);
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({
      ok: false,
      error: { kind: "dependency", message: "The approved OpenShell SDK package is unavailable." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not start SDK loading after an expired deadline (#9872)", async () => {
    timeoutSignal.mockReturnValue(AbortSignal.abort());
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "timeout",
        message: "The external OpenShell gateway health check timed out.",
      },
    });
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it.each([
    [SERVICE_STATUS.UNSPECIFIED, "unspecified"],
    [SERVICE_STATUS.HEALTHY, "healthy"],
    [SERVICE_STATUS.DEGRADED, "degraded"],
    [SERVICE_STATUS.UNHEALTHY, "unhealthy"],
  ])("maps SDK service status %s to %s (#9872)", async (sdkStatus, expected) => {
    health.mockResolvedValue({ status: sdkStatus, version: "0.0.106" });
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({ ok: true, value: { status: expected, release: "0.0.106" } });
  });

  it.each([
    ["missing response", null],
    ["missing status", { version: "0.0.106" }],
    ["unknown status", { status: 99, version: "0.0.106" }],
    ["missing version", { status: SERVICE_STATUS.HEALTHY }],
  ])("returns a fixed schema error for %s (#9872)", async (_name, response) => {
    health.mockResolvedValue(response);
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "The external OpenShell gateway returned an invalid health response.",
      },
    });
  });

  it("keeps SDK load details out of a dependency failure (#9872)", async () => {
    loadSdk.mockRejectedValue(new Error("private token from /var/run/private-authentication"));
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({
      ok: false,
      error: { kind: "dependency", message: "The approved OpenShell SDK package is unavailable." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps transport details out of a reachability failure (#9872)", async () => {
    health.mockRejectedValue(new Error("private path /var/run/private-ca.pem"));
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "transport",
        message: "NemoClaw could not reach the external OpenShell target.",
      },
    });
  });

  it("bounds SDK loading with the same total deadline (#9872)", async () => {
    const deadline = new AbortController();
    timeoutSignal.mockReturnValue(deadline.signal);
    loadSdk.mockReturnValue(new Promise(() => undefined));
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const observation = observer.observeHealth(request());
    deadline.abort();

    await expect(observation).resolves.toEqual({
      ok: false,
      error: {
        kind: "timeout",
        message: "The external OpenShell gateway health check timed out.",
      },
    });
    expect(connect).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });

  it("passes the deadline signal to a stalled SDK health call (#9872)", async () => {
    const deadline = new AbortController();
    timeoutSignal.mockReturnValue(deadline.signal);
    health.mockReturnValue(new Promise(() => undefined));
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const observation = observer.observeHealth(request());
    await vi.waitFor(() => expect(health).toHaveBeenCalledOnce());
    deadline.abort();

    await expect(observation).resolves.toEqual({
      ok: false,
      error: {
        kind: "timeout",
        message: "The external OpenShell gateway health check timed out.",
      },
    });
    expect(health).toHaveBeenCalledWith({}, { signal: deadline.signal });
  });

  it.each([
    ["wrong release", { target: { ...TARGET, expected_release: "0.0.107" } }],
    ["empty CA", { caBundle: Buffer.alloc(0) }],
    ["zero timeout", { timeoutMs: 0 }],
  ])("rejects %s before loading the SDK (#9872)", async (_name, overrides) => {
    const observer = createOpenShellSdkGatewayHealthObserver({ loadSdk, timeoutSignal });

    const result = await observer.observeHealth(request(overrides));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "The external OpenShell gateway health request is not valid.",
      },
    });
    expect(timeoutSignal).not.toHaveBeenCalled();
    expect(loadSdk).not.toHaveBeenCalled();
  });
});
