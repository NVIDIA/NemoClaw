// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellResolveModule from "./resolve";
import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  type PolicyAuthorityCapture,
  policyAuthorityInternals,
  type SandboxPolicyAuthorityInspection,
} from "./policy-authority";

function captureResult(
  stdout: string,
  overrides: Partial<{
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> = {},
) {
  return {
    stdout,
    stderr: overrides.stderr ?? "",
    exitCode: overrides.exitCode ?? 0,
    timedOut: overrides.timedOut ?? false,
  };
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
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes a sandbox-scoped effective policy as NemoClaw-managed (#9833)", () => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult(JSON.stringify(sandboxMetadata())),
    );

    expect(inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {
        version: 1,
        network_policies: { baseline: { endpoints: ["base.test"] } },
      },
    });
    expect(runCaptureEx).toHaveBeenCalledWith(
      ["openshell", "policy", "get", "--full", "--output", "json", "alpha"],
      {
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      },
    );
  });

  it("recognizes a global policy source as externally managed on the recorded gateway (#9833)", () => {
    const policy = { version: 1, network_policies: { required: { endpoints: ["api.test"] } } };
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult(JSON.stringify(sandboxMetadata({ policy_source: "global", policy }))),
    );

    expect(
      inspectSandboxPolicyAuthority({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
        runCaptureEx,
      }),
    ).toEqual({ authority: "externally-managed", effectivePolicy: policy });
    expect(runCaptureEx.mock.calls[0]?.[0]).toEqual([
      "openshell",
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
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => captureResult(""));

    expect(inspectGlobalPolicyAuthority({ gatewayName: "nemoclaw-18080", runCaptureEx })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    expect(runCaptureEx).toHaveBeenCalledTimes(1);
    expect(runCaptureEx.mock.calls[0]?.[0]).toEqual([
      "openshell",
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
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(JSON.stringify(globalMetadata({ policy }))));

    expect(inspectGlobalPolicyAuthority({ gatewayName: "nemoclaw-18080", runCaptureEx })).toEqual({
      authority: "externally-managed",
      effectivePolicy: policy,
    });
    expect(runCaptureEx.mock.calls[1]?.[0]).toEqual([
      "openshell",
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
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(JSON.stringify(globalMetadata({ status: "superseded" }))));

    expect(inspectGlobalPolicyAuthority({ runCaptureEx })).toEqual({
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
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("revision-1"))
      .mockReturnValueOnce(captureResult(`${raw}${secret}`));

    const error = errorFrom(() => inspectGlobalPolicyAuthority({ runCaptureEx }));
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain(secret);
  });

  it("rejects invalid sandbox and gateway identities before querying policy (#9833)", () => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult(JSON.stringify(sandboxMetadata())),
    );

    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "--global", runCaptureEx })).toThrow(
      /Invalid sandbox name/,
    );
    expect(() =>
      inspectSandboxPolicyAuthority({
        sandboxName: "alpha",
        gatewayName: "invalid gateway",
        runCaptureEx,
      }),
    ).toThrow(/Invalid gateway name/);
    expect(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", gatewayName: "", runCaptureEx }),
    ).toThrow(/gateway name is required/);
    expect(runCaptureEx).not.toHaveBeenCalled();
  });

  it.each([
    ["another scope", sandboxMetadata({ scope: "global" })],
    ["another sandbox", sandboxMetadata({ sandbox: "beta" })],
    ["an unknown source", sandboxMetadata({ policy_source: "unknown" })],
  ])("rejects sandbox metadata with %s (#9833)", (_caseName, metadata) => {
    const secret = "captured-policy-secret";
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult(JSON.stringify({ ...metadata, diagnostic: secret })),
    );

    const error = errorFrom(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx }),
    );
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain(secret);
  });

  it.each(["", " \n\t"])("fails closed when sandbox policy output is empty (%j) (#9833)", (raw) => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => captureResult(raw));

    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx })).toThrow(
      /empty sandbox policy authority metadata/u,
    );
  });

  it.each([
    ["a nonzero exit", { exitCode: 7 }],
    ["a timeout", { timedOut: true }],
    ["malformed JSON", {}],
  ])("fails closed without exposing output after %s (#9833)", (_caseName, overrides) => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult('{"secret":"captured-stdout-secret"', {
        ...overrides,
        stderr: "captured-stderr-secret",
      }),
    );

    const error = errorFrom(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx }),
    );
    expect(error.message).not.toContain("captured-stdout-secret");
    expect(error.message).not.toContain("captured-stderr-secret");
  });

  it("replaces a thrown capture diagnostic instead of exposing command output (#9833)", () => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => {
      throw new Error("captured-policy-secret");
    });

    const error = errorFrom(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx }),
    );
    expect(error.message).toContain("could not run");
    expect(error.message).not.toContain("captured-policy-secret");
  });

  it("rejects a captured policy response that exceeds the byte limit (#9833)", () => {
    const oversized = "x".repeat(policyAuthorityInternals.captureMaxBytes + 1);
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => captureResult(oversized));

    const error = errorFrom(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx }),
    );
    expect(error.message).toContain("capture limit");
    expect(error.message).not.toContain(oversized.slice(0, 32));
  });
});

describe("recorded policy authority", () => {
  it("accepts unchanged authority and refuses missing or changed authority (#9833)", () => {
    expect(() =>
      assertRecordedPolicyAuthority("externally-managed", "externally-managed", "rebuild"),
    ).not.toThrow();
    expect(() =>
      assertRecordedPolicyAuthority(undefined, "externally-managed", "restore the snapshot"),
    ).toThrow(/recorded policy authority is unavailable or invalid/);
    expect(() =>
      assertRecordedPolicyAuthority(
        "nemoclaw-managed",
        "externally-managed",
        "restore the snapshot",
      ),
    ).toThrow(/changed from nemoclaw-managed to externally-managed/);
    expect(() =>
      assertRecordedPolicyAuthority("externally-managed", "unknown", "restore the snapshot"),
    ).toThrow(/observed OpenShell policy authority is unavailable or invalid/);
  });

  it("classifies an observed external authority without parsing diagnostics (#9833)", () => {
    const externalError = errorFrom(() =>
      assertRecordedPolicyAuthority(
        "nemoclaw-managed",
        "externally-managed",
        "restore the snapshot",
      ),
    );
    const managedError = errorFrom(() =>
      assertRecordedPolicyAuthority(
        "externally-managed",
        "nemoclaw-managed",
        "restore the snapshot",
      ),
    );

    expect(isExternalPolicyAuthorityRefusalError(externalError)).toBe(true);
    expect(isExternalPolicyAuthorityRefusalError(managedError)).toBe(false);
  });
});

describe("externally managed policy requirements", () => {
  it("compares exact requirements and redacts missing or drifted contents (#9833)", () => {
    const requiredPolicy = {
      version: 1,
      filesystem_policy: { read_only: ["/required-secret"] },
      process: { run_as_user: 1000 },
      network_policies: {
        exact: { endpoints: [{ host: "api.test", port: 443 }], mode: "allow" },
        missing: { endpoints: [{ host: "missing-secret.test", port: 443 }] },
        drifted: { endpoints: [{ host: "required-secret.test", port: 443 }] },
      },
    };
    const inspection: SandboxPolicyAuthorityInspection = {
      authority: "externally-managed",
      effectivePolicy: {
        version: 9,
        filesystem_policy: { read_only: ["/observed-secret"] },
        network_policies: {
          exact: { mode: "allow", endpoints: [{ port: 443, host: "api.test" }] },
          drifted: { endpoints: [{ host: "observed-secret.test", port: 443 }] },
        },
      },
    };

    const error = errorFrom(() =>
      assertExternalPolicyRequirements({
        inspection,
        requiredPolicy,
        operation: "enable messaging",
        sandboxName: "alpha",
      }),
    );
    expect(error.message).toContain('missing sections "process"');
    expect(error.message).toContain('drifted sections "filesystem_policy"');
    expect(error.message).toContain('missing entries "missing"');
    expect(error.message).toContain('drifted entries "drifted"');
    expect(error.message).not.toMatch(
      /required-secret|observed-secret|missing-secret\.test|observed-secret\.test/u,
    );
  });

  it("leaves NemoClaw-managed requirements to the mutation path (#9833)", () => {
    expect(() =>
      assertExternalPolicyRequirements({
        inspection: { authority: "nemoclaw-managed", effectivePolicy: {} },
        requiredPolicy: { network_policies: { required: { endpoints: ["api.test"] } } },
        operation: "apply a preset",
      }),
    ).not.toThrow();
  });
});
