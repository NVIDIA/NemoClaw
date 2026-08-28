// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSandboxBasePolicy: vi.fn(),
  getSandbox: vi.fn(),
  inspectSandboxPolicy: vi.fn(),
  resolveOpenshell: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-state")>()),
  captureSandboxBasePolicy: mocks.captureSandboxBasePolicy,
  inspectSandboxPolicy: mocks.inspectSandboxPolicy,
}));
vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));
vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));
vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

import { applyPresetContent, inspectPolicyMutationContext, removePreset } from "./index";

const sandboxName = "live-policy";
const preset = `preset:\n  name: weather\n  description: Weather\nnetwork_policies:\n  weather:\n    endpoints:\n      - host: wttr.in\n        port: 443\n`;
const hostEntry = { endpoints: [{ host: "approved.example.com", port: 443 }] };

describe("live OpenShell policy mutations", () => {
  let livePolicy: string;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry },
    });
    mocks.getSandbox.mockReturnValue({ name: sandboxName, gatewayName: "nemoclaw" });
    mocks.inspectSandboxPolicy.mockImplementation(() => ({
      policySource: "sandbox",
      effectivePolicy: YAML.parse(livePolicy),
      policyIdentity: { hash: "sha256:live", activeVersion: 1 },
    }));
    mocks.captureSandboxBasePolicy.mockImplementation(() => livePolicy);
    mocks.runCapture.mockImplementation(() => livePolicy);
    mocks.resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    mocks.run.mockImplementation((command: readonly string[]) => {
      const policyIndex = command.indexOf("--policy");
      livePolicy = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      return { status: 0 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses live policy state without a registry owner or receipt", () => {
    expect(inspectPolicyMutationContext(sandboxName, "inspect policy")).toEqual(
      expect.objectContaining({ gatewayName: "nemoclaw" }),
    );
    expect(inspectPolicyMutationContext(sandboxName, "inspect policy")).not.toHaveProperty(
      "authority",
    );
  });

  it("preserves an out-of-band host entry while adding and removing a preset", () => {
    expect(applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({ host_approval: hostEntry, weather: expect.any(Object) }),
    );

    expect(removePreset(sandboxName, "weather", { nonFatal: true })).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
  });

  it("derives custom preset identity from namespaced OpenShell keys", () => {
    expect(
      applyPresetContent(sandboxName, "weather", preset, {
        custom: { sourcePath: "/tmp/weather.yaml" },
        nonFatal: true,
      }),
    ).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty(
      "nemoclaw_custom__weather__weather",
    );
  });
});
