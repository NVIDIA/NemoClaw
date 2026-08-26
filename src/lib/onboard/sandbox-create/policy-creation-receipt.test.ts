// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntimeModule from "../../adapters/openshell/runtime";
import { verifyCreatedSandboxPolicyCreationReceipt } from "./policy-creation-receipt";

const POLICY = "version: 1\nnetwork_policies:\n  github:\n    endpoints: []\n";
const INPUT = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lifecycleLiveIdentityFingerprint: "b".repeat(64),
  policySourcePath: "/private/policy.yaml",
};

function metadata(overrides: Partial<Record<string, unknown>> = {}): {
  status: number;
  output: string;
  stdout: string;
  stderr: string;
} {
  const stdout = JSON.stringify({
    scope: "sandbox",
    sandbox: "alpha",
    status: "effective",
    policy_source: "sandbox",
    active_version: 4,
    hash: "sha256:effective",
    policy: {
      version: 1,
      network_policies: { github: { endpoints: [] } },
    },
    ...overrides,
  });
  return {
    status: 0,
    output: stdout,
    stdout,
    stderr: "",
  };
}

describe("created sandbox policy receipt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the exact supplied policy to the verified create identity (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" })
      .mockReturnValueOnce(metadata());
    const receipt = verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
      readFile: vi.fn(() => POLICY) as never,
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration: INPUT.lifecycleGeneration,
      sandboxIdentityFingerprint: INPUT.lifecycleLiveIdentityFingerprint,
      policyHash: "sha256:effective",
      policyVersion: 4,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/github|credential|endpoints/u);
  });

  it("refuses a live base policy that differs from the create source (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({
        status: 0,
        output: "version: 1\nnetwork_policies: {}\n",
        stdout: "version: 1\nnetwork_policies: {}\n",
        stderr: "",
      })
      .mockReturnValueOnce(metadata());
    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
      }),
    ).toThrow(/live base policy does not match/u);
    expect(captureOpenshell).toHaveBeenCalledTimes(3);
  });

  it("does not claim a verified global policy as NemoClaw-created (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(metadata({ policy_source: "global" }))
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" })
      .mockReturnValueOnce(metadata({ policy_source: "global" }));
    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
      }),
    ).toThrow(/does not report.*sandbox-scoped/u);
  });

  it("refuses incomplete OpenShell policy identity without exposing policy contents (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      metadata({ hash: "" }),
    );
    let error: unknown;
    try {
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("policy authority inspection failed");
    expect((error as Error).message).not.toContain("github");
  });

  it("refuses an effective policy identity that changes during verification (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" })
      .mockReturnValueOnce(metadata({ hash: "sha256:replacement", active_version: 5 }));

    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
      }),
    ).toThrow(/policy identity changed/u);
  });
});
