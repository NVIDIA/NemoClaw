// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SanitizedExternalOpenShellTargetPlan } from "./openshell-external-target-boundary.cjs";
import {
  EXTERNAL_OPENSHELL_RELEASE,
  observeExternalOpenShellGatewayHealth,
} from "./openshell-observation-boundary.cjs";

const TARGET: SanitizedExternalOpenShellTargetPlan = Object.freeze({
  endpoint: "https://openshell.example.test:8443",
  workspace: "default",
  expected_release: EXTERNAL_OPENSHELL_RELEASE,
  lifecycle: "external",
  authentication_source: "file",
  ca_fingerprint: `sha256:${"a".repeat(64)}`,
});
const CA_BUNDLE = Buffer.from("public-ca-certificate");

describe("external OpenShell observation boundary", () => {
  const observeHealth = vi.fn();
  const observer = { observeHealth };

  beforeEach(() => {
    vi.clearAllMocks();
    observeHealth.mockResolvedValue({
      ok: true,
      value: { status: "healthy", release: EXTERNAL_OPENSHELL_RELEASE },
    });
  });

  it("returns only the sanitized compatible health status (#9872)", async () => {
    const result = await observeExternalOpenShellGatewayHealth(observer, {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        openshell_target: TARGET,
        gateway: { status: "healthy", release: EXTERNAL_OPENSHELL_RELEASE },
        compatibility: "compatible",
      },
    });
    expect(observeHealth).toHaveBeenCalledWith({
      target: TARGET,
      caBundle: Uint8Array.from(CA_BUNDLE),
      timeoutMs: 5_000,
    });
    expect(observeHealth.mock.calls[0]?.[0].caBundle).not.toBe(CA_BUNDLE);
  });

  it.each([
    ["dependency", `The approved OpenShell SDK ${EXTERNAL_OPENSHELL_RELEASE} is unavailable.`],
    ["schema", "The external OpenShell gateway returned an invalid public health response."],
    ["timeout", "NemoClaw could not reach the external OpenShell target."],
    ["transport", "NemoClaw could not reach the external OpenShell target."],
  ])("replaces a %s observer detail with a fixed message (#9872)", async (kind, message) => {
    observeHealth.mockResolvedValue({
      ok: false,
      error: { kind, message: "private token from /var/run/private-authentication" },
    });

    const result = await observeExternalOpenShellGatewayHealth(observer, {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: false, error: { message } });
  });

  it("replaces a thrown observer detail with a fixed message (#9872)", async () => {
    observeHealth.mockRejectedValue(new Error("private path /var/run/private-ca.pem"));

    const result = await observeExternalOpenShellGatewayHealth(observer, {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: false,
      error: { message: "The external OpenShell gateway health check failed." },
    });
  });

  it.each([
    ["wrong release", { status: "healthy", release: "0.0.107" }, "release does not match"],
    ["unhealthy", { status: "unhealthy", release: "0.0.106" }, "gateway is not healthy"],
    ["invalid status", { status: "unknown", release: "0.0.106" }, "invalid public health"],
  ])("rejects a %s observation with a fixed message (#9872)", async (_name, value, message) => {
    observeHealth.mockResolvedValue({ ok: true, value });

    const result = await observeExternalOpenShellGatewayHealth(observer, {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: false,
      error: { message: expect.stringContaining(message) },
    });
  });

  it.each([
    ["another release", { target: { ...TARGET, expected_release: "0.0.107" } }],
    ["empty CA", { caBundle: Buffer.alloc(0) }],
    ["invalid timeout", { timeoutMs: 0 }],
  ])("rejects %s before calling the observer (#9872)", async (_name, overrides) => {
    const result = await observeExternalOpenShellGatewayHealth(observer, {
      target: TARGET,
      caBundle: CA_BUNDLE,
      timeoutMs: 5_000,
      ...overrides,
    });

    expect(result).toEqual({
      ok: false,
      error: { message: "The external OpenShell gateway health request is not valid." },
    });
    expect(observeHealth).not.toHaveBeenCalled();
  });
});
