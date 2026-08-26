// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntimeModule from "./runtime";
import {
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
  policyAuthorityInternals,
} from "./policy-authority";

function captureResult(
  stdout: string,
  overrides: Partial<{
    stderr: string;
    status: number | null;
    error: Error;
  }> = {},
) {
  return {
    status: overrides.status === undefined ? 0 : overrides.status,
    output: stdout,
    stdout,
    stderr: overrides.stderr ?? "",
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

function captureError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sandboxMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: "sandbox",
    sandbox: "alpha",
    status: "effective",
    policy_source: "sandbox",
    policy: { version: 1, network_policies: { baseline: { endpoints: ["base.test"] } } },
    ...overrides,
  };
}

function globalMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: "global",
    status: "loaded",
    policy_source: "global",
    policy: { version: 1, network_policies: { baseline: { endpoints: ["base.test"] } } },
    ...overrides,
  };
}

function errorFrom(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the action to throw");
}

describe("OpenShell policy authority inspection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("recognizes a sandbox-scoped effective policy as NemoClaw-managed (#9833)", () => {
    vi.stubEnv("HOME", "/tmp/policy-authority-home");
    vi.stubEnv("NEMOCLAW_POLICY_CAPTURE_SECRET", "must-not-reach-openshell");
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult(JSON.stringify(sandboxMetadata())));

    expect(inspectSandboxPolicyAuthority({ sandboxName: "alpha" })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {
        version: 1,
        network_policies: { baseline: { endpoints: ["base.test"] } },
      },
    });
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["policy", "get", "--full", "--output", "json", "alpha"],
      expect.objectContaining({
        ignoreError: true,
        includeStreams: true,
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        replaceEnv: true,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      }),
    );
    const captureOptions = captureOpenshell.mock.calls[0]?.[1];
    expect(captureOptions?.env).toMatchObject({ HOME: "/tmp/policy-authority-home" });
    expect(captureOptions?.env).not.toHaveProperty("NEMOCLAW_POLICY_CAPTURE_SECRET");
  });

  it("recognizes a global policy source as externally managed on the recorded gateway (#9833)", () => {
    const policy = { version: 1, network_policies: { required: { endpoints: ["api.test"] } } };
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(
        captureResult(JSON.stringify(sandboxMetadata({ policy_source: "global", policy }))),
      );

    expect(
      inspectSandboxPolicyAuthority({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
      }),
    ).toEqual({ authority: "externally-managed", effectivePolicy: policy });
    expect(captureOpenshell.mock.calls[0]?.[0]).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw-18080",
      "--full",
      "--output",
      "json",
      "alpha",
    ]);
  });

  it("uses empty bounded global history as managed authority (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult(""));

    expect(inspectGlobalPolicyAuthority({ gatewayName: "nemoclaw-18080" })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    expect(captureOpenshell).toHaveBeenCalledTimes(1);
    expect(captureOpenshell.mock.calls[0]?.[0]).toEqual([
      "policy",
      "list",
      "-g",
      "nemoclaw-18080",
      "--global",
      "--limit",
      "1",
    ]);
  });

  it("uses loaded global metadata as external authority (#9833)", () => {
    const policy = { version: 1, network_policies: { required: { endpoints: ["api.test"] } } };
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(JSON.stringify(globalMetadata({ policy }))));

    expect(inspectGlobalPolicyAuthority({ gatewayName: "nemoclaw-18080" })).toEqual({
      authority: "externally-managed",
      effectivePolicy: policy,
    });
    expect(captureOpenshell.mock.calls[1]?.[0]).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw-18080",
      "--global",
      "--full",
      "--output",
      "json",
    ]);
  });

  it("treats a superseded global revision as managed authority (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(JSON.stringify(globalMetadata({ status: "superseded" }))));

    expect(inspectGlobalPolicyAuthority()).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
  });

  it.each([
    ["malformed metadata", "{"],
    ["wrong scope", JSON.stringify(globalMetadata({ scope: "sandbox" }))],
    ["unknown status", JSON.stringify(globalMetadata({ status: "pending" }))],
  ])("fails closed on %s after global history is present (#9833)", (_caseName, raw) => {
    const secret = "captured-global-policy-secret";
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(`${raw}${secret}`));

    const error = errorFrom(() => inspectGlobalPolicyAuthority());
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain(secret);
  });

  it("rejects invalid sandbox and gateway identities before querying policy (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult(JSON.stringify(sandboxMetadata())));

    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "--global" })).toThrow(
      /Invalid sandbox name/,
    );
    expect(() =>
      inspectSandboxPolicyAuthority({
        sandboxName: "alpha",
        gatewayName: "invalid gateway",
      }),
    ).toThrow(/Invalid gateway name/);
    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha", gatewayName: "" })).toThrow(
      /gateway name is required/,
    );
    expect(captureOpenshell).not.toHaveBeenCalled();
  });

  it.each([
    ["another scope", sandboxMetadata({ scope: "global" })],
    ["another sandbox", sandboxMetadata({ sandbox: "beta" })],
    ["an unknown source", sandboxMetadata({ policy_source: "unknown" })],
  ])("rejects sandbox metadata with %s (#9833)", (_caseName, metadata) => {
    const secret = "captured-policy-secret";
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult(JSON.stringify({ ...metadata, diagnostic: secret })),
    );

    const error = errorFrom(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha" }));
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain(secret);
  });

  it.each(["", " \n\t"])("fails closed when sandbox policy output is empty (%j) (#9833)", (raw) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult(raw),
    );

    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha" })).toThrow(
      /empty sandbox policy authority metadata/u,
    );
  });

  it.each([
    ["a nonzero exit", { status: 7 }],
    ["a timeout", { status: null, error: captureError("ETIMEDOUT", "timeout secret") }],
    ["a capture error", { status: null, error: captureError("EACCES", "capture secret") }],
    ["malformed JSON", {}],
  ])("fails closed without exposing output after %s (#9833)", (_caseName, overrides) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult('{"secret":"captured-stdout-secret"', {
        ...overrides,
        stderr: "captured-stderr-secret",
      }),
    );

    const error = errorFrom(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha" }));
    expect(error.message).not.toContain("captured-stdout-secret");
    expect(error.message).not.toContain("captured-stderr-secret");
    expect(error.message).not.toMatch(/timeout secret|capture secret/u);
  });

  it("replaces a thrown capture diagnostic instead of exposing command output (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockImplementation(() => {
      throw new Error("captured-policy-secret");
    });

    const error = errorFrom(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha" }));
    expect(error.message).toContain("could not run");
    expect(error.message).not.toContain("captured-policy-secret");
  });

  it("rejects a captured policy response that exceeds the byte limit (#9833)", () => {
    const secret = "captured-oversized-secret";
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult(secret, {
        status: null,
        error: captureError("ENOBUFS", secret),
      }),
    );

    const error = errorFrom(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha" }));
    expect(error.message).toContain("capture limit");
    expect(error.message).not.toContain(secret);
  });
});
