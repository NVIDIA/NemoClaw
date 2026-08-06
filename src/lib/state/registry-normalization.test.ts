// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_BRIDGE_POLICY_SOURCE } from "./registry-mcp";
import {
  normalizeBaselineExclusions,
  normalizeBaselineExclusionTransition,
  normalizeCustomPolicyEntries,
  normalizeCustomPolicyTransition,
} from "./registry-normalization";

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

async function loadRegistryWith(
  sandboxes: Record<string, unknown>,
  defaultSandbox: unknown = null,
) {
  return loadRegistryDocument({ defaultSandbox, sandboxes });
}

async function loadRegistryDocument(document: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-normalization-"));
  temporaryHomes.push(home);
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "sandboxes.json"), JSON.stringify(document), {
    mode: 0o600,
  });

  process.env.HOME = home;
  vi.resetModules();
  return import("./registry");
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("sandbox registry normalization", () => {
  const servingProfileProvenance = {
    schemaVersion: 1,
    catalogDigest: `sha256:${"1".repeat(64)}`,
    preset: {
      id: "vllm.dgx-spark-gb10.single.example",
      digest: `sha256:${"2".repeat(64)}`,
      displayName: "Example Spark profile",
      supportState: "experimental",
    },
    recipe: {
      id: "vllm.dgx-spark-gb10.single.example",
      digest: `sha256:${"3".repeat(64)}`,
      backend: "vllm",
    },
    model: { id: "example/model", revision: "revision-1" },
    runtimeImage: null,
    estimatedImageDownloadBytes: null,
    estimatedModelDownloadBytes: null,
  } as const;

  it.each([
    null,
    [],
    42,
    "invalid",
  ])("treats a non-object top-level registry document as empty: %j", async (document) => {
    const registry = await loadRegistryDocument(document);

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
  });

  it("drops a malformed sandboxes container at the file boundary", async () => {
    const registry = await loadRegistryDocument({
      defaultSandbox: 42,
      sandboxes: "not-an-object",
    });

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
  });

  it("drops object-shaped entries that do not contain a usable sandbox name", async () => {
    const registry = await loadRegistryWith({
      missing: { createdAt: "2026-07-09T00:00:00.000Z" },
      empty: { name: "" },
      whitespace: { name: "   " },
      wrongType: { name: 42 },
      mismatched: { name: "different" },
      valid: { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    });

    expect(registry.listSandboxes().sandboxes).toEqual([
      { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    ]);
  });

  it("preserves a stale pointer for diagnostics but repairs it on registration", async () => {
    const registry = await loadRegistryWith({ mismatched: { name: "different" } }, "mismatched");

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: "mismatched" });

    registry.registerSandbox({ name: "replacement" });

    expect(registry.listSandboxes().defaultSandbox).toBe("replacement");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBe("replacement");
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("advances the ownership revision when persistence repairs a stale pointer", async () => {
    const registry = await loadRegistryWith({}, "ghost");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("does not retain a default inherited from Object.prototype", async () => {
    const registry = await loadRegistryWith({}, "constructor");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("round-trips the lifecycle proof used to retire a replaced workload", async () => {
    const registry = await loadRegistryWith({});
    const lifecycleGeneration = "22222222-2222-4222-8222-222222222222";
    const lifecycleLiveIdentityFingerprint = "d".repeat(64);

    registry.registerSandbox({
      name: "replacement",
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint,
    });

    vi.resetModules();
    const reloadedRegistry = await import("./registry");
    expect(reloadedRegistry.getSandbox("replacement")).toMatchObject({
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint,
    });
  });

  it("round-trips immutable serving profile provenance while preserving legacy rows (#8246)", async () => {
    const registry = await loadRegistryWith({ legacy: { name: "legacy" } });
    expect(registry.getSandbox("legacy")?.servingProfileProvenance).toBeUndefined();

    registry.registerSandbox({ name: "profile", servingProfileProvenance });
    vi.resetModules();
    const reloadedRegistry = await import("./registry");
    expect(reloadedRegistry.getSandbox("profile")?.servingProfileProvenance).toEqual(
      servingProfileProvenance,
    );
  });

  it("fails closed when persisted serving profile provenance is malformed (#8246)", async () => {
    const registry = await loadRegistryWith({
      profile: {
        name: "profile",
        servingProfileProvenance: { schemaVersion: 1, catalogDigest: "latest" },
      },
    });
    expect(() => registry.getSandbox("profile")).toThrow("invalid serving profile provenance");
  });
});

describe("custom policy pin receipt normalization (#8176)", () => {
  const content = `network_policies:
  private-api:
    endpoints:
      - host: api.corp.example
        allowed_ips: [10.20.30.40]
`;
  const receipt = {
    version: 1 as const,
    contentDigest: createHash("sha256").update(content).digest("hex"),
  };

  it("keeps exact generated-pin authority bound to custom policy content", () => {
    expect(
      normalizeCustomPolicyEntries([
        {
          name: "private-api",
          content,
          sourcePath: "/tmp/private-api.yaml",
          trustedPrivatePins: receipt,
        },
      ]),
    ).toEqual([
      {
        name: "private-api",
        content,
        sourcePath: "/tmp/private-api.yaml",
        trustedPrivatePins: receipt,
      },
    ]);
  });

  it("fails closed when persisted pin authority does not match exact content", () => {
    expect(() =>
      normalizeCustomPolicyEntries([
        {
          name: "private-api",
          content: `${content}\n# changed`,
          trustedPrivatePins: receipt,
        },
      ]),
    ).toThrow(/invalid trusted-private pin authority.*before rebuilding/i);
    expect(() =>
      normalizeCustomPolicyEntries([
        {
          name: "private-api",
          content,
          trustedPrivatePins: { contentDigest: receipt.contentDigest },
        },
      ]),
    ).toThrow(/invalid trusted-private pin authority.*before rebuilding/i);
  });
});

describe("custom policy transition normalization (#8176)", () => {
  const previous = {
    name: "private-api",
    content: "network_policies: {}\n",
    sourcePath: "/tmp/private-api.yaml",
    appliedAt: "2026-08-06T12:00:00.000Z",
  };
  const desired = {
    ...previous,
    content: "network_policies:\n  private_api: {}\n",
    appliedAt: "2026-08-06T12:01:00.000Z",
  };
  const applyTransition = {
    version: 1 as const,
    id: "123e4567-e89b-42d3-a456-426614174010",
    operation: "apply" as const,
    name: "private-api",
    previous,
    desired,
    startedAt: "2026-08-06T12:02:00.000Z",
  };

  it("preserves an exact versioned apply or remove journal", () => {
    expect(normalizeCustomPolicyTransition(applyTransition)).toEqual(applyTransition);
    expect(
      normalizeCustomPolicyTransition({
        ...applyTransition,
        operation: "remove",
        desired: null,
      }),
    ).toEqual({ ...applyTransition, operation: "remove", desired: null });
    expect(normalizeCustomPolicyTransition(undefined)).toBeUndefined();
  });

  it("preserves removal recovery for a legacy custom policy name longer than 63 characters", () => {
    const legacyName = "a".repeat(64);
    const transition = {
      ...applyTransition,
      operation: "remove" as const,
      name: legacyName,
      previous: { ...previous, name: legacyName },
      desired: null,
    };

    expect(normalizeCustomPolicyTransition(transition)).toEqual(transition);
  });

  it.each([
    ["missing version", { version: undefined }],
    ["unsupported version", { version: 2 }],
    ["non-UUID id", { id: "tx-apply" }],
    ["non-canonical UUID", { id: "123E4567-E89B-42D3-A456-426614174010" }],
    ["unsupported operation", { operation: "replace" }],
    ["unsafe name", { name: "private_api" }],
    ["overlong name", { name: "a".repeat(64) }],
    ["non-canonical timestamp", { startedAt: "today" }],
    ["missing previous", { previous: undefined }],
    ["missing desired", { desired: undefined }],
  ])("rejects an incomplete journal with %s", (_label, override) => {
    expect(() => normalizeCustomPolicyTransition({ ...applyTransition, ...override })).toThrow(
      /custom policy transition.*before rebuilding/i,
    );
  });

  it.each([
    ["an apply without desired state", { desired: null }],
    ["a remove without previous state", { operation: "remove", previous: null, desired: null }],
    ["a remove with desired state", { operation: "remove" }],
    ["a mismatched previous name", { previous: { ...previous, name: "other" } }],
    ["a mismatched desired name", { desired: { ...desired, name: "other" } }],
    ["a nested previous transition", { previous: { ...previous, pendingContent: "next" } }],
    ["a nested desired transition", { desired: { ...desired, pendingContent: "next" } }],
  ])("rejects inconsistent intent with %s", (_label, override) => {
    expect(() => normalizeCustomPolicyTransition({ ...applyTransition, ...override })).toThrow(
      /inconsistent intent.*before rebuilding/i,
    );
  });

  it("re-validates exact trusted-private authority in both journal states", () => {
    expect(() =>
      normalizeCustomPolicyTransition({
        ...applyTransition,
        previous: {
          ...previous,
          trustedPrivatePins: { version: 1, contentDigest: "a".repeat(64) },
        },
      }),
    ).toThrow(/invalid previous entry.*before rebuilding/i);
  });

  it("requires content-bound authority for private pins in the desired journal state", () => {
    const privateContent = `network_policies:
  private_api:
    endpoints:
      - host: api.corp.example
        allowed_ips: [10.20.30.40]
`;

    expect(() =>
      normalizeCustomPolicyTransition({
        ...applyTransition,
        desired: { ...desired, content: privateContent },
      }),
    ).toThrow(/missing trusted-private pin authority.*before rebuilding/i);

    const trustedPrivatePins = {
      version: 1 as const,
      contentDigest: createHash("sha256").update(privateContent).digest("hex"),
    };
    expect(
      normalizeCustomPolicyTransition({
        ...applyTransition,
        desired: { ...desired, content: privateContent, trustedPrivatePins },
      }),
    ).toEqual({
      ...applyTransition,
      desired: { ...desired, content: privateContent, trustedPrivatePins },
    });
  });

  it.each([
    "previous",
    "desired",
  ] as const)("rejects managed MCP ownership in the %s journal state", (field) => {
    expect(() =>
      normalizeCustomPolicyTransition({
        ...applyTransition,
        [field]: { ...applyTransition[field], sourcePath: MCP_BRIDGE_POLICY_SOURCE },
      }),
    ).toThrow(/inconsistent intent.*before rebuilding/i);
  });
});

describe("custom policy transition registry helpers (#8176)", () => {
  const previous = {
    name: "private-api",
    content: "network_policies: {}\n",
    sourcePath: "/tmp/private-api.yaml",
    appliedAt: "2026-08-06T12:00:00.000Z",
  };
  const desired = {
    ...previous,
    content: "network_policies:\n  private_api: {}\n",
    appliedAt: "2026-08-06T12:01:00.000Z",
  };

  it("persists and atomically publishes an exact apply journal", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    const transition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174020",
      operation: "apply" as const,
      name: desired.name,
      previous: null,
      desired: { ...desired },
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.beginCustomPolicyTransition("alpha", transition)).toBe(true);
    transition.desired.content = "mutated after begin";
    expect(registry.getCustomPolicyTransition("alpha")).toEqual({
      ...transition,
      desired,
    });
    expect(
      registry.beginCustomPolicyTransition("alpha", {
        ...transition,
        id: "123e4567-e89b-42d3-a456-426614174021",
        desired,
      }),
    ).toBe(false);
    expect(registry.addCustomPolicy("alpha", { name: "other", content: "allow: []\n" })).toBe(
      false,
    );
    expect(
      registry.addBaselineExclusion("alpha", {
        version: 1,
        agent: "hermes",
        key: "other",
        digest: "d".repeat(64),
      }),
    ).toBe(false);
    expect(registry.updateSandbox("alpha", { customPolicies: [] })).toBe(false);
    expect(registry.updateSandbox("alpha", { baselineExclusions: [] })).toBe(false);
    expect(registry.updateSandbox("alpha", { model: "still-safe" })).toBe(true);
    expect(registry.getSandbox("alpha")?.model).toBe("still-safe");
    expect(registry.commitCustomPolicyTransition("alpha", "not-an-id")).toBe(false);
    expect(
      registry.commitCustomPolicyTransition("alpha", "123e4567-e89b-42d3-a456-426614174099"),
    ).toBe(false);
    expect(registry.commitCustomPolicyTransition("alpha", transition.id)).toBe(true);
    expect(registry.getCustomPolicyTransition("alpha")).toBeNull();
    expect(registry.getCustomPolicies("alpha")).toEqual([desired]);
  });

  it("reserves policy transaction fields from generic sandbox updates", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    const transition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174025",
      operation: "apply" as const,
      name: desired.name,
      previous: null,
      desired,
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.updateSandbox("alpha", { customPolicies: [desired] })).toBe(false);
    expect(registry.updateSandbox("alpha", { customPolicyTransition: transition })).toBe(false);
    expect(registry.updateSandbox("alpha", { baselineExclusions: [] })).toBe(false);
    expect(
      registry.updateSandbox("alpha", {
        baselineExclusionTransition: {
          id: "123e4567-e89b-42d3-a456-426614174026",
          operation: "exclude",
          exclusion: {
            version: 1,
            agent: "hermes",
            key: "private_api",
            digest: "d".repeat(64),
          },
          targetLiveDigest: null,
          startedAt: "2026-08-06T12:02:00.000Z",
        },
      }),
    ).toBe(false);
    const sandbox = registry.getSandbox("alpha");
    expect(sandbox?.name).toBe("alpha");
    expect(sandbox?.customPolicies).toBeUndefined();
    expect(sandbox?.customPolicyTransition).toBeUndefined();
    expect(sandbox?.baselineExclusions).toBeUndefined();
    expect(sandbox?.baselineExclusionTransition).toBeUndefined();
  });

  it("retires only exact managed MCP policy ownership through its specialized helper", async () => {
    const registry = await loadRegistryWith({});
    const bridge = {
      server: "github",
      agent: "openclaw",
      url: "https://mcp.example.com/",
      env: ["MCP_GITHUB_TOKEN"],
      providerName: "mcp-github",
      providerId: "provider-1",
      policyName: "mcp-github",
      addedAt: "2026-08-06T12:00:00.000Z",
    };
    registry.registerSandbox({
      name: "alpha",
      mcp: { bridges: { github: bridge } },
    });
    const generated = {
      name: "mcp-github",
      content: "network_policies: {}\n",
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    const operatorOwned = {
      name: "operator-policy",
      content: "network_policies: {}\n",
      sourcePath: "/tmp/operator-policy.yaml",
    };
    expect(registry.addCustomPolicy("alpha", generated)).toBe(true);
    expect(registry.addCustomPolicy("alpha", operatorOwned)).toBe(true);

    expect(registry.completeMcpDestroy("alpha", [bridge])).toBe(true);
    expect(registry.getCustomPolicies("alpha")).toEqual([expect.objectContaining(operatorOwned)]);
  });

  it("requires begin and commit to match the exact previous same-name state", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    expect(registry.addCustomPolicy("alpha", previous)).toBe(true);
    expect(registry.addCustomPolicy("alpha", { name: "other", content: "allow: []\n" })).toBe(true);
    const transition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174030",
      operation: "apply" as const,
      name: previous.name,
      previous,
      desired,
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.beginCustomPolicyTransition("alpha", { ...transition, previous: null })).toBe(
      false,
    );
    expect(
      registry.beginCustomPolicyTransition("alpha", {
        ...transition,
        previous: { ...previous, content: "stale\n" },
      }),
    ).toBe(false);
    expect(registry.beginCustomPolicyTransition("alpha", transition)).toBe(true);

    const document = registry.load();
    document.sandboxes.alpha.customPolicies = (document.sandboxes.alpha.customPolicies ?? []).map(
      (entry) =>
        entry.name === previous.name ? { ...entry, content: "concurrent change\n" } : entry,
    );
    registry.save(document);

    expect(registry.commitCustomPolicyTransition("alpha", transition.id)).toBe(false);
    expect(registry.clearCustomPolicyTransition("alpha", transition.id)).toBe(false);
    expect(registry.getCustomPolicyTransition("alpha")).toEqual(transition);
    expect(registry.getCustomPolicies("alpha")).toEqual([
      { ...previous, content: "concurrent change\n" },
      { name: "other", content: "allow: []\n", appliedAt: expect.any(String) },
    ]);
  });

  it("does not let a custom transition claim managed MCP policy ownership", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    registry.registerSandbox({ name: "beta" });
    const generated = {
      ...desired,
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    expect(registry.addCustomPolicy("alpha", generated)).toBe(true);

    expect(
      registry.beginCustomPolicyTransition("alpha", {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174035",
        operation: "remove",
        name: generated.name,
        previous: generated,
        desired: null,
        startedAt: "2026-08-06T12:02:00.000Z",
      }),
    ).toBe(false);
    expect(
      registry.beginCustomPolicyTransition("beta", {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174036",
        operation: "apply",
        name: generated.name,
        previous: null,
        desired: generated,
        startedAt: "2026-08-06T12:02:00.000Z",
      }),
    ).toBe(false);
    expect(registry.getCustomPolicyTransition("alpha")).toBeNull();
    expect(registry.getCustomPolicyTransition("beta")).toBeNull();
    expect(registry.getCustomPolicies("alpha")).toEqual([generated]);
  });

  it("clears or commits an exact remove without changing unrelated policy state", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    const other = {
      name: "other",
      content: "allow: []\n",
      appliedAt: "2026-08-06T11:00:00.000Z",
    };
    expect(registry.addCustomPolicy("alpha", previous)).toBe(true);
    expect(registry.addCustomPolicy("alpha", other)).toBe(true);
    const transition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174040",
      operation: "remove" as const,
      name: previous.name,
      previous,
      desired: null,
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.beginCustomPolicyTransition("alpha", transition)).toBe(true);
    expect(registry.removeCustomPolicyByName("alpha", other.name)).toBe(false);
    expect(registry.clearCustomPolicyTransition("alpha", "bad-id")).toBe(false);
    expect(
      registry.clearCustomPolicyTransition("alpha", "123e4567-e89b-42d3-a456-426614174099"),
    ).toBe(false);
    expect(registry.clearCustomPolicyTransition("alpha", transition.id)).toBe(true);
    expect(registry.getCustomPolicies("alpha")).toEqual([previous, other]);

    const retry = {
      ...transition,
      id: "123e4567-e89b-42d3-a456-426614174041",
      startedAt: "2026-08-06T12:03:00.000Z",
    };
    expect(registry.beginCustomPolicyTransition("alpha", retry)).toBe(true);
    expect(registry.commitCustomPolicyTransition("alpha", retry.id)).toBe(true);
    expect(registry.getCustomPolicyTransition("alpha")).toBeNull();
    expect(registry.getCustomPolicies("alpha")).toEqual([other]);
  });

  it("rejects duplicate same-name committed state before journaling", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    const document = registry.load();
    document.sandboxes.alpha.customPolicies = [previous, { ...previous }];
    registry.save(document);
    const transition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174050",
      operation: "remove" as const,
      name: previous.name,
      previous,
      desired: null,
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.beginCustomPolicyTransition("alpha", transition)).toBe(false);
    expect(registry.getCustomPolicyTransition("alpha")).toBeNull();
  });

  it("serializes custom and baseline policy journals against each other", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha" });
    const baselineTransition = {
      id: "123e4567-e89b-42d3-a456-426614174055",
      operation: "exclude" as const,
      exclusion: {
        version: 1 as const,
        agent: "hermes",
        key: "nous_research",
        digest: "d".repeat(64),
      },
      targetLiveDigest: null,
      startedAt: "2026-08-06T12:02:00.000Z",
    };
    const customTransition = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174056",
      operation: "apply" as const,
      name: desired.name,
      previous: null,
      desired,
      startedAt: "2026-08-06T12:02:00.000Z",
    };

    expect(registry.beginBaselineExclusionTransition("alpha", baselineTransition)).toBe(true);
    expect(registry.beginCustomPolicyTransition("alpha", customTransition)).toBe(false);
    expect(registry.addCustomPolicy("alpha", desired)).toBe(false);
    expect(registry.removeCustomPolicyByName("alpha", desired.name)).toBe(false);
    expect(registry.updateSandbox("alpha", { customPolicyTransition: customTransition })).toBe(
      false,
    );
    expect(registry.updateSandbox("alpha", { agentVersion: "unchanged-boundary" })).toBe(true);
    expect(registry.clearBaselineExclusionTransition("alpha", baselineTransition.id)).toBe(true);

    expect(registry.beginCustomPolicyTransition("alpha", customTransition)).toBe(true);
    expect(registry.beginBaselineExclusionTransition("alpha", baselineTransition)).toBe(false);
    expect(registry.addBaselineExclusion("alpha", baselineTransition.exclusion)).toBe(false);
    expect(registry.removeBaselineExclusion("alpha", baselineTransition.exclusion.key)).toBe(false);
  });

  it("fails closed when a persisted journal is malformed", async () => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        customPolicyTransition: {
          version: 1,
          id: "123e4567-e89b-42d3-a456-426614174060",
          operation: "apply",
          name: "private-api",
          previous: null,
          startedAt: "2026-08-06T12:02:00.000Z",
        },
      },
    });

    expect(() => registry.getCustomPolicyTransition("alpha")).toThrow(
      /incomplete custom policy transition.*before rebuilding/i,
    );
  });
});

describe("baseline exclusion normalization (#7178)", () => {
  const digest = "a".repeat(64);
  const entry = {
    version: 1 as const,
    agent: "hermes",
    key: "nous_research",
    digest,
    acknowledgedAt: "2026-07-19T00:00:00.000Z",
  };

  it("keeps an exact versioned, agent-bound entry", () => {
    expect(
      normalizeBaselineExclusions([
        {
          ...entry,
          appliedAgentVersion: "1",
        },
      ]),
    ).toEqual([{ ...entry, appliedAgentVersion: "1" }]);
  });

  it("preserves an explicitly unknown applied agent version", () => {
    expect(normalizeBaselineExclusions([{ ...entry, appliedAgentVersion: null }])).toEqual([
      { ...entry, appliedAgentVersion: null },
    ]);
  });

  it("fails closed when any persisted record is malformed", () => {
    expect(() => normalizeBaselineExclusions([entry, { ...entry, key: "" }])).toThrow(
      /invalid versioned baseline exclusion.*before rebuilding/i,
    );
    expect(() => normalizeBaselineExclusions(["not-an-object"])).toThrow(
      /malformed baseline exclusion.*before rebuilding/i,
    );
  });

  it("rejects an unversioned record so its baseline source is never guessed (#7194)", () => {
    expect(() => normalizeBaselineExclusions([{ key: entry.key, digest }])).toThrow(
      /invalid versioned baseline exclusion.*before rebuilding/i,
    );
  });

  it("collapses duplicate keys, last wins", () => {
    expect(
      normalizeBaselineExclusions([
        { ...entry, key: "dup", digest: "b".repeat(64) },
        { ...entry, key: "dup", digest: "c".repeat(64) },
      ]),
    ).toEqual([{ ...entry, key: "dup", digest: "c".repeat(64) }]);
  });

  it("returns undefined only for a legacy registry without the field", () => {
    expect(normalizeBaselineExclusions(undefined)).toBeUndefined();
    expect(normalizeBaselineExclusions([])).toBeUndefined();
    expect(() => normalizeBaselineExclusions("nope")).toThrow(/must be an array/i);
    expect(() => normalizeBaselineExclusions([{ ...entry, key: "" }])).toThrow(
      /invalid versioned baseline exclusion/i,
    );
  });
});

describe("baseline exclusion transition normalization (#7178)", () => {
  const sourceDigest = "a".repeat(64);
  const targetDigest = "b".repeat(64);
  const restoreTransition = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    operation: "restore" as const,
    exclusion: { version: 1 as const, agent: "hermes", key: "nous_research", digest: sourceDigest },
    targetLiveDigest: targetDigest,
    startedAt: "2026-07-19T00:00:00.000Z",
  };

  it("preserves an exact well-formed journal", () => {
    expect(normalizeBaselineExclusionTransition(restoreTransition)).toEqual(restoreTransition);
    expect(normalizeBaselineExclusionTransition(undefined)).toBeUndefined();
  });

  it("fails closed for partial operations or invalid live targets", () => {
    expect(() =>
      normalizeBaselineExclusionTransition({ ...restoreTransition, operation: "unknown" }),
    ).toThrow(/incomplete baseline exclusion transition.*before rebuilding/i);
    expect(() =>
      normalizeBaselineExclusionTransition({ ...restoreTransition, targetLiveDigest: null }),
    ).toThrow(/invalid live target.*before rebuilding/i);
    expect(() =>
      normalizeBaselineExclusionTransition({
        ...restoreTransition,
        operation: "exclude",
        targetLiveDigest: "must-be-absent",
      }),
    ).toThrow(/invalid live target.*before rebuilding/i);
  });

  it.each([
    ["non-UUID id", { id: "tx-1" }],
    ["non-canonical timestamp", { startedAt: "yesterday" }],
    [
      "unsafe key",
      { exclusion: { version: 1, agent: "hermes", key: "bad key\nnext", digest: sourceDigest } },
    ],
    [
      "non-SHA source digest",
      { exclusion: { version: 1, agent: "hermes", key: "nous_research", digest: "short" } },
    ],
    ["non-SHA target digest", { targetLiveDigest: "short" }],
  ])("rejects a journal with %s (#7178)", (_label, override) => {
    expect(() =>
      normalizeBaselineExclusionTransition({ ...restoreTransition, ...override }),
    ).toThrow(
      /(?:baseline exclusion transition|invalid versioned baseline exclusion).*before rebuilding/i,
    );
  });
});

describe("baseline exclusion registry helpers (#7178)", () => {
  it("round-trips add, get, and remove keyed by baseline entry", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", agent: "hermes" });

    expect(registry.getBaselineExclusions("alpha")).toEqual([]);

    expect(
      registry.addBaselineExclusion("alpha", {
        version: 1 as const,
        agent: "hermes",
        key: "nous_research",
        digest: "d".repeat(64),
        appliedAgentVersion: null,
      }),
    ).toBe(true);
    const stored = registry.getBaselineExclusions("alpha");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      key: "nous_research",
      digest: "d".repeat(64),
      appliedAgentVersion: null,
    });
    expect(typeof stored[0].acknowledgedAt).toBe("string");

    expect(registry.removeBaselineExclusion("alpha", "nous_research")).toBe(true);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
    expect(registry.removeBaselineExclusion("alpha", "nous_research")).toBe(false);
  });

  it("keeps exclusions independent from a same-named custom preset", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", agent: "hermes" });

    registry.addCustomPolicy("alpha", { name: "brave", content: "version: 1\n" });
    registry.addBaselineExclusion("alpha", {
      version: 1,
      agent: "hermes",
      key: "brave",
      digest: "d".repeat(64),
    });

    expect(registry.getCustomPolicies("alpha").map((p) => p.name)).toEqual(["brave"]);
    expect(registry.getBaselineExclusions("alpha").map((e) => e.key)).toEqual(["brave"]);

    registry.removeBaselineExclusion("alpha", "brave");
    expect(registry.getCustomPolicies("alpha").map((p) => p.name)).toEqual(["brave"]);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
  });

  it("journals and atomically commits an exclude or restore transition", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", agent: "hermes" });
    const exclude = {
      id: "123e4567-e89b-42d3-a456-426614174001",
      operation: "exclude" as const,
      exclusion: {
        version: 1 as const,
        agent: "hermes",
        key: "nous_research",
        digest: "a".repeat(64),
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
      },
      targetLiveDigest: null,
      startedAt: "2026-07-19T00:00:01.000Z",
    };

    expect(registry.beginBaselineExclusionTransition("alpha", exclude)).toBe(true);
    expect(
      registry.beginBaselineExclusionTransition("alpha", {
        ...exclude,
        id: "123e4567-e89b-42d3-a456-426614174002",
      }),
    ).toBe(false);
    expect(registry.getBaselineExclusionTransition("alpha")).toEqual(exclude);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
    expect(registry.commitBaselineExclusionTransition("alpha", "wrong-id")).toBe(false);
    expect(registry.commitBaselineExclusionTransition("alpha", exclude.id)).toBe(true);
    expect(registry.getBaselineExclusionTransition("alpha")).toBeNull();
    expect(registry.getBaselineExclusions("alpha")).toEqual([exclude.exclusion]);

    const restore = {
      id: "123e4567-e89b-42d3-a456-426614174003",
      operation: "restore" as const,
      exclusion: exclude.exclusion,
      targetLiveDigest: "b".repeat(64),
      startedAt: "2026-07-19T00:00:02.000Z",
    };
    expect(registry.beginBaselineExclusionTransition("alpha", restore)).toBe(true);
    expect(registry.commitBaselineExclusionTransition("alpha", restore.id)).toBe(true);
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
    expect(registry.getBaselineExclusionTransition("alpha")).toBeNull();
  });

  it("clears only the exact journal without changing committed exclusions", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({
      name: "alpha",
      baselineExclusions: [
        { version: 1, agent: "hermes", key: "nous_research", digest: "d".repeat(64) },
      ],
    });
    const transition = {
      id: "123e4567-e89b-42d3-a456-426614174004",
      operation: "restore" as const,
      exclusion: {
        version: 1 as const,
        agent: "hermes",
        key: "nous_research",
        digest: "a".repeat(64),
      },
      targetLiveDigest: "b".repeat(64),
      startedAt: "2026-07-19T00:00:02.000Z",
    };
    expect(registry.beginBaselineExclusionTransition("alpha", transition)).toBe(true);
    expect(
      registry.addBaselineExclusion("alpha", {
        version: 1,
        agent: "hermes",
        key: "other",
        digest: "e".repeat(64),
      }),
    ).toBe(false);
    expect(registry.removeBaselineExclusion("alpha", "nous_research")).toBe(false);
    expect(registry.clearBaselineExclusionTransition("alpha", "wrong-id")).toBe(false);
    expect(registry.clearBaselineExclusionTransition("alpha", transition.id)).toBe(true);
    expect(registry.getBaselineExclusions("alpha")).toEqual([
      expect.objectContaining({ key: "nous_research", digest: "d".repeat(64) }),
    ]);
  });

  it("preserves a restore journal when the committed exclusion changed (#7178)", async () => {
    const source = {
      version: 1 as const,
      agent: "hermes",
      key: "nous_research",
      digest: "a".repeat(64),
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
    };
    const registry = await loadRegistryWith({});
    registry.registerSandbox({ name: "alpha", baselineExclusions: [source] });
    const transition = {
      id: "123e4567-e89b-42d3-a456-426614174005",
      operation: "restore" as const,
      exclusion: source,
      targetLiveDigest: "b".repeat(64),
      startedAt: "2026-07-19T00:00:01.000Z",
    };
    expect(registry.beginBaselineExclusionTransition("alpha", transition)).toBe(true);

    const document = registry.load();
    document.sandboxes.alpha.baselineExclusions = [{ ...source, digest: "c".repeat(64) }];
    registry.save(document);

    expect(registry.commitBaselineExclusionTransition("alpha", transition.id)).toBe(false);
    expect(registry.getBaselineExclusionTransition("alpha")).toEqual(transition);
    expect(registry.getBaselineExclusions("alpha")).toEqual([
      { ...source, digest: "c".repeat(64) },
    ]);
  });

  it("refuses to load mixed valid and malformed persisted exclusions", async () => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        baselineExclusions: [
          { version: 1, agent: "hermes", key: "good", digest: "d".repeat(64) },
          { version: 1, agent: "hermes", key: "", digest: "e".repeat(64) },
        ],
      },
    });

    expect(() => registry.listSandboxes()).toThrow(
      /invalid versioned baseline exclusion.*before rebuilding/i,
    );
  });
});
