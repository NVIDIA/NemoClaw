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
  updateSandbox: vi.fn(),
  listProviderAttachments: vi.fn(),
  getProvider: vi.fn(),
  detachProvider: vi.fn(),
  inspectIdentity: vi.fn(),
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
vi.mock("../adapters/openshell/provider-adapter-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/provider-adapter-cli")>()),
  createCliOpenShellProviderAdapter: () => ({
    listProviderAttachments: mocks.listProviderAttachments,
    getProvider: mocks.getProvider,
    detachProvider: mocks.detachProvider,
  }),
}));
vi.mock("../adapters/openshell/sandbox-identity-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/sandbox-identity-cli")>()),
  inspectOpenShellSandboxIdentityFingerprint: mocks.inspectIdentity,
}));
vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));
vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));

import {
  applyPresetContent,
  applyPresets,
  arePresetsCoveredByPersonalPolicy,
  captureRecordedSandboxBasePolicy,
  confirmAppliedPolicySetSubmission,
  excludeBaselineEntry,
  inspectPolicyMutationContext,
  loadPresetForSandbox,
  getGatewayPresets,
  getPersonalSubsumedCustomPresetNames,
  getPresetContentGatewayState,
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

  describe("Tavily provider revocation (#13082)", () => {
    const tavily = { endpoints: [{ host: "api.tavily.com", port: 443 }] };
    let attached: string[];
    let entry: {
      name: string;
      gatewayName: string;
      webSearchEnabled: boolean;
      webSearchProvider: string | null;
    };

    beforeEach(() => {
      attached = ["shared-search", "inference"];
      entry = {
        name: sandboxName,
        gatewayName: "nemoclaw",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
      };
      mocks.getSandbox.mockImplementation(() => entry);
      mocks.updateSandbox.mockImplementation((_name, patch) => {
        Object.assign(entry, patch);
        return true;
      });
      mocks.inspectIdentity.mockReturnValue("sandbox-identity");
      mocks.listProviderAttachments.mockImplementation(() => ({
        ok: true,
        value: { names: attached },
      }));
      mocks.getProvider.mockImplementation(({ providerName }) => ({
        ok: true,
        value: { name: providerName, type: providerName === "shared-search" ? "tavily" : "nvidia" },
      }));
      mocks.detachProvider.mockImplementation(({ providerName }) => {
        attached = attached.filter((name) => name !== providerName);
        return { ok: true, value: { changed: true } };
      });
      livePolicy = YAML.stringify({
        version: 1,
        network_policies: { host_approval: hostEntry, tavily },
      });
      mocks.inspectSandboxPolicy.mockImplementation(() =>
        policyInspection({
          policySource: "sandbox",
          effectivePolicy: {
            ...YAML.parse(livePolicy),
            network_policies: {
              ...YAML.parse(livePolicy).network_policies,
              ...(attached.includes("shared-search") ? { _provider_shared: tavily } : {}),
            },
          },
          policyIdentity: { hash: "sha256:live", activeVersion: 1 },
        }),
      );
    });

    it.each(["tavily", "tavily-hermes-v1"])(
      "detaches only this sandbox's %s grant and disables its saved selection",
      async (type) => {
        mocks.getProvider.mockImplementation(({ providerName }) => ({
          ok: true,
          value: { name: providerName, type: providerName === "shared-search" ? type : "nvidia" },
        }));
        await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
        expect(attached).toEqual(["inference"]);
        expect(mocks.detachProvider).toHaveBeenCalledExactlyOnceWith({
          target: { kind: "named", gatewayName: "nemoclaw" },
          sandboxName,
          providerName: "shared-search",
        });
        expect(entry.webSearchEnabled).toBe(false);
        expect(entry.webSearchProvider).toBeNull();
        expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
      },
    );

    it("rejects a replaced sandbox before any write", async () => {
      mocks.inspectIdentity.mockReturnValueOnce("old-identity");
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    });

    it("rejects a sandbox whose live identity differs from its recorded identity", async () => {
      mocks.getSandbox.mockReturnValue({
        ...entry,
        lifecycleLiveIdentityFingerprint: "other-sandbox",
      });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
    });

    it("preserves an unrelated saved search provider while revoking Tavily", async () => {
      entry.webSearchProvider = "brave";
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      expect(entry.webSearchEnabled).toBe(true);
      expect(entry.webSearchProvider).toBe("brave");
      expect(mocks.updateSandbox).not.toHaveBeenCalled();
      expect(attached).toEqual(["inference"]);
    });

    it("reconciles a lost detach response without retrying the write", async () => {
      mocks.detachProvider.mockImplementation(() => {
        attached = ["inference"];
        return { ok: false, error: { kind: "timeout", message: "response lost" } };
      });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.detachProvider).toHaveBeenCalledTimes(1);
      expect(mocks.listProviderAttachments).toHaveBeenCalledTimes(2);
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      expect(mocks.detachProvider).toHaveBeenCalledTimes(1);
    });

    it("stops when attachment discovery is unreadable", async () => {
      mocks.listProviderAttachments.mockReturnValue({
        ok: false,
        error: { kind: "timeout", message: "unavailable" },
      });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    });

    it.each([
      ["other port", { host: "api.tavily.com", port: 8443 }],
      ["other port list", { host: "api.tavily.com", ports: [80, 8443] }],
      [
        "other route",
        {
          host: "api.tavily.com",
          port: 443,
          protocol: "rest",
          rules: [{ allow: { method: "POST", path: "/status" } }],
        },
      ],
      [
        "other method",
        {
          host: "api.tavily.com",
          port: 443,
          protocol: "rest",
          rules: [{ allow: { method: "GET", path: "/search" } }],
        },
      ],
      [
        "endpoint path",
        {
          host: "api.tavily.com",
          port: 443,
          protocol: "rest",
          path: "/status",
          rules: [{ allow: { method: "*", path: "/**" } }],
        },
      ],
    ])("preserves an unrelated same-host %s rule after removal", async (_label, endpoint) => {
      const approved = { endpoints: [endpoint], binaries: [{ path: "/opt/venv/bin/python3*" }] };
      livePolicy = YAML.stringify({ version: 1, network_policies: { tavily, approved } });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      expect(YAML.parse(livePolicy).network_policies).toEqual({ approved });
    });

    it.each([
      [
        "REST search",
        { protocol: "rest", rules: [{ allow: { method: "POST", path: "/search" } }] },
      ],
      [
        "REST extract",
        { protocol: "rest", rules: [{ allow: { method: "post", path: "/extract" } }] },
      ],
      ["REST wildcard", { protocol: "rest", rules: [{ allow: { method: "*", path: "/**" } }] }],
      [
        "audit mode",
        {
          protocol: "rest",
          enforcement: "audit",
          rules: [{ allow: { method: "GET", path: "/status" } }],
        },
      ],
      [
        "TLS passthrough",
        {
          protocol: "rest",
          tls: "passthrough",
          rules: [{ allow: { method: "GET", path: "/status" } }],
        },
      ],
      ["ancestor binary", {}],
      [
        "uninspected protocol",
        { protocol: "tcp", rules: [{ allow: { method: "GET", path: "/status" } }] },
      ],
      [
        "unknown glob",
        { protocol: "rest", rules: [{ allow: { method: "POST", path: "/{search,status}" } }] },
      ],
      ["malformed port", { port: "443" }],
    ])("refuses unrevoked %s access after removal", async (_label, fields) => {
      const approved = {
        endpoints: [{ host: "api.tavily.com", ports: [443], ...fields }],
        binaries: [{ path: "/bin/bash" }],
      };
      livePolicy = YAML.stringify({ version: 1, network_policies: { tavily, approved } });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(YAML.parse(livePolicy).network_policies).toEqual({ approved });
    });

    it.each(["api.tavily.com", "*.tavily.com", "*"])(
      "preserves an overlapping operator rule for %s and reports incomplete revocation",
      async (host) => {
        livePolicy = YAML.stringify({
          version: 1,
          network_policies: { tavily, approved_tavily: { endpoints: [{ host, port: 443 }] } },
        });
        await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
        expect(YAML.parse(livePolicy).network_policies).toEqual({
          approved_tavily: { endpoints: [{ host, port: 443 }] },
        });
        expect(console.log).not.toHaveBeenCalledWith("  Removed preset: tavily");
      },
    );

    it("rejects a successful detach acknowledgement when the grant remains attached", async () => {
      mocks.detachProvider.mockReturnValue({ ok: true, value: { changed: true } });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(attached).toEqual(["shared-search", "inference"]);
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    });

    it("allows repeated removal without another detach", async () => {
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      expect(mocks.detachProvider).toHaveBeenCalledTimes(1);
    });

    it("reports a partial removal when policy readback fails after detach", async () => {
      mocks.detachProvider.mockImplementation(() => {
        attached = ["inference"];
        mocks.inspectSandboxPolicy.mockReturnValue({
          ok: false,
          error: { kind: "timeout", message: "unavailable" },
        });
        return { ok: true, value: { changed: true } };
      });
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
      expect(entry.webSearchEnabled).toBe(false);
    });

    it("stops before detachment when disabled selection cannot be saved", async () => {
      mocks.updateSandbox.mockReturnValue(false);
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(false);
      expect(mocks.detachProvider).not.toHaveBeenCalled();
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
    });

    it("restores the direct rule only when the preset is explicitly added", async () => {
      await expect(removePreset(sandboxName, "tavily")).resolves.toBe(true);
      await expect(applyPresets(sandboxName, ["tavily"])).resolves.toBe(true);
      expect(YAML.parse(livePolicy).network_policies.tavily.endpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ host: "api.tavily.com", port: 443 })]),
      );
      expect(attached).toEqual(["inference"]);
    });
  });

  it("uses live policy state without a registry owner or receipt", async () => {
    expect(await inspectPolicyMutationContext(sandboxName, "inspect policy")).toEqual(
      expect.objectContaining({ gatewayName: "nemoclaw" }),
    );
    expect(await inspectPolicyMutationContext(sandboxName, "inspect policy")).not.toHaveProperty(
      "authority",
    );
  });

  it("confirms a web preset superseded by the reviewed Personal policy", async () => {
    await expect(applyPresets(sandboxName, ["personal-open-internet", "weather"])).resolves.toBe(
      true,
    );
    expect(await getGatewayPresets(sandboxName)).toEqual(["personal-open-internet"]);
    await expect(arePresetsCoveredByPersonalPolicy(sandboxName, ["weather"])).resolves.toBe(true);
  });

  it("identifies a live custom web preset that Personal will remove", async () => {
    await applyPresetContent(sandboxName, "fixture-weather", preset, {
      custom: { sourcePath: "/tmp/fixture-weather.yaml" },
      nonFatal: true,
    });
    await expect(
      getPersonalSubsumedCustomPresetNames(sandboxName, [
        "personal-open-internet",
        "fixture-weather",
      ]),
    ).resolves.toEqual(["fixture-weather"]);
    await applyPresets(sandboxName, ["personal-open-internet"]);
    expect(await getGatewayPresets(sandboxName)).toEqual(["personal-open-internet"]);
  });

  it("keeps a custom preset with non-web endpoints in pending confirmation", async () => {
    const mixed = preset.replace(
      "        port: 443",
      "        port: 443\n      - host: wttr.in\n        port: 8443",
    );
    await applyPresetContent(sandboxName, "fixture-weather", mixed, {
      custom: { sourcePath: "/tmp/fixture-weather.yaml" },
      nonFatal: true,
    });
    await expect(
      getPersonalSubsumedCustomPresetNames(sandboxName, [
        "personal-open-internet",
        "fixture-weather",
      ]),
    ).resolves.toEqual([]);
  });

  it("requires non-web endpoints even when Personal is active", async () => {
    await applyPresets(sandboxName, ["personal-open-internet"]);
    await expect(
      arePresetsCoveredByPersonalPolicy(sandboxName, ["weather", "local-inference"]),
    ).resolves.toBe(false);
    await applyPresets(sandboxName, ["local-inference"]);
    await expect(
      arePresetsCoveredByPersonalPolicy(sandboxName, ["weather", "local-inference"]),
    ).resolves.toBe(true);
  });

  it("rejects missing or changed Personal authority during confirmation", async () => {
    await expect(arePresetsCoveredByPersonalPolicy(sandboxName, ["weather"])).resolves.toBe(false);
    await applyPresets(sandboxName, ["personal-open-internet"]);
    const changed = YAML.parse(livePolicy);
    changed.network_policies.personal_open_internet.endpoints = [];
    livePolicy = YAML.stringify(changed);
    await expect(arePresetsCoveredByPersonalPolicy(sandboxName, ["weather"])).resolves.toBe(false);
  });

  it("retains pending confirmation when Personal policy cannot be read", async () => {
    mocks.readSandboxPolicy.mockReturnValue({ ok: false, error: { message: "unavailable" } });
    await expect(arePresetsCoveredByPersonalPolicy(sandboxName, ["weather"])).resolves.toBe(false);
  });

  it.each(["batch", "batch-after-weather", "direct"] as const)(
    "applies, discloses, and recognizes a pricing preset with the custom provider's exact pins (%s)",
    async (path) => {
      const pins = ["34.117.59.81", "104.18.8.134"];
      const endpoint = {
        host: "openrouter.ai",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: pins,
        rules: [{ allow: { method: "POST", path: "/api/v1/chat/completions" } }],
      };
      livePolicy = YAML.stringify({
        version: 1,
        network_policies: {
          _provider_nemoclaw_custom_openrouter_v1: { name: "provider", endpoints: [endpoint] },
          native_hosted_inference: { name: "native_hosted_inference", endpoints: [endpoint] },
        },
      });

      const content = await loadPresetForSandbox(sandboxName, "openclaw-pricing");
      expect(content).not.toBeNull();
      await expect(
        path === "direct"
          ? applyPresetContent(sandboxName, "openclaw-pricing", content!, { nonFatal: true })
          : applyPresets(
              sandboxName,
              path === "batch-after-weather"
                ? ["weather", "openclaw-pricing"]
                : ["openclaw-pricing"],
            ),
      ).resolves.toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        `          allowed IPs: ${[...pins].sort().join(", ")}`,
      );
      const pricing = YAML.parse(livePolicy).network_policies["openclaw-pricing"].endpoints[1];
      expect(pricing.allowed_ips).toEqual([...pins].sort());
      expect(pricing.rules).toEqual([{ allow: { method: "GET", path: "/api/v1/models" } }]);
      expect(await getGatewayPresets(sandboxName)).toContain("openclaw-pricing");
      expect(await getPresetContentGatewayState(sandboxName, content!)).toBe("match");
    },
  );

  it.each(["batch", "direct"] as const)(
    "preserves the standard OpenRouter provider's unpinned pricing route (%s)",
    async (path) => {
      const endpoint = {
        host: "openrouter.ai",
        port: 443,
        rules: [{ allow: { method: "GET", path: "/api/v1/models" } }],
      };
      livePolicy = YAML.stringify({
        version: 1,
        network_policies: {
          _provider_nemoclaw_openrouter_api_v1: { endpoints: [endpoint] },
          native_hosted_inference: { endpoints: [endpoint] },
        },
      });
      const content = await loadPresetForSandbox(sandboxName, "openclaw-pricing");
      expect(content).not.toBeNull();
      await expect(
        path === "direct"
          ? applyPresetContent(sandboxName, "openclaw-pricing", content!, { nonFatal: true })
          : applyPresets(sandboxName, ["openclaw-pricing"]),
      ).resolves.toBe(true);
      const pricing = YAML.parse(livePolicy).network_policies["openclaw-pricing"].endpoints[1];
      expect(pricing.allowed_ips).toBeUndefined();
      expect(pricing.rules).toEqual([{ allow: { method: "GET", path: "/api/v1/models" } }]);
      expect(await getGatewayPresets(sandboxName)).toContain("openclaw-pricing");
      expect(await getPresetContentGatewayState(sandboxName, content!)).toBe("match");
    },
  );

  const mixedRoutes = [
    { key: "_provider_nemoclaw_custom_openrouter_v1", pins: ["34.117.59.81"] },
    { key: "native_hosted_inference", pins: undefined },
  ];
  const conflictingRoutes = [
    { key: "_provider_nemoclaw_custom_openrouter_v1", pins: ["34.117.59.81"] },
    { key: "native_hosted_inference", pins: ["104.18.8.134"] },
  ];
  it.each([
    { path: "direct", routes: mixedRoutes },
    { path: "batch", routes: mixedRoutes },
    { path: "direct", routes: conflictingRoutes },
    { path: "batch", routes: conflictingRoutes },
    { path: "batch-after-weather", routes: conflictingRoutes },
  ])(
    "does not submit $path pricing when live provider pins are invalid ($#)",
    async ({ path, routes }) => {
      livePolicy = YAML.stringify({
        version: 1,
        network_policies: Object.fromEntries(
          routes.map(({ key, pins }) => [
            key,
            {
              endpoints: [
                { host: "openrouter.ai", port: 443, ...(pins ? { allowed_ips: pins } : {}) },
              ],
            },
          ]),
        ),
      });
      const original = livePolicy;
      const content = await loadPresetForSandbox(sandboxName, "openclaw-pricing");
      expect(content).not.toBeNull();

      await expect(
        path === "direct"
          ? applyPresetContent(sandboxName, "openclaw-pricing", content!, { nonFatal: true })
          : applyPresets(
              sandboxName,
              path === "batch-after-weather"
                ? ["weather", "openclaw-pricing"]
                : ["openclaw-pricing"],
            ),
      ).resolves.toBe(false);
      expect(mocks.setSandboxPolicy).not.toHaveBeenCalled();
      expect(livePolicy).toBe(original);
    },
  );

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

  it("bounds every recorded policy read by one absolute observation deadline", async () => {
    const now = vi.fn().mockReturnValueOnce(9_000).mockReturnValue(9_250);

    await expect(
      captureRecordedSandboxBasePolicy(
        sandboxName,
        "capture a bounded lifecycle policy",
        undefined,
        10_000,
        now,
      ),
    ).resolves.toBe(livePolicy);
    expect(mocks.inspectSandboxPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(mocks.readSandboxPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 750 }),
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

  it("verifies preset removal against operator-owned policy while ignoring provider readback (#12048)", async () => {
    const providerEntry = { endpoints: [{ host: "provider.internal", port: 443 }] };
    const weatherPolicy = YAML.stringify({
      version: 1,
      network_policies: {
        host_approval: hostEntry,
        weather: { endpoints: [{ host: "wttr.in", port: 443 }] },
      },
    });
    livePolicy = weatherPolicy;
    mocks.setSandboxPolicy.mockImplementation((request) => {
      const parsed = YAML.parse(request.document);
      parsed.network_policies._provider_token = providerEntry;
      livePolicy = YAML.stringify(parsed);
      return { outcome: { kind: "applied" }, status: 0 };
    });
    expect({
      removed: await removePreset(sandboxName, "weather", {
        nonFatal: true,
        presetContent: preset,
      }),
      network_policies: YAML.parse(livePolicy).network_policies,
    }).toEqual({
      removed: true,
      network_policies: { host_approval: hostEntry, _provider_token: providerEntry },
    });

    mocks.setSandboxPolicy.mockReset();
    mocks.setSandboxPolicy.mockImplementation((request) => {
      const parsed = YAML.parse(request.document);
      delete parsed.network_policies.host_approval;
      livePolicy = YAML.stringify(parsed);
      return { outcome: { kind: "applied" }, status: 0 };
    });
    livePolicy = weatherPolicy;
    vi.mocked(console.error).mockClear();
    expect(
      await removePreset(sandboxName, "weather", { nonFatal: true, presetContent: preset }),
    ).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("the resulting base policy did not match the requested policy"),
    );
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
