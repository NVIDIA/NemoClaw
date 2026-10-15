// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxError } from "../../adapters/openshell/sandbox-observer";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  getSandbox: vi.fn(),
  captureOpenshell: vi.fn(() => ({ status: 0, output: "" })),
  collectInferenceChecks: vi.fn(() => []),
}));

vi.mock("../../adapters/openshell/sandbox-observer-cli", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../adapters/openshell/sandbox-observer-cli")>();
  return {
    ...actual,
    createCliOpenShellSandboxObserver: () => ({ listSandboxes: mocks.listSandboxes }),
  };
});

vi.mock("../../adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "/usr/bin/openshell",
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
}));

vi.mock("../../agent/defs", () => ({
  getAgentRuntimeKind: () => "gateway",
  loadAgent: () => ({ name: "openclaw" }),
}));

vi.mock("../../gateway-runtime-action", () => ({
  getNamedGatewayLifecycleState: async () => ({
    state: "healthy_named",
    diagnostic: "Status: Connected",
    recoveryBlocked: false,
    unavailable: false,
  }),
  recoverNamedGatewayRuntime: vi.fn(),
}));

vi.mock("../../onboard/gateway-binding", () => ({
  resolveGatewayName: () => "nemoclaw-19080",
  resolveSandboxGatewayName: () => "nemoclaw-19080",
}));

vi.mock("../../onboard/runtime-provider/access", () => ({
  CURRENT_RUNTIME_PROVIDER_BUNDLES: [],
  RuntimeProviderSelectionError: class RuntimeProviderSelectionError extends Error {},
  requireRuntimeProviderBundle: vi.fn(),
  resolveCurrentRuntimeProviderBundle: () => ({
    preflightDoctor: {
      inspectHost: () => ({
        group: "Host",
        label: "Runtime provider",
        status: "ok",
        detail: "available",
      }),
    },
  }),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  getConfiguredMessagingChannelsFromEntry: () => [],
  getDisabledMessagingChannelsFromEntry: () => [],
}));

vi.mock("./doctor-inference", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-inference")>();
  return {
    ...actual,
    collectInferenceChecks: mocks.collectInferenceChecks,
    collectManagedLlamaCppDoctorChecks: () => [],
    resolveDoctorReasoningEffort: () => undefined,
  };
});

vi.mock("./doctor-system-checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-system-checks")>();
  return {
    ...actual,
    cloudflaredDoctorCheck: () => ({
      group: "Local services",
      label: "cloudflared",
      status: "info",
      detail: "not inspected",
    }),
    inspectSandboxDoctorPortableAuthority: () => ({ kind: "absent" }),
    ollamaDoctorCheck: () => ({
      group: "Local services",
      label: "Ollama",
      status: "info",
      detail: "not inspected",
    }),
    shouldInspectLegacyGatewayContainer: () => false,
    withSandboxDoctorLifecycleLock: async (
      _sandboxName: string,
      operation: () => Promise<unknown>,
    ) => await operation(),
  };
});

import { runSandboxDoctor } from "./doctor";
import { nativeLocalIdentity } from "../../inference/native-local/contract";

describe("doctor live sandbox observation", () => {
  beforeEach(() => {
    mocks.listSandboxes.mockReset();
    mocks.getSandbox.mockReturnValue(null);
    mocks.captureOpenshell.mockClear();
    mocks.collectInferenceChecks.mockClear();
  });

  it.each<{
    label: string;
    error: OpenShellSandboxError;
    expectedDetail: string;
    expectedHint: string;
  }>([
    {
      label: "authentication",
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
      expectedDetail: "OpenShell could not authenticate the sandbox observation.",
      expectedHint: "restore OpenShell authentication for gateway 'nemoclaw-19080'",
    },
    {
      label: "transport",
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
      expectedDetail: "OpenShell could not reach the selected gateway.",
      expectedHint: "run `openshell status`, restore gateway 'nemoclaw-19080'",
    },
  ])(
    "reports a failed $label observation without classifying the sandbox as absent (#9803)",
    async ({ error, expectedDetail, expectedHint }) => {
      mocks.listSandboxes.mockResolvedValue({ ok: false, error });

      const report = await runSandboxDoctor("alpha", ["--json"], { quietJson: true });
      const liveSandbox = report?.checks.find(
        (check) => check.group === "Sandbox" && check.label === "Live sandbox",
      );

      expect(liveSandbox).toMatchObject({
        status: "fail",
        detail: expect.stringContaining(expectedDetail),
        hint: expect.stringContaining(expectedHint),
      });
      const rendered = `${liveSandbox?.detail ?? ""}\n${liveSandbox?.hint ?? ""}`;
      expect(rendered).not.toContain("not present");
      expect(rendered).not.toContain("recreate");
      expect(rendered).not.toContain("credential-value");
    },
  );
});

describe("doctor native local selection", () => {
  it("passes recorded native access to diagnostics without reading a peer shared route (#12558)", async () => {
    const binding = {
      provider: "ollama-local" as const,
      endpointUrl: "http://host.openshell.internal:11434/v1",
      gatewayName: "nemoclaw-19080",
      sandboxName: "alpha",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "sentinel" as const,
    };
    const receipt = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1,
      providerId: "local-id",
    };
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      provider: "ollama-local",
      model: "local-model",
      gatewayName: binding.gatewayName,
      nativeLocalProviderAttachment: receipt,
    });
    mocks.listSandboxes.mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "unreachable", message: "sandbox unavailable" },
    });
    await runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    expect(mocks.captureOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "get"]),
      expect.anything(),
    );
    expect(mocks.collectInferenceChecks).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "ollama-local",
        model: "local-model",
        nativeLocalProviderAttachment: receipt,
      }),
      false,
      expect.anything(),
    );
    mocks.getSandbox.mockReturnValue(null);
  });
});
