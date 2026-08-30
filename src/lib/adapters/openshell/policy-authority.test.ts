// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntimeModule from "./runtime";
import {
  assertExternalPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  assertRecordedPolicyAuthority,
  captureSandboxBasePolicy,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxPolicyReadiness,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  isExternalPolicyAuthorityRefusalError,
  policyAuthorityInternals,
  type SandboxPolicyAuthorityInspection,
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
    hash: "policy-alpha",
    active_version: 7,
    policy: { version: 1, network_policies: { baseline: { endpoints: ["base.test"] } } },
    ...overrides,
  };
}

function sandboxReadiness(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: "sandbox-alpha",
      name: "alpha",
      labels: {},
      resource_version: 9,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 7,
      ...overrides,
    },
  ]);
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

  it("leaves a sandbox-scoped effective policy owner unknown (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult(JSON.stringify(sandboxMetadata())));

    expect(inspectSandboxPolicyAuthority({ sandboxName: "alpha" })).toEqual({
      authority: "owner-unknown",
      effectivePolicy: {
        version: 1,
        network_policies: { baseline: { endpoints: ["base.test"] } },
      },
      policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
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
  });

  it("requires the exact Ready sandbox row to report the effective policy version (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult(sandboxReadiness()));
    const sandboxIdentityFingerprint = createHash("sha256").update("sandbox-alpha").digest("hex");

    expect(
      inspectOpenShellSandboxPolicyReadiness({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
        sandboxIdentityFingerprint,
        policyVersion: 7,
      }),
    ).toEqual({ state: "ready" });
    expect(captureOpenshell.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "list",
      "-g",
      "nemoclaw-18080",
      "--output",
      "json",
      "--limit",
      "1000",
    ]);
  });

  it.each([
    ["sandbox phase", { phase: "Provisioning" }, "sandbox-not-ready"],
    ["policy version", { current_policy_version: 6 }, "policy-version-pending"],
  ] as const)("classifies a pending %s as transient (#9833)", (_name, change, reason) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult(sandboxReadiness(change)),
    );

    expect(
      inspectOpenShellSandboxPolicyReadiness({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
        sandboxIdentityFingerprint: createHash("sha256").update("sandbox-alpha").digest("hex"),
        policyVersion: 7,
      }),
    ).toEqual({ state: "transient", reason });
  });

  it("fails closed when the Ready row belongs to a replacement sandbox (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult(sandboxReadiness({ id: "sandbox-replacement" })),
    );

    expect(() =>
      inspectOpenShellSandboxPolicyReadiness({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
        sandboxIdentityFingerprint: createHash("sha256").update("sandbox-alpha").digest("hex"),
        policyVersion: 7,
      }),
    ).toThrow(/live sandbox identity changed/u);
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
    ).toEqual({
      authority: "externally-managed",
      effectivePolicy: policy,
      policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
    });
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

  it("reads an active global policy through the bounded selected-gateway boundary (#9833)", () => {
    const policy = { version: 1, network_policies: { required: { endpoints: ["api.test"] } } };
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(captureResult("global revision 7"))
      .mockReturnValueOnce(
        captureResult(
          JSON.stringify({
            scope: "global",
            status: "loaded",
            policy_source: "global",
            hash: "global-policy",
            active_version: 7,
            policy,
          }),
        ),
      );

    expect(inspectActiveGlobalPolicy({ gatewayName: "nemoclaw-18080" })).toEqual({
      state: "active",
      inspection: {
        authority: "externally-managed",
        effectivePolicy: policy,
        policyIdentity: { hash: "global-policy", activeVersion: 7 },
      },
    });
    expect(captureOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["policy", "list", "-g", "nemoclaw-18080", "--global", "--limit", "1"],
      ["policy", "get", "-g", "nemoclaw-18080", "--global", "--full", "--output", "json"],
    ]);
  });

  it("recognizes the OpenShell 0.0.106 fresh-gateway history response as absent (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult("", { stderr: "No global policy history found\n" }));

    expect(inspectActiveGlobalPolicy({ gatewayName: "nemoclaw-18080" })).toEqual({
      state: "absent",
    });
    expect(captureOpenshell).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty output", ""],
    ["an unexpected diagnostic", "captured-stderr-secret"],
  ])("fails closed on %s from a successful global history read (#9833)", (_name, stderr) => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult("", { stderr }),
    );

    const error = errorFrom(() => inspectActiveGlobalPolicy({ gatewayName: "nemoclaw-18080" }));
    expect(error.message).toContain("invalid global policy history");
    expect(error.message).not.toContain("captured-stderr-secret");
  });

  it("keeps a canonical absence response non-authoritative after a failed command (#9833)", () => {
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell").mockReturnValue(
      captureResult("", { status: 7, stderr: "No global policy history found\n" }),
    );

    expect(() => inspectActiveGlobalPolicy({ gatewayName: "nemoclaw-18080" })).toThrow(
      /did not complete successfully/u,
    );
  });

  it("preserves fresh-gateway config and workspace without accepting endpoint overrides (#9833)", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/nemoclaw-openshell-config");
    vi.stubEnv("OPENSHELL_WORKSPACE", "selected-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENAI_API_KEY", "must-not-cross-policy-boundary");
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult("", { stderr: "No global policy history found\n" }));

    expect(inspectActiveGlobalPolicy({ gatewayName: "nemoclaw-18080" })).toEqual({
      state: "absent",
    });
    const options = captureOpenshell.mock.calls[0]?.[1];
    expect(options?.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-18080",
      OPENSHELL_WORKSPACE: "selected-workspace",
      XDG_CONFIG_HOME: "/tmp/nemoclaw-openshell-config",
    });
    expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("binds sandbox and gateway authority reads to the selected config (#9833)", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/nemoclaw-openshell-config");
    vi.stubEnv("OPENSHELL_WORKSPACE", "selected-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENAI_API_KEY", "must-not-cross-policy-boundary");
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(captureResult(JSON.stringify(sandboxMetadata())))
      .mockReturnValueOnce(captureResult("version: 1\n"))
      .mockReturnValueOnce(captureResult("Name: alpha\nId: sandbox-alpha\nPhase: Ready\n"))
      .mockReturnValueOnce(captureResult("Gateway endpoint: http://127.0.0.1:18080\n"));

    inspectSandboxPolicyAuthority({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-18080",
    });
    expect(captureSandboxBasePolicy("alpha", "nemoclaw-18080")).toBe("version: 1\n");
    inspectOpenShellSandboxIdentityFingerprint({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-18080",
    });
    assertOpenShellGatewayPortBinding({ gatewayName: "nemoclaw-18080", gatewayPort: 18080 });

    expect(captureOpenshell).toHaveBeenCalledTimes(4);
    const environments = captureOpenshell.mock.calls.map(([, options]) => options?.env);
    expect(environments).toEqual([
      expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-18080",
        OPENSHELL_WORKSPACE: "selected-workspace",
        XDG_CONFIG_HOME: "/tmp/nemoclaw-openshell-config",
      }),
      expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-18080",
        OPENSHELL_WORKSPACE: "selected-workspace",
        XDG_CONFIG_HOME: "/tmp/nemoclaw-openshell-config",
      }),
      expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-18080",
        OPENSHELL_WORKSPACE: "selected-workspace",
        XDG_CONFIG_HOME: "/tmp/nemoclaw-openshell-config",
      }),
      expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-18080",
        OPENSHELL_WORKSPACE: "selected-workspace",
        XDG_CONFIG_HOME: "/tmp/nemoclaw-openshell-config",
      }),
    ]);
    expect(
      environments.map((environment) =>
        Object.hasOwn(environment ?? {}, "OPENSHELL_GATEWAY_ENDPOINT"),
      ),
    ).toEqual([false, false, false, false]);
    expect(
      environments.map((environment) => Object.hasOwn(environment ?? {}, "OPENAI_API_KEY")),
    ).toEqual([false, false, false, false]);
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
    ["a timeout", { status: null, error: captureError("ETIMEDOUT", "captured-timeout-secret") }],
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

  it("reads one sandbox identity through the canonical bounded adapter (#9833)", () => {
    const captureOpenshell = vi
      .spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValue(captureResult("Name: alpha\nId: sandbox-alpha\nPhase: Ready\n"));

    expect(
      inspectOpenShellSandboxIdentityFingerprint({
        sandboxName: "alpha",
        gatewayName: "nemoclaw-18080",
      }),
    ).toBe(createHash("sha256").update("sandbox-alpha").digest("hex"));
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-18080", "alpha"],
      expect.objectContaining({
        ignoreError: true,
        includeStreams: true,
        maxBuffer: policyAuthorityInternals.captureMaxBytes,
        replaceEnv: true,
        timeout: policyAuthorityInternals.captureTimeoutMs,
      }),
    );
  });

  it("rejects an ambiguous or failed sandbox identity without exposing output (#9833)", () => {
    const captureOpenshell = vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell");
    captureOpenshell.mockReturnValueOnce(
      captureResult("Name: alpha\nId: first-secret\nId: second-secret\nPhase: Ready\n"),
    );
    expect(() =>
      inspectOpenShellSandboxIdentityFingerprint({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
      }),
    ).toThrow("OpenShell did not return one exact durable sandbox ID");

    captureOpenshell.mockReturnValueOnce(
      captureResult("captured-stdout-secret", {
        status: 7,
        stderr: "captured-stderr-secret",
      }),
    );
    const error = errorFrom(() =>
      inspectOpenShellSandboxIdentityFingerprint({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
      }),
    );
    expect(error.message).not.toContain("captured-stdout-secret");
    expect(error.message).not.toContain("captured-stderr-secret");
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
          effectivePolicy: {},
          policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
        },
        requiredPolicy: { network_policies: { required: { endpoints: ["api.test"] } } },
        operation: "apply a preset",
      }),
    ).not.toThrow();
  });
});
