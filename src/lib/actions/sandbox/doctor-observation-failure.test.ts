// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxError } from "../../adapters/openshell/sandbox-observer";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
}));

vi.mock("../../adapters/openshell/sandbox-observer-cli", () => ({
  createCliOpenShellSandboxObserver: () => ({ listSandboxes: mocks.listSandboxes }),
  stripOpenShellCliAnsi: (value: string) => value,
}));

vi.mock("../../adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "/usr/bin/openshell",
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: () => ({ status: 0, output: "" }),
}));

vi.mock("../../agent/defs", () => ({
  getAgentRuntimeKind: () => "gateway",
  loadAgent: () => ({ name: "openclaw" }),
}));

vi.mock("../../gateway-runtime-action", () => ({
  getNamedGatewayLifecycleState: () => ({
    state: "healthy_named",
    status: "Status: Connected",
    gatewayInfo: "Gateway: nemoclaw-19080",
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
  getSandbox: () => null,
  getBaselineExclusionTransition: () => null,
  getBaselineExclusions: () => [],
}));

vi.mock("./doctor-inference", () => ({
  collectInferenceChecks: () => [],
  collectManagedLlamaCppDoctorChecks: () => [],
  resolveDoctorReasoningEffort: () => undefined,
}));

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

describe("doctor live sandbox observation", () => {
  beforeEach(() => {
    mocks.listSandboxes.mockReset();
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
