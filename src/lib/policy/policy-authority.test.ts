// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertExternalPolicyRequirements,
  assertObservedPolicyRequirements,
  assertRecordedPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  type SandboxPolicyAuthorityInspection,
} from "./policy-authority";

function errorFrom(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the action to throw");
}

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
      policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
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
        inspection: {
          authority: "nemoclaw-managed",
          policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
          effectivePolicy: {},
        },
        requiredPolicy: { network_policies: { required: { endpoints: ["api.test"] } } },
        operation: "apply a preset",
      }),
    ).not.toThrow();
  });
});

describe("observed policy requirements", () => {
  it("checks owner-unknown policy contents without assigning ownership (#9833)", () => {
    const inspection: SandboxPolicyAuthorityInspection = {
      authority: "owner-unknown",
      policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
      effectivePolicy: {
        network_policies: { required: { endpoints: ["api.test"] } },
      },
    };

    expect(() =>
      assertObservedPolicyRequirements({
        inspection,
        requiredPolicy: {
          network_policies: { required: { endpoints: ["api.test"] } },
        },
        operation: "verify the created sandbox policy",
        sandboxName: "alpha",
      }),
    ).not.toThrow();

    const error = errorFrom(() =>
      assertObservedPolicyRequirements({
        inspection,
        requiredPolicy: {
          network_policies: { missing: { endpoints: ["required-secret.test"] } },
        },
        operation: "verify the created sandbox policy",
        sandboxName: "alpha",
      }),
    );
    expect(error.message).toContain('missing entries "missing"');
    expect(error.message).toContain("The verified policy must supply the exact required entries");
    expect(error.message).not.toContain("required-secret.test");
  });
});
