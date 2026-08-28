// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntimeModule from "../../adapters/openshell/runtime";
import { parseOpenShellPolicy } from "../../policy/merge";
import {
  type CreatedSandboxPolicyReceiptDeps,
  pendingSandboxPolicyVerificationForBoundary,
  revalidateCreatedSandboxPolicyRegistration,
  verifiedSandboxPolicyBoundaryFromPendingCheckpoint,
  verifyCreatedApfInterceptorPolicyRegistration,
  verifyCreatedSandboxPolicyRegistration,
  verifyCreatedSandboxPolicyCreationReceipt,
} from "./policy-creation-receipt";

const POLICY = "version: 1\nnetwork_policies:\n  github:\n    endpoints: []\n";
const REPLACEMENT_POLICY =
  "version: 1\nnetwork_policies:\n  github:\n    endpoints:\n      - host: replacement.example\n";
const NATIVE_GPU_POLICY = `version: 1
filesystem_policy:
  include_workdir: true
  read_only:
    - /usr
    - /lib
    - /etc
    - /app
    - /var/log
    - /dev/urandom
  read_write:
    - /tmp
network_policies:
  github:
    endpoints: []
`;
const ENRICHED_NATIVE_GPU_POLICY = NATIVE_GPU_POLICY.replace(
  "  read_write:\n    - /tmp\n",
  `  read_write:
    - /tmp
    - /proc
    - /dev/nvidiactl
    - /dev/nvidia0
`,
);
const PROXY_ONLY_NATIVE_GPU_POLICY = NATIVE_GPU_POLICY.replace(
  "    - /dev/urandom\n",
  "    - /dev/urandom\n    - /proc\n",
);
const COMPATIBILITY_GPU_POLICY = NATIVE_GPU_POLICY.replace(
  "  read_write:\n    - /tmp\n",
  "  read_write:\n    - /tmp\n    - /proc\n",
);
const ENRICHED_COMPATIBILITY_GPU_POLICY = COMPATIBILITY_GPU_POLICY.replace(
  "    - /proc\n",
  "    - /proc\n    - /dev/nvidiactl\n    - /dev/nvidia0\n",
);
const INPUT = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lifecycleLiveIdentityFingerprint: "b".repeat(64),
  policySourcePath: "/private/policy.yaml",
  route: "none" as const,
};
const MANAGED_REGISTRATION = {
  policyAuthority: "nemoclaw-managed" as const,
  policyCreationReceipt: {
    schemaVersion: 1 as const,
    origin: "sandbox-create" as const,
    gatewayName: INPUT.gatewayName,
    gatewayPort: INPUT.gatewayPort,
    sandboxName: INPUT.sandboxName,
    lifecycleGeneration: INPUT.lifecycleGeneration,
    sandboxIdentityFingerprint: INPUT.lifecycleLiveIdentityFingerprint,
    policyHash: "sha256:effective",
    policyVersion: 4,
  },
  observedPolicyAuthority: "owner-unknown" as const,
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

function gatewayInfo(): { status: number; output: string; stdout: string; stderr: string } {
  const output = "Gateway endpoint: http://127.0.0.1:8080\n";
  return { status: 0, output, stdout: output, stderr: "" };
}

function readyPolicy() {
  return { state: "ready" as const };
}

function readyReadOnlyPolicyDeps(): CreatedSandboxPolicyReceiptDeps {
  return {
    readFile: vi.fn(() => POLICY) as never,
    inspectPolicyReadiness: readyPolicy,
    sleep: vi.fn(),
  };
}

const READ_ONLY_REGISTRATION_CASES = [
  {
    label: "APF-selected",
    policySource: "sandbox",
    verify: (deps: CreatedSandboxPolicyReceiptDeps) =>
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        deps,
      ),
  },
  {
    label: "externally managed",
    policySource: "global",
    verify: (deps: CreatedSandboxPolicyReceiptDeps) =>
      verifyCreatedSandboxPolicyRegistration(
        {
          ...INPUT,
          operation: "verify externally managed policy",
          plannedAuthority: "externally-managed",
        },
        deps,
      ),
  },
] as const;

describe("created sandbox policy receipt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores the exact managed verified boundary from its pending checkpoint (#9833)", () => {
    const boundary = {
      sandboxName: INPUT.sandboxName,
      gatewayName: INPUT.gatewayName,
      gatewayPort: INPUT.gatewayPort,
      lifecycleGeneration: INPUT.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: INPUT.lifecycleLiveIdentityFingerprint,
      route: INPUT.route,
      registration: {
        policyAuthority: "nemoclaw-managed" as const,
        observedPolicyAuthority: "owner-unknown" as const,
        policyCreationReceipt: {
          schemaVersion: 1 as const,
          origin: "sandbox-create" as const,
          gatewayName: INPUT.gatewayName,
          gatewayPort: INPUT.gatewayPort,
          sandboxName: INPUT.sandboxName,
          lifecycleGeneration: INPUT.lifecycleGeneration,
          sandboxIdentityFingerprint: INPUT.lifecycleLiveIdentityFingerprint,
          policyHash: "sha256:effective",
          policyVersion: 4,
        },
      },
    };
    const checkpoint = pendingSandboxPolicyVerificationForBoundary(boundary);

    const restored = verifiedSandboxPolicyBoundaryFromPendingCheckpoint(checkpoint);

    expect(restored).toEqual(boundary);
    expect(pendingSandboxPolicyVerificationForBoundary(restored)).toEqual(checkpoint);
  });

  it.each(["externally-managed", "owner-unknown"] as const)(
    "restores the exact %s read-only boundary from its pending checkpoint (#9833)",
    (observedPolicyAuthority) => {
      const boundary = {
        sandboxName: INPUT.sandboxName,
        gatewayName: INPUT.gatewayName,
        gatewayPort: INPUT.gatewayPort,
        lifecycleGeneration: INPUT.lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: INPUT.lifecycleLiveIdentityFingerprint,
        route: "native" as const,
        registration: {
          policyAuthority: "externally-managed" as const,
          policyCreationReceipt: null,
          observedPolicyAuthority,
          policyIdentity: { hash: "sha256:effective", activeVersion: 4 },
        },
      };
      const checkpoint = pendingSandboxPolicyVerificationForBoundary(boundary);

      const restored = verifiedSandboxPolicyBoundaryFromPendingCheckpoint(checkpoint);

      expect(restored).toEqual(boundary);
      expect(pendingSandboxPolicyVerificationForBoundary(restored)).toEqual(checkpoint);
    },
  );

  it("rejects a missing or malformed pending checkpoint before restoring authority (#9833)", () => {
    expect(() => verifiedSandboxPolicyBoundaryFromPendingCheckpoint(undefined)).toThrow(
      /without a complete verified policy checkpoint/u,
    );
    expect(() =>
      verifiedSandboxPolicyBoundaryFromPendingCheckpoint({
        schemaVersion: 1,
        state: "verified-create",
        policyAuthority: "externally-managed",
      }),
    ).toThrow(/invalid pending policy verification/u);
  });

  it("binds the exact supplied policy to the verified create identity (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" })
      .mockReturnValueOnce(metadata());
    const receipt = verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
      readFile: vi.fn(() => POLICY) as never,
      inspectPolicyReadiness: readyPolicy,
      sleep: vi.fn(),
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
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(
        metadata({ policy: parseOpenShellPolicy("version: 1\nnetwork_policies: {}\n").policy }),
      )
      .mockReturnValueOnce({
        status: 0,
        output: "version: 1\nnetwork_policies: {}\n",
        stdout: "version: 1\nnetwork_policies: {}\n",
        stderr: "",
      })
      .mockReturnValueOnce(
        metadata({ policy: parseOpenShellPolicy("version: 1\nnetwork_policies: {}\n").policy }),
      );
    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
        inspectPolicyReadiness: readyPolicy,
        sleep: vi.fn(),
      }),
    ).toThrow(/live base policy does not match/u);
    expect(captureOpenshell).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      route: "native" as const,
      intendedPolicy: NATIVE_GPU_POLICY,
      livePolicy: ENRICHED_NATIVE_GPU_POLICY,
    },
    {
      route: "native" as const,
      intendedPolicy: NATIVE_GPU_POLICY,
      livePolicy: PROXY_ONLY_NATIVE_GPU_POLICY,
    },
    {
      route: "compatibility" as const,
      intendedPolicy: COMPATIBILITY_GPU_POLICY,
      livePolicy: ENRICHED_COMPATIBILITY_GPU_POLICY,
    },
  ])(
    "binds documented $route-GPU policy enrichment to the create receipt (#9833)",
    ({ route, intendedPolicy, livePolicy }) => {
      vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
        .mockReturnValueOnce(gatewayInfo())
        .mockReturnValueOnce(
          metadata({ policy: parseOpenShellPolicy(livePolicy).policy }),
        )
        .mockReturnValueOnce({
          status: 0,
          output: livePolicy,
          stdout: livePolicy,
          stderr: "",
        })
        .mockReturnValueOnce(
          metadata({ policy: parseOpenShellPolicy(livePolicy).policy }),
        );

      expect(
        verifyCreatedSandboxPolicyCreationReceipt(
          { ...INPUT, route },
          {
            readFile: vi.fn(() => intendedPolicy) as never,
            inspectPolicyReadiness: readyPolicy,
            sleep: vi.fn(),
          },
        ),
      ).toMatchObject({
        policyHash: "sha256:effective",
        policyVersion: 4,
      });
    },
  );

  it.each([
    {
      label: "the create route does not use GPU injection",
      input: INPUT,
      livePolicy: ENRICHED_NATIVE_GPU_POLICY,
    },
    {
      label: "the native live policy contains an arbitrary added path",
      input: { ...INPUT, route: "native" as const },
      livePolicy: ENRICHED_NATIVE_GPU_POLICY.replace("/dev/nvidia0", "/home"),
    },
    {
      label: "the proxy-only native live policy contains a GPU device path",
      input: { ...INPUT, route: "native" as const },
      livePolicy: PROXY_ONLY_NATIVE_GPU_POLICY.replace(
        "  read_write:\n    - /tmp\n",
        "  read_write:\n    - /tmp\n    - /dev/nvidia0\n",
      ),
    },
    {
      label: "the compatibility live policy contains an arbitrary added path",
      input: { ...INPUT, route: "compatibility" as const },
      livePolicy: ENRICHED_COMPATIBILITY_GPU_POLICY.replace("/dev/nvidia0", "/home"),
    },
  ])("refuses native-GPU policy enrichment when $label (#9833)", ({ input, livePolicy }) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ policy: parseOpenShellPolicy(livePolicy).policy }))
      .mockReturnValueOnce({ status: 0, output: livePolicy, stdout: livePolicy, stderr: "" })
      .mockReturnValueOnce(metadata({ policy: parseOpenShellPolicy(livePolicy).policy }));

    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(input, {
        readFile: vi.fn(() => NATIVE_GPU_POLICY) as never,
        inspectPolicyReadiness: readyPolicy,
        sleep: vi.fn(),
      }),
    ).toThrow(/live base policy does not match/u);
  });

  it("does not claim a verified global policy as NemoClaw-created (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ policy_source: "global" }))
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" })
      .mockReturnValueOnce(metadata({ policy_source: "global" }));
    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
        inspectPolicyReadiness: readyPolicy,
        sleep: vi.fn(),
      }),
    ).toThrow(/does not report.*sandbox-scoped/u);
  });

  it("refuses incomplete OpenShell policy identity without exposing policy contents (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValue(metadata({ hash: "" }));
    let error: unknown;
    try {
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
        inspectPolicyReadiness: readyPolicy,
        sleep: vi.fn(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("policy authority inspection failed");
    expect((error as Error).message).not.toContain("github");
  });

  it("refuses policy identity drift after authoritative sandbox readiness (#9833)", () => {
    const events: string[] = [];
    const sleep = vi.fn(() => events.push("poll"));
    const inspectPolicyReadiness = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("policy-version-pending");
        return { state: "transient", reason: "policy-version-pending" } as const;
      })
      .mockImplementationOnce(() => {
        events.push("policy-ready");
        return { state: "ready" } as const;
      });
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockImplementationOnce(() => {
        events.push("policy-initial");
        return metadata();
      })
      .mockImplementationOnce(() => {
        events.push("base-policy");
        return { status: 0, output: POLICY, stdout: POLICY, stderr: "" };
      })
      .mockImplementationOnce(() => {
        events.push("policy-later");
        return metadata({ hash: "sha256:replacement", active_version: 5 });
      });

    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
        inspectPolicyReadiness,
        sleep,
      }),
    ).toThrow(/policy identity changed/u);
    expect(events).toEqual([
      "policy-initial",
      "policy-version-pending",
      "poll",
      "policy-ready",
      "base-policy",
      "policy-later",
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("refuses replacement policy bytes between stable identity observations (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({
        status: 0,
        output: REPLACEMENT_POLICY,
        stdout: REPLACEMENT_POLICY,
        stderr: "",
      })
      .mockReturnValueOnce(metadata());

    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => REPLACEMENT_POLICY) as never,
        inspectPolicyReadiness: readyPolicy,
        sleep: vi.fn(),
      }),
    ).toThrow(/policy evidence changed during receipt verification/u);
  });

  it("fails closed when the exact sandbox never activates the policy version (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({ status: 0, output: POLICY, stdout: POLICY, stderr: "" });
    const inspectPolicyReadiness = vi.fn(() => ({
      state: "transient" as const,
      reason: "policy-version-pending" as const,
    }));
    const sleep = vi.fn();

    expect(() =>
      verifyCreatedSandboxPolicyCreationReceipt(INPUT, {
        readFile: vi.fn(() => POLICY) as never,
        inspectPolicyReadiness,
        sleep,
      }),
    ).toThrow(/did not activate the verified policy version/u);
    expect(inspectPolicyReadiness).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("records a contained APF-selected sandbox policy as external without provenance (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(metadata());

    expect(
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        readyReadOnlyPolicyDeps(),
      ),
    ).toEqual({
      policyAuthority: "externally-managed",
      policyCreationReceipt: null,
      observedPolicyAuthority: "owner-unknown",
      policyIdentity: { hash: "sha256:effective", activeVersion: 4 },
    });
  });

  it("verifies externally managed policy through the production entrypoint (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ policy_source: "global" }))
      .mockReturnValueOnce(metadata({ policy_source: "global" }));

    expect(
      verifyCreatedSandboxPolicyRegistration(
        {
          ...INPUT,
          operation: "verify externally managed policy",
          plannedAuthority: "externally-managed",
        },
        readyReadOnlyPolicyDeps(),
      ),
    ).toEqual({
      policyAuthority: "externally-managed",
      policyCreationReceipt: null,
      observedPolicyAuthority: "externally-managed",
      policyIdentity: { hash: "sha256:effective", activeVersion: 4 },
    });
  });

  it("revalidates APF-selected owner-unknown containment without changing attribution (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata());

    const registration = {
      policyAuthority: "externally-managed" as const,
      policyCreationReceipt: null,
      observedPolicyAuthority: "owner-unknown" as const,
      policyIdentity: { hash: "sha256:effective", activeVersion: 4 },
    };
    expect(
      revalidateCreatedSandboxPolicyRegistration(
        {
          ...INPUT,
          operation: "continue APF-selected onboarding",
          registration,
        },
        { readFile: vi.fn(() => POLICY) as never },
      ),
    ).toBe(registration);
  });

  it("does not expose receipt refresh through the registration revalidation API (#9833)", () => {
    const replacementMetadata = metadata({
      hash: "sha256:replacement",
      active_version: 5,
    });
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(replacementMetadata);

    expect(() =>
      revalidateCreatedSandboxPolicyRegistration(
        {
          ...INPUT,
          route: "native",
          operation: "continue verified sandbox creation",
          registration: MANAGED_REGISTRATION,
        },
        readyReadOnlyPolicyDeps(),
      ),
    ).toThrow(/creation receipt no longer matches/u);
  });

  it("does not refresh a managed receipt outside its verified create transaction (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ hash: "sha256:replacement", active_version: 5 }));

    expect(() =>
      revalidateCreatedSandboxPolicyRegistration({
        ...INPUT,
        operation: "mutate a completed sandbox",
        registration: MANAGED_REGISTRATION,
      }),
    ).toThrow(/creation receipt no longer matches/u);
  });

  it.each(READ_ONLY_REGISTRATION_CASES)(
    "waits for the exact $label sandbox policy version before registration (#9833)",
    ({ policySource, verify }) => {
      vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
        .mockReturnValueOnce(gatewayInfo())
        .mockReturnValueOnce(metadata({ policy_source: policySource }))
        .mockReturnValueOnce(metadata({ policy_source: policySource }));
      const inspectPolicyReadiness = vi
        .fn()
        .mockReturnValueOnce({
          state: "transient" as const,
          reason: "policy-version-pending" as const,
        })
        .mockReturnValueOnce({ state: "ready" as const });
      const sleep = vi.fn();

      expect(
        verify({
          readFile: vi.fn(() => POLICY) as never,
          inspectPolicyReadiness,
          sleep,
        }),
      ).toMatchObject({ policyAuthority: "externally-managed" });
      expect(inspectPolicyReadiness).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it.each(READ_ONLY_REGISTRATION_CASES)(
    "refuses $label registration while the exact sandbox remains non-Ready (#9833)",
    ({ policySource, verify }) => {
      vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
        .mockReturnValueOnce(gatewayInfo())
        .mockReturnValueOnce(metadata({ policy_source: policySource }));
      const inspectPolicyReadiness = vi.fn(() => ({
        state: "transient" as const,
        reason: "sandbox-not-ready" as const,
      }));
      const sleep = vi.fn();

      expect(() =>
        verify({
          readFile: vi.fn(() => POLICY) as never,
          inspectPolicyReadiness,
          sleep,
        }),
      ).toThrow(/did not reach Ready during policy verification/u);
      expect(inspectPolicyReadiness).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);
    },
  );

  it("refuses a global policy source for APF-selected creation (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ policy_source: "global" }));

    expect(() =>
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        readyReadOnlyPolicyDeps(),
      ),
    ).toThrow(/does not match the selected read-only policy source/u);
  });

  it("refuses an APF-selected policy that omits required entries (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata({ policy: { version: 1, network_policies: {} } }));

    expect(() =>
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        readyReadOnlyPolicyDeps(),
      ),
    ).toThrow(/verified policy must supply the exact required entries/u);
  });

  it.each([
    ["hash", { hash: "sha256:replacement" }],
    ["active version", { active_version: 5 }],
  ])("refuses an APF-selected policy with a changed %s (#9833)", (_field, change) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(metadata(change));

    expect(() =>
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        readyReadOnlyPolicyDeps(),
      ),
    ).toThrow(/effective sandbox policy changed during verification/u);
  });

  it("refuses changed APF-selected policy contents under an unchanged reported identity (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(metadata({ policy: { version: 1, network_policies: {} } }));

    expect(() =>
      verifyCreatedApfInterceptorPolicyRegistration(
        { ...INPUT, operation: "verify APF-selected policy" },
        readyReadOnlyPolicyDeps(),
      ),
    ).toThrow(/verified policy must supply the exact required entries/u);
  });
});
