// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OpenShellSandboxPolicySetSubmission,
  SetOpenShellSandboxPolicyRequest,
} from "../adapters/openshell/sandbox-policy";
import { digestBaselineEntry } from "./baseline-exclusion";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  inspectSandboxPolicy: vi.fn(),
  readSandboxPolicy: vi.fn(),
  readSandboxPolicyRevision: vi.fn(),
  resolveOpenshell: vi.fn(),
  setSandboxPolicy:
    vi.fn<(request: SetOpenShellSandboxPolicyRequest) => OpenShellSandboxPolicySetSubmission>(),
}));

vi.mock("../adapters/openshell/sandbox-policy-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-policy-cli")>()),
  cliOpenShellSandboxPolicyReader: {
    inspectSandboxPolicy: mocks.inspectSandboxPolicy,
    readSandboxPolicy: mocks.readSandboxPolicy,
    readSandboxPolicyRevision: mocks.readSandboxPolicyRevision,
  },
  cliOpenShellSandboxPolicyWriter: {
    setSandboxPolicy: mocks.setSandboxPolicy,
  },
}));
vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));
vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

import {
  applyPresetContent,
  applyPresets,
  captureRecordedSandboxBasePolicy,
  confirmAppliedPolicySetSubmission,
  excludeBaselineEntry,
  inspectPolicyMutationContext,
  loadPresetForSandbox,
  removePreset,
  restoreBaselineEntry,
  setPolicyDocument,
} from "./index";

const sandboxName = "live-policy";
const preset = `preset:\n  name: weather\n  description: Weather\nnetwork_policies:\n  weather:\n    endpoints:\n      - host: wttr.in\n        port: 443\n`;
const hostEntry = { endpoints: [{ host: "approved.example.com", port: 443 }] };
const policyRead = (document: string) => ({
  ok: true,
  value: { document, appliedRevision: 1 },
});
const policyInspection = (value: Record<string, unknown>) => ({ ok: true, value });

describe("live OpenShell policy mutations", () => {
  let livePolicy: string;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry },
    });
    mocks.getSandbox.mockReturnValue({ name: sandboxName, gatewayName: "nemoclaw" });
    mocks.inspectSandboxPolicy.mockImplementation(() =>
      policyInspection({
        policySource: "sandbox",
        effectivePolicy: YAML.parse(livePolicy),
        policyIdentity: { hash: "sha256:live", activeVersion: 1 },
      }),
    );
    mocks.readSandboxPolicy.mockImplementation(() => policyRead(livePolicy));
    mocks.readSandboxPolicyRevision.mockImplementation((request) => ({
      ok: true,
      value: { document: livePolicy, revision: request.revision },
    }));
    mocks.resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    mocks.setSandboxPolicy.mockImplementation((request) => {
      livePolicy = request.document;
      return {
        outcome: { kind: "applied" },
        status: 0,
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses live policy state without a registry owner or receipt", async () => {
    expect(await inspectPolicyMutationContext(sandboxName, "inspect policy")).toEqual(
      expect.objectContaining({ gatewayName: "nemoclaw" }),
    );
    expect(await inspectPolicyMutationContext(sandboxName, "inspect policy")).not.toHaveProperty(
      "authority",
    );
  });

  it("pins recorded policy reads to the supplied operation target (#10514)", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    } as const;

    expect(
      await captureRecordedSandboxBasePolicy(
        sandboxName,
        "capture a lifecycle policy",
        runtimeSelection,
      ),
    ).toBe(livePolicy);
    expect(mocks.inspectSandboxPolicy).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName,
      runtimeSelection,
    });
    expect(mocks.readSandboxPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName,
        runtimeSelection,
        scope: "base",
      }),
    );
  });

  it("confirms an ambiguous submission when authoritative readback matches", async () => {
    const context = await inspectPolicyMutationContext(sandboxName, "prepare policy confirmation");

    await expect(
      confirmAppliedPolicySetSubmission(
        { status: 1, outcome: { kind: "ambiguous", detail: "response stream reset" } },
        sandboxName,
        livePolicy,
        context,
        "apply the requested policy",
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves an ambiguous submission unconfirmed when readback is unavailable", async () => {
    const context = await inspectPolicyMutationContext(sandboxName, "prepare policy confirmation");
    mocks.readSandboxPolicy.mockReturnValue({
      ok: false,
      error: { kind: "timeout", message: "OpenShell policy read timed out" },
    });

    await expect(
      (async () =>
        await confirmAppliedPolicySetSubmission(
          { status: 1, outcome: { kind: "ambiguous", detail: "response stream reset" } },
          sandboxName,
          livePolicy,
          context,
          "apply the requested policy",
        ))(),
    ).rejects.toThrow("could not verify the resulting base policy");
  });

  it("preserves an out-of-band host entry while adding and removing a preset", async () => {
    expect(await applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(true);
    expect(mocks.setSandboxPolicy).toHaveBeenCalledOnce();
    expect(mocks.readSandboxPolicy).toHaveBeenCalledTimes(3);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({ host_approval: hostEntry, weather: expect.any(Object) }),
    );

    mocks.setSandboxPolicy.mockClear();
    mocks.readSandboxPolicy.mockClear();
    expect(await removePreset(sandboxName, "weather", { nonFatal: true })).toBe(true);
    expect(mocks.setSandboxPolicy).toHaveBeenCalledOnce();
    expect(mocks.readSandboxPolicy).toHaveBeenCalledTimes(3);
    expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
  });

  it("uses one initial base-policy read, one final recheck, and one write readback for a batch", async () => {
    expect(await applyPresets(sandboxName, ["weather"])).toBe(true);

    expect(mocks.readSandboxPolicy).toHaveBeenCalledTimes(3);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("weather");
  });

  it("does not overwrite a host edit that races a prepared full-policy update", async () => {
    let observations = 0;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      observations += 1;
      livePolicy =
        observations === 2
          ? YAML.stringify({
              version: 1,
              network_policies: {
                host_approval: hostEntry,
                concurrent_host_edit: {
                  endpoints: [{ host: "concurrent.example.com", port: 443 }],
                },
              },
            })
          : livePolicy;
      const policy = YAML.parse(livePolicy);
      return policyInspection({
        policySource: "sandbox",
        effectivePolicy: policy,
        policyIdentity: {
          hash: `sha256:live-${String(observations)}`,
          activeVersion: observations,
        },
      });
    });

    expect(await applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(
      false,
    );
    expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    expect(mocks.readSandboxPolicy).toHaveBeenCalledTimes(2);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");
  });

  it("preserves a host edit made after the final reread but before policy set", async () => {
    let activeVersion = 1;
    let concurrentRevision = livePolicy;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      const policy = YAML.parse(livePolicy);
      return policyInspection({
        policySource: "sandbox",
        effectivePolicy: policy,
        policyIdentity: { hash: `sha256:live-${String(activeVersion)}`, activeVersion },
      });
    });
    mocks.readSandboxPolicyRevision.mockImplementation((request) => ({
      ok: true,
      value: { document: concurrentRevision, revision: request.revision },
    }));
    let writes = 0;
    mocks.setSandboxPolicy
      .mockImplementationOnce((request) => {
        writes += 1;
        const requested = request.document;
        const concurrent = YAML.parse(livePolicy);
        concurrent.network_policies.concurrent_host_edit = {
          endpoints: [{ host: "concurrent.example.com", port: 443 }],
        };
        concurrentRevision = YAML.stringify(concurrent);
        activeVersion = 2;
        livePolicy = requested;
        activeVersion += 1;
        return { outcome: { kind: "applied" }, status: 0 };
      })
      .mockImplementation((request) => {
        writes += 1;
        livePolicy = request.document;
        activeVersion += 1;
        return { outcome: { kind: "applied" }, status: 0 };
      });

    expect(await applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(true);
    expect(writes).toBe(2);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({
        host_approval: hostEntry,
        weather: expect.any(Object),
        concurrent_host_edit: expect.any(Object),
      }),
    );
  });

  it("accepts an ambiguous write only when live readback matches", async () => {
    const desiredPolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, confirmed_after_reset: {} },
    });
    mocks.setSandboxPolicy.mockImplementation((request) => {
      livePolicy = request.document;
      return {
        outcome: { kind: "ambiguous", detail: "openshell: response stream reset" },
        status: 1,
      };
    });

    expect(await setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(true);
    expect(mocks.readSandboxPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName, scope: "base" }),
    );
  });

  it("rejects an ambiguous write when live readback differs", async () => {
    const desiredPolicy = YAML.stringify({
      version: 1,
      network_policies: { requested_but_absent: {} },
    });
    mocks.setSandboxPolicy.mockReturnValue({
      outcome: { kind: "ambiguous", detail: "openshell: response stream reset" },
      status: 1,
    });

    expect(await setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("The current live policy differs from the requested document"),
    );
  });

  it("rejects an ambiguous write when live readback is unavailable", async () => {
    const desiredPolicy = YAML.stringify({ version: 1, network_policies: {} });
    mocks.setSandboxPolicy.mockReturnValue({
      outcome: { kind: "ambiguous", detail: "openshell: response stream reset" },
      status: 1,
    });
    mocks.readSandboxPolicy
      .mockImplementationOnce(() => policyRead(livePolicy))
      .mockReturnValue({
        ok: false,
        error: { kind: "timeout", message: "OpenShell policy read timed out" },
      });

    expect(await setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("The current live policy could not be read"),
    );
  });

  it("removes one baseline entry from the bounded live policy", async () => {
    const baselineEntry = {
      name: "npm_registry",
      endpoints: [{ host: "registry.npmjs.org", port: 443 }],
    };
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, npm_registry: baselineEntry },
    });

    expect(
      await excludeBaselineEntry(sandboxName, "npm_registry", digestBaselineEntry(baselineEntry), {
        nonFatal: true,
      }),
    ).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
  });

  it("does not let baseline exclude or restore overwrite a concurrent host edit", async () => {
    const baselineEntry = {
      name: "npm_registry",
      endpoints: [{ host: "registry.npmjs.org", port: 443 }],
    };
    const concurrentEntry = {
      endpoints: [{ host: "concurrent.example.com", port: 443 }],
    };
    const installRace = () => {
      let observations = 0;
      const observe = () => {
        observations += 1;
        const policy = YAML.parse(livePolicy);
        return policyInspection({
          policySource: "sandbox",
          effectivePolicy: policy,
          policyIdentity: {
            hash: `sha256:baseline-${String(observations)}`,
            activeVersion: observations,
          },
        });
      };
      const observeConcurrentEdit = () => {
        const document = YAML.parse(livePolicy);
        document.network_policies.concurrent_host_edit = concurrentEntry;
        livePolicy = YAML.stringify(document);
        return observe();
      };
      mocks.inspectSandboxPolicy
        .mockReset()
        .mockImplementationOnce(observe)
        .mockImplementationOnce(observeConcurrentEdit)
        .mockImplementation(observe);
    };

    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, npm_registry: baselineEntry },
    });
    installRace();
    expect(
      await excludeBaselineEntry(sandboxName, "npm_registry", digestBaselineEntry(baselineEntry), {
        nonFatal: true,
      }),
    ).toBe(false);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");

    mocks.setSandboxPolicy.mockClear();
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry },
    });
    installRace();
    expect(await restoreBaselineEntry(sandboxName, "npm_registry", { nonFatal: true })).toBe(false);
    expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");
  });

  it("makes no mutation when the bounded base-policy adapter refuses the read", async () => {
    mocks.readSandboxPolicy.mockReturnValue({
      ok: false,
      error: { kind: "timeout", message: "OpenShell policy read timed out" },
    });

    expect(await applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(
      false,
    );
    expect(
      await removePreset(sandboxName, "weather", { nonFatal: true, presetContent: preset }),
    ).toBe(false);
    expect(await applyPresets(sandboxName, ["npm"])).toBe(false);
    expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
  });

  it("derives custom preset identity from namespaced OpenShell keys", async () => {
    expect(
      await applyPresetContent(sandboxName, "weather", preset, {
        custom: { sourcePath: "/tmp/weather.yaml" },
        nonFatal: true,
      }),
    ).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty(
      "nemoclaw_custom__weather__weather",
    );
  });

  it("loads a live custom preset without reporting a built-in miss (#10775)", async () => {
    vi.mocked(console.error).mockClear();
    expect(
      await applyPresetContent(sandboxName, "fixture-weather", preset, {
        custom: { sourcePath: "/tmp/weather.yaml" },
        nonFatal: true,
      }),
    ).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    vi.mocked(console.error).mockClear();

    expect(await loadPresetForSandbox(sandboxName, "fixture-weather")).toContain(
      "nemoclaw_custom__fixture-weather__weather",
    );
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("Preset not found"));
  });

  it("removes a live custom preset without reporting a built-in miss (#10775)", async () => {
    vi.mocked(console.error).mockClear();
    expect(
      await applyPresetContent(sandboxName, "fixture-weather", preset, {
        custom: { sourcePath: "/tmp/weather.yaml" },
        nonFatal: true,
      }),
    ).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    vi.mocked(console.error).mockClear();

    expect(await removePreset(sandboxName, "fixture-weather", { nonFatal: true })).toBe(true);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("Preset not found"));
    expect(YAML.parse(livePolicy).network_policies).not.toHaveProperty(
      "nemoclaw_custom__fixture-weather__weather",
    );
  });

  it("still reports a genuinely missing preset (#10775)", async () => {
    expect(await removePreset(sandboxName, "no-such-preset", { nonFatal: true })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot load preset: no-such-preset"),
    );
  });
});
