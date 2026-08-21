// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellResolveModule from "./resolve";
import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
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

  it.each([
    ["empty with no stderr", { stdout: "", exitCode: 0, timedOut: false }],
    ["empty with stderr", captureResult("", { stderr: "No policy revisions exist" })],
    ["whitespace only", captureResult(" \n\t")],
  ])("recognizes NemoClaw-managed authority when global history is %s (#9833)", (_case, result) => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => result);

    expect(inspectGlobalPolicyAuthority({ runCaptureEx })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    expect(runCaptureEx).toHaveBeenCalledOnce();
    expect(runCaptureEx).toHaveBeenCalledWith(
      ["openshell", "policy", "list", "--global", "--limit", "1"],
      {
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      },
    );
  });

  it("recognizes a loaded global policy as externally managed before create (#9833)", () => {
    const policy = { version: 1, network_policies: { required: { endpoints: ["api.test"] } } };
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("policy revision history"))
      .mockReturnValueOnce(captureResult(JSON.stringify(globalMetadata({ policy }))));

    expect(inspectGlobalPolicyAuthority({ gatewayName: "nemoclaw-18080", runCaptureEx })).toEqual({
      authority: "externally-managed",
      effectivePolicy: policy,
    });
    expect(runCaptureEx).toHaveBeenNthCalledWith(
      1,
      ["openshell", "policy", "list", "-g", "nemoclaw-18080", "--global", "--limit", "1"],
      {
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      },
    );
    expect(runCaptureEx).toHaveBeenNthCalledWith(
      2,
      [
        "openshell",
        "policy",
        "get",
        "-g",
        "nemoclaw-18080",
        "--global",
        "--full",
        "--output",
        "json",
      ],
      {
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      },
    );
  });

  it("recognizes a superseded global policy as NemoClaw-managed (#9833)", () => {
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("policy revision history"))
      .mockReturnValueOnce(
        captureResult(JSON.stringify(globalMetadata({ status: "superseded", policy: undefined }))),
      );

    expect(inspectGlobalPolicyAuthority({ runCaptureEx })).toEqual({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    expect(runCaptureEx).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid sandbox and gateway identities before querying policy (#9833)", () => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() =>
      captureResult(JSON.stringify(sandboxMetadata())),
    );

    expect(() => inspectSandboxPolicyAuthority({ sandboxName: "--global", runCaptureEx })).toThrow(
      /Invalid sandbox name/,
    );
    expect(() =>
      inspectGlobalPolicyAuthority({ gatewayName: "invalid gateway", runCaptureEx }),
    ).toThrow(/Invalid gateway name/);
    expect(() => inspectGlobalPolicyAuthority({ gatewayName: "", runCaptureEx })).toThrow(
      /gateway name is required/,
    );
    expect(runCaptureEx).not.toHaveBeenCalled();
  });

  it.each([
    ["another scope", sandboxMetadata({ scope: "global" })],
    ["another sandbox", sandboxMetadata({ sandbox: "beta" })],
    ["a non-effective status", sandboxMetadata({ status: "loaded" })],
    ["an unknown source", sandboxMetadata({ policy_source: "unknown" })],
    ["a missing policy", sandboxMetadata({ policy: undefined })],
    ["a non-object policy", sandboxMetadata({ policy: [] })],
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

  it.each([
    ["empty", captureResult("")],
    ["whitespace-only", captureResult(" \n\t")],
    ["malformed", captureResult('{"secret":"captured-global-secret"')],
  ])("fails closed when global policy metadata is %s (#9833)", (_case, result) => {
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("policy revision history"))
      .mockReturnValueOnce(result);

    const error = errorFrom(() => inspectGlobalPolicyAuthority({ runCaptureEx }));
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain("captured-global-secret");
  });

  it.each([
    ["another scope", globalMetadata({ scope: "sandbox" })],
    ["a sandbox identity", globalMetadata({ sandbox: "alpha" })],
    ["another source", globalMetadata({ policy_source: "sandbox" })],
    ["a pending status", globalMetadata({ status: "pending" })],
    ["a failed status", globalMetadata({ status: "failed" })],
    ["a missing status", globalMetadata({ status: undefined })],
    ["an unknown status", globalMetadata({ status: "unknown" })],
    ["a missing loaded policy", globalMetadata({ policy: undefined })],
    ["a non-object loaded policy", globalMetadata({ policy: null })],
  ])("rejects global metadata with %s (#9833)", (_caseName, metadata) => {
    const secret = "captured-global-policy-secret";
    const runCaptureEx = vi
      .fn<PolicyAuthorityCapture>()
      .mockReturnValueOnce(captureResult("policy revision history"))
      .mockReturnValueOnce(captureResult(JSON.stringify({ ...metadata, diagnostic: secret })));

    const error = errorFrom(() => inspectGlobalPolicyAuthority({ runCaptureEx }));
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain(secret);
  });

  it.each([
    [
      "a nonzero exit",
      captureResult("captured-history-secret", {
        stderr: "captured-history-stderr-secret",
        exitCode: 7,
      }),
    ],
    [
      "a timeout",
      captureResult("captured-history-secret", {
        stderr: "captured-history-stderr-secret",
        timedOut: true,
      }),
    ],
  ])(
    "fails closed without reading global metadata after history query has %s (#9833)",
    (_case, result) => {
      const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => result);

      const error = errorFrom(() => inspectGlobalPolicyAuthority({ runCaptureEx }));
      expect(error.message).toContain("inspection failed");
      expect(error.message).not.toContain("captured-history-secret");
      expect(error.message).not.toContain("captured-history-stderr-secret");
      expect(runCaptureEx).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["empty", captureResult("")],
    ["whitespace-only", captureResult(" \n\t")],
    ["malformed", captureResult('{"secret":"captured-stdout-secret"')],
  ])("fails closed when sandbox metadata is %s (#9833)", (_case, result) => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => result);

    const error = errorFrom(() =>
      inspectSandboxPolicyAuthority({ sandboxName: "alpha", runCaptureEx }),
    );
    expect(error.message).toContain("inspection failed");
    expect(error.message).not.toContain("captured-stdout-secret");
  });

  it.each([
    [
      "a nonzero exit",
      captureResult('{"secret":"captured-stdout-secret"}', {
        stderr: "captured-stderr-secret",
        exitCode: 7,
      }),
    ],
    [
      "a timeout",
      captureResult('{"secret":"captured-stdout-secret"}', {
        stderr: "captured-stderr-secret",
        timedOut: true,
      }),
    ],
    ["malformed JSON", captureResult('{"secret":"captured-stdout-secret"')],
  ])("fails closed without exposing output after %s (#9833)", (_caseName, result) => {
    const runCaptureEx = vi.fn<PolicyAuthorityCapture>(() => result);

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
  it("accepts an unchanged recorded authority (#9833)", () => {
    expect(() =>
      assertRecordedPolicyAuthority(
        "externally-managed",
        "externally-managed",
        "rebuild the sandbox",
      ),
    ).not.toThrow();
  });

  it("refuses an absent or changed recorded authority (#9833)", () => {
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
});

describe("externally managed policy requirements", () => {
  const externalInspection = (
    effectivePolicy: Record<string, unknown>,
  ): SandboxPolicyAuthorityInspection => ({
    authority: "externally-managed",
    effectivePolicy,
  });

  it("compares exact network entries and static policy sections (#9833)", () => {
    const requiredPolicy = {
      version: 1,
      filesystem_policy: { read_only: ["/required-secret"] },
      process: { run_as_user: 1000 },
      network_policies: {
        required: { endpoints: [{ host: "api.test", port: 443 }], mode: "allow" },
      },
    };
    const inspection = externalInspection({
      version: 9,
      filesystem_policy: { read_only: ["/observed-secret"] },
      network_policies: {
        extra: { endpoints: [{ host: "extra.test", port: 443 }] },
        required: { mode: "allow", endpoints: [{ port: 443, host: "api.test" }] },
      },
    });

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
    expect(error.message).not.toContain("required-secret");
    expect(error.message).not.toContain("observed-secret");
  });

  it("names missing and drifted keys without exposing policy contents (#9833)", () => {
    const inspection = externalInspection({
      network_policies: {
        drifted_entry: { endpoints: [{ host: "observed-secret.test", port: 443 }] },
      },
    });
    const requiredPolicy = {
      network_policies: {
        missing_entry: { endpoints: [{ host: "missing-secret.test", port: 443 }] },
        drifted_entry: { endpoints: [{ host: "required-secret.test", port: 443 }] },
      },
    };

    const error = errorFrom(() =>
      assertExternalPolicyRequirements({
        inspection,
        requiredPolicy,
        operation: "start the managed MCP service",
        sandboxName: "alpha",
      }),
    );
    expect(error.message).toContain('missing entries "missing_entry"');
    expect(error.message).toContain('drifted entries "drifted_entry"');
    expect(error.message).not.toContain("missing-secret.test");
    expect(error.message).not.toContain("required-secret.test");
    expect(error.message).not.toContain("observed-secret.test");
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
