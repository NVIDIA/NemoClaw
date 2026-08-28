// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";

import {
  hasManagedMcpPolicyClaims,
  inspectProvableManagedMcpPoliciesForDeadline,
  inspectExactManagedMcpPolicies as inspectRegisteredManagedMcpPolicies,
  inspectRecordedManagedMcpPolicies,
  MCP_BRIDGE_POLICY_SOURCE,
} from "../actions/sandbox/mcp-bridge-policy";
import {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
} from "../actions/sandbox/mcp-bridge-policy-render";
import {
  isOperatorTrustablePrivateIp,
  replayTrustedPrivateEndpoint,
} from "../security/trusted-private-endpoint";
import type { SandboxEntry } from "../state/registry";
import {
  assertLegacyMcpPolicyRestoreSafe,
  composeDeadlineManagedMcpPolicies,
  composeManagedMcpPolicies,
} from "./mcp-policy-transition";

const ADAPTER = "hermes-config";

function registeredPolicy(
  server: string,
  address: string,
): NonNullable<SandboxEntry["customPolicies"]>[number] {
  const host = `${server}.example.com`;
  const target = isOperatorTrustablePrivateIp(address)
    ? (() => {
        const replay = replayTrustedPrivateEndpoint(host, [address]);
        return {
          addresses: [...replay.addresses],
          trustedPrivateCapability: replay.trustedPrivateCapability,
          trustedPrivateHost: replay.host,
        };
      })()
    : { addresses: [address] };
  return {
    name: buildMcpBridgePolicyName(server),
    content: buildMcpBridgePolicyYaml(
      server,
      `https://${host}/mcp`,
      ADAPTER,
      target,
      `sandbox-mcp-${server}`,
    ),
    sourcePath: MCP_BRIDGE_POLICY_SOURCE,
  };
}

function bridge(server: string): NonNullable<NonNullable<SandboxEntry["mcp"]>["bridges"]>[string] {
  return {
    server,
    agent: "hermes",
    adapter: ADAPTER,
    url: `https://${server}.example.com/mcp`,
    env: ["MCP_SECRET"],
    providerName: `sandbox-mcp-${server}`,
    providerId: `provider-${server}`,
    policyName: buildMcpBridgePolicyName(server),
    addedAt: "2026-07-30T00:00:00.000Z",
  };
}

function sandboxWithPolicies(
  policies: Array<ReturnType<typeof registeredPolicy>>,
  bridgeServers = policies.map((policy) => policy.name.replace(/^mcp-bridge-/, "")),
): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    customPolicies: policies,
    mcp: {
      bridges: Object.fromEntries(bridgeServers.map((server) => [server, bridge(server)])),
    },
  };
}

function networkEntry(content: string, server: string): unknown {
  return YAML.parse(content).network_policies[buildMcpBridgePolicyKey(server)];
}

function mutateRegisteredNetworkPolicy(
  policy: ReturnType<typeof registeredPolicy>,
  server: string,
  mutate: (entry: Record<string, unknown>) => void,
): void {
  const document = YAML.parse(policy.content) as {
    network_policies: Record<string, Record<string, unknown>>;
  };
  mutate(document.network_policies[buildMcpBridgePolicyKey(server)]!);
  policy.content = YAML.stringify(document);
}

function livePolicy(
  entries: Array<{ content: string; server: string }>,
  extra: Record<string, unknown> = {},
): string {
  return YAML.stringify({
    version: 1,
    network_policies: {
      ...extra,
      ...Object.fromEntries(
        entries.map(({ content, server }) => [
          buildMcpBridgePolicyKey(server),
          networkEntry(content, server),
        ]),
      ),
    },
  });
}

function inspectExactManagedMcpPolicies(sandbox: SandboxEntry, livePolicyYaml: string) {
  return inspectRegisteredManagedMcpPolicies("alpha", livePolicyYaml, {
    getSandbox: () => sandbox,
  });
}

describe("managed MCP Shields policy transitions (#7952)", () => {
  it("renders a canonical recorded entry for an external policy handoff (#9833)", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");

    expect(
      inspectRecordedManagedMcpPolicies("alpha", {
        getSandbox: () => sandboxWithPolicies([alpha]),
      }),
    ).toEqual([
      expect.objectContaining({
        key: "mcp_bridge_alpha",
        networkPolicy: networkEntry(alpha.content, "alpha"),
        policyName: "mcp-bridge-alpha",
        server: "alpha",
      }),
    ]);
  });

  it("admits only canonical committed registrations that exactly match the live policy", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const sandbox = sandboxWithPolicies([alpha]);

    const exact = inspectExactManagedMcpPolicies(
      sandbox,
      livePolicy([{ content: alpha.content, server: "alpha" }], {
        unrelated_live_entry: { endpoints: [{ host: "unrelated.example.com" }] },
      }),
    );

    expect(exact).toEqual([
      expect.objectContaining({
        key: "mcp_bridge_alpha",
        policyName: "mcp-bridge-alpha",
        server: "alpha",
      }),
    ]);
  });

  it("admits exact recorded private pins only for a trusted-private bridge", () => {
    const alpha = registeredPolicy("alpha", "10.20.30.40");
    const sandbox = sandboxWithPolicies([alpha]);
    Object.assign(sandbox.mcp!.bridges.alpha!, {
      trustedPrivateHost: "alpha.example.com",
      allowedIps: ["10.20.30.40"],
    });

    expect(
      inspectExactManagedMcpPolicies(
        sandbox,
        livePolicy([{ content: alpha.content, server: "alpha" }]),
      ),
    ).toEqual([
      expect.objectContaining({
        key: "mcp_bridge_alpha",
        server: "alpha",
      }),
    ]);
  });

  it("rejects a trusted-private policy that differs from its durable pins", () => {
    const alpha = registeredPolicy("alpha", "10.20.30.40");
    const sandbox = sandboxWithPolicies([alpha]);
    Object.assign(sandbox.mcp!.bridges.alpha!, {
      trustedPrivateHost: "alpha.example.com",
      allowedIps: ["10.20.30.41"],
    });

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandbox,
        livePolicy([{ content: alpha.content, server: "alpha" }]),
      ),
    ).toThrow(/does not match its recorded trusted-private address pins/);
  });

  it.each([
    {
      label: "pending policy content",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.customPolicies![0]!.pendingContent = sandbox.customPolicies![0]!.content;
      },
      expected: /incomplete policy transition/,
    },
    {
      label: "an orphaned generated registration",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.customPolicies!.push(registeredPolicy("orphan", "1.1.1.1"));
      },
      expected: /no committed managed bridge ownership/,
    },
    {
      label: "an incomplete bridge add",
      mutate: (sandbox: SandboxEntry) => {
        sandbox.mcp!.bridges.alpha!.addState = "prepared";
      },
      expected: /lifecycle transition is incomplete/,
    },
  ])("fails closed on $label", ({ mutate, expected }) => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const sandbox = sandboxWithPolicies([alpha]);
    mutate(sandbox);

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandbox,
        livePolicy(
          (sandbox.customPolicies ?? []).map((policy) => ({
            content: policy.content,
            server: policy.name.replace(/^mcp-bridge-/, ""),
          })),
        ),
      ),
    ).toThrow(expected);
  });

  it("fails closed when the live policy differs from the ownership record", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const drifted = registeredPolicy("alpha", "1.1.1.1");

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandboxWithPolicies([alpha]),
        livePolicy([{ content: drifted.content, server: "alpha" }]),
      ),
    ).toThrow(/drifted from its ownership record/);
  });

  it("rejects matching registry and live documents with weakened generated semantics", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    mutateRegisteredNetworkPolicy(alpha, "alpha", (entry) => {
      const endpoint = (entry.endpoints as Array<Record<string, unknown>>)[0]!;
      endpoint.enforcement = "observe";
    });
    const sandbox = sandboxWithPolicies([alpha]);
    const live = livePolicy([{ content: alpha.content, server: "alpha" }]);

    expect(() => inspectExactManagedMcpPolicies(sandbox, live)).toThrow(
      /non-canonical generated content/,
    );
    expect(
      inspectProvableManagedMcpPoliciesForDeadline("alpha", live, {
        getSandbox: () => sandbox,
      }),
    ).toEqual({
      policies: [],
      omissions: [
        expect.objectContaining({
          server: "alpha",
          reason: expect.stringMatching(/non-canonical generated content/),
        }),
      ],
    });
  });

  it.each([
    {
      label: "a private literal",
      pins: ["127.0.0.1"],
      expected: /invalid public address pins/,
    },
    {
      label: "a scoped public IPv6 literal",
      pins: ["2001:4860:4860::8888%lo0"],
      expected: /invalid public address pins/,
    },
    {
      label: "duplicate literals",
      pins: ["8.8.8.8", "8.8.8.8"],
      expected: /non-canonical public address pins/,
    },
    {
      label: "unsorted literals",
      pins: ["8.8.8.8", "1.1.1.1"],
      expected: /non-canonical public address pins/,
    },
  ])("rejects matching registry and live documents with $label", ({ pins, expected }) => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    mutateRegisteredNetworkPolicy(alpha, "alpha", (entry) => {
      const endpoint = (entry.endpoints as Array<Record<string, unknown>>)[0]!;
      endpoint.allowed_ips = pins;
    });

    expect(() =>
      inspectExactManagedMcpPolicies(
        sandboxWithPolicies([alpha]),
        livePolicy([{ content: alpha.content, server: "alpha" }]),
      ),
    ).toThrow(expected);
  });

  it("fails closed on a generated policy record without managed MCP state", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "hermes",
      customPolicies: [alpha],
    };
    const deps = { getSandbox: () => sandbox };

    expect(hasManagedMcpPolicyClaims("alpha", deps)).toBe(true);
    expect(() =>
      inspectRegisteredManagedMcpPolicies(
        "alpha",
        livePolicy([{ content: alpha.content, server: "alpha" }]),
        deps,
      ),
    ).toThrow(/no committed managed bridge ownership/);
  });

  it("treats residual managed server history as an ownership claim", () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "hermes",
      mcp: { bridges: {}, managedServerNames: ["retired"] },
    };
    const deps = { getSandbox: () => sandbox };

    expect(hasManagedMcpPolicyClaims("alpha", deps)).toBe(true);
    expect(
      inspectRegisteredManagedMcpPolicies(
        "alpha",
        livePolicy([], { unrelated_live_entry: {} }),
        deps,
      ),
    ).toEqual([]);
  });

  it.each([
    {
      label: "no sandbox registry entry",
      sandbox: undefined,
    },
    {
      label: "only residual ownership history",
      sandbox: {
        name: "alpha",
        agent: "hermes",
        mcp: { bridges: {}, managedServerNames: ["retired"] },
      } satisfies SandboxEntry,
    },
  ])("rejects an unclassified reserved live key with $label", ({ sandbox }) => {
    expect(() =>
      inspectRegisteredManagedMcpPolicies("alpha", livePolicy([], { mcp_bridge_retired: {} }), {
        getSandbox: () => sandbox ?? null,
      }),
    ).toThrow(
      /Reserved MCP policy key "mcp_bridge_retired".*no committed managed bridge ownership/,
    );
  });

  it("escapes unclassified live policy keys in operator diagnostics", () => {
    const maliciousKey = "mcp_bridge_\u001b[31mforged\nline\u0085";

    let failure: unknown;
    try {
      inspectRegisteredManagedMcpPolicies("alpha", livePolicy([], { [maliciousKey]: {} }), {
        getSandbox: () => null,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      String.raw`"mcp_bridge_\u001b[31mforged\u000aline\u0085"`,
    );
    expect((failure as Error).message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("escapes malformed registry bridge keys in strict ownership diagnostics", () => {
    const maliciousServer = "alpha\u001b[31mforged\nline\u0085";
    const sandbox = sandboxWithPolicies([]);
    sandbox.mcp!.bridges = {
      [maliciousServer]: bridge("different-server"),
    };

    let failure: unknown;
    try {
      inspectExactManagedMcpPolicies(sandbox, livePolicy([]));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      String.raw`"alpha\u001b[31mforged\u000aline\u0085"`,
    );
    expect((failure as Error).message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("retains additions while restoring the restrictive snapshot", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const beta = registeredPolicy("beta", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([alpha, beta]),
      livePolicy([
        { content: alpha.content, server: "alpha" },
        { content: beta.content, server: "beta" },
      ]),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
        mcp_bridge_alpha: networkEntry(alpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, current, ["mcp_bridge_alpha"]));

    expect(Object.keys(restored.network_policies).sort()).toEqual([
      "mcp_bridge_alpha",
      "mcp_bridge_beta",
      "restrictive_baseline",
    ]);
  });

  function reconcilePolicies(): void {
    const policies = Array.from({ length: 257 }, (_, index) =>
      registeredPolicy(`server${index}`, "8.8.8.8"),
    );
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies(policies),
      livePolicy(
        policies.map((policy, index) => ({
          content: policy.content,
          server: `server${index}`,
        })),
      ),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: { restrictive_baseline: {} },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, current));

    expect(Object.keys(restored.network_policies).sort()).toEqual(
      ["restrictive_baseline", ...current.map(({ key }) => key)].sort(),
    );
    expect(restored.network_policies.mcp_bridge_server256).toEqual(
      current.find(({ key }) => key === "mcp_bridge_server256")?.networkPolicy,
    );
  }

  const stressTest = testTimeoutOptions(15_000);
  it("reconciles 257 managed policies without loss (#7952)", stressTest, reconcilePolicies);

  it("does not restore a managed MCP policy removed during the shields-down window", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
        mcp_bridge_alpha: networkEntry(alpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, [], ["mcp_bridge_alpha"]));

    expect(restored.network_policies).toEqual({
      restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
    });
  });

  it("replaces a stale snapshot entry with the current exact registration", () => {
    const oldAlpha = registeredPolicy("alpha", "8.8.8.8");
    const currentAlpha = registeredPolicy("alpha", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([currentAlpha]),
      livePolicy([{ content: currentAlpha.content, server: "alpha" }]),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_alpha: networkEntry(oldAlpha.content, "alpha"),
      },
    });

    const restored = YAML.parse(composeManagedMcpPolicies(snapshot, current, ["mcp_bridge_alpha"]));

    expect(restored.network_policies.mcp_bridge_alpha).toEqual(
      networkEntry(currentAlpha.content, "alpha"),
    );
  });

  it("rejects an unclassified reserved key in the restrictive snapshot", () => {
    const currentAlpha = registeredPolicy("alpha", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([currentAlpha]),
      livePolicy([{ content: currentAlpha.content, server: "alpha" }]),
    );
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_alpha: {
          name: "operator-owned-alpha",
          endpoints: [{ host: "operator.example.com" }],
        },
      },
    });

    expect(() => composeManagedMcpPolicies(snapshot, current, [])).toThrow(
      /Reserved MCP policy key "mcp_bridge_alpha".*absent from the saved ownership manifest/,
    );
  });

  it("renders unclassified reserved policy keys without terminal control characters", () => {
    const maliciousKey = "mcp_bridge_\u001b[31mforged\nline\u0085break";
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        [maliciousKey]: {},
      },
    });

    expect(() => composeManagedMcpPolicies(snapshot, [], [])).toThrow(
      'Reserved MCP policy key "mcp_bridge_\\u001b[31mforged\\u000aline\\u0085break" is absent from the saved ownership manifest',
    );
  });

  it("accepts an empty ownership manifest when the snapshot has no reserved keys", () => {
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: { restrictive_baseline: {} },
    });

    expect(YAML.parse(composeManagedMcpPolicies(snapshot, [], [])).network_policies).toEqual({
      restrictive_baseline: {},
    });
  });

  it("rejects a saved managed key that is absent from its policy snapshot", () => {
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
      },
    });

    expect(() => composeManagedMcpPolicies(snapshot, [], ["mcp_bridge_alpha"])).toThrow(
      /absent from its policy snapshot/,
    );
  });

  it.each([
    {
      label: "current managed MCP ownership",
      hasCurrentManagedClaims: true,
      networkPolicies: { restrictive_baseline: {} },
    },
    {
      label: "a managed-shaped key in the snapshot",
      hasCurrentManagedClaims: false,
      networkPolicies: { mcp_bridge_alpha: {} },
    },
  ])("refuses legacy restore with $label", ({ hasCurrentManagedClaims, networkPolicies }) => {
    expect(() =>
      assertLegacyMcpPolicyRestoreSafe(
        YAML.stringify({ version: 1, network_policies: networkPolicies }),
        hasCurrentManagedClaims,
      ),
    ).toThrow(/no managed MCP ownership manifest/);
  });

  it("allows a legacy restore with no current or snapshot MCP ownership", () => {
    expect(() =>
      assertLegacyMcpPolicyRestoreSafe(
        YAML.stringify({
          version: 1,
          network_policies: { restrictive_baseline: {} },
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("proves committed bridges independently while omitting an incomplete add at the deadline", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const beta = registeredPolicy("beta", "1.1.1.1");
    const sandbox = sandboxWithPolicies([alpha, beta]);
    sandbox.mcp!.bridges.beta!.addState = "prepared";

    const result = inspectProvableManagedMcpPoliciesForDeadline(
      "alpha",
      livePolicy([
        { content: alpha.content, server: "alpha" },
        { content: beta.content, server: "beta" },
      ]),
      { getSandbox: () => sandbox },
    );

    expect(result.policies.map((policy) => policy.server)).toEqual(["alpha"]);
    expect(result.omissions).toEqual([
      expect.objectContaining({ server: "beta", reason: expect.stringMatching(/incomplete/) }),
    ]);
  });

  it("omits every deadline claimant whose canonical policy identity collides", () => {
    const collidingPolicy = registeredPolicy("foo-bar", "8.8.8.8");
    const sandbox = sandboxWithPolicies([collidingPolicy], ["foo-bar", "foo_bar"]);

    const result = inspectProvableManagedMcpPoliciesForDeadline(
      "alpha",
      livePolicy([{ content: collidingPolicy.content, server: "foo-bar" }]),
      { getSandbox: () => sandbox },
    );

    expect(result.policies).toEqual([]);
    expect(result.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: "foo-bar",
          reason: expect.stringMatching(/ambiguous bridge ownership/),
        }),
        expect.objectContaining({
          server: "foo_bar",
          reason: expect.stringMatching(/ambiguous bridge ownership/),
        }),
      ]),
    );
  });

  it.each(["destroyPreparedAt", "destroyPendingAt"] as const)(
    "omits every generated policy while %s is present",
    (marker) => {
      const alpha = registeredPolicy("alpha", "8.8.8.8");
      const sandbox = sandboxWithPolicies([alpha]);
      sandbox.mcp![marker] = "2026-07-30T01:00:00.000Z";

      const result = inspectProvableManagedMcpPoliciesForDeadline(
        "alpha",
        livePolicy([{ content: alpha.content, server: "alpha" }]),
        { getSandbox: () => sandbox },
      );

      expect(result.policies).toEqual([]);
      expect(result.omissions).toEqual([
        expect.objectContaining({ server: "alpha", reason: expect.stringMatching(/destruction/) }),
      ]);
    },
  );

  it("omits drift and orphan claims without discarding another exact bridge", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const beta = registeredPolicy("beta", "1.1.1.1");
    const driftedBeta = registeredPolicy("beta", "9.9.9.9");
    const orphan = registeredPolicy("orphan", "4.4.4.4");
    const sandbox = sandboxWithPolicies([alpha, beta, orphan], ["alpha", "beta"]);

    const result = inspectProvableManagedMcpPoliciesForDeadline(
      "alpha",
      livePolicy([
        { content: alpha.content, server: "alpha" },
        { content: driftedBeta.content, server: "beta" },
        { content: orphan.content, server: "orphan" },
      ]),
      { getSandbox: () => sandbox },
    );

    expect(result.policies.map((policy) => policy.server)).toEqual(["alpha"]);
    expect(result.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "beta", reason: expect.stringMatching(/drifted/) }),
        expect.objectContaining({
          policyName: "mcp-bridge-orphan",
          reason: expect.stringMatching(/no committed managed bridge ownership/),
        }),
      ]),
    );
  });

  it("deadline inspection reports an unclassified reserved live key", () => {
    const result = inspectProvableManagedMcpPoliciesForDeadline(
      "alpha",
      livePolicy([], { mcp_bridge_residual: {} }),
      { getSandbox: () => null },
    );

    expect(result).toEqual({
      policies: [],
      omissions: [
        expect.objectContaining({
          key: "mcp_bridge_residual",
          reason: expect.stringMatching(/no committed managed bridge ownership/),
        }),
      ],
    });
  });

  it("deadline composition strips unclassified reserved keys before overlaying proven entries", () => {
    const alpha = registeredPolicy("alpha", "8.8.8.8");
    const beta = registeredPolicy("beta", "1.1.1.1");
    const current = inspectExactManagedMcpPolicies(
      sandboxWithPolicies([alpha, beta]),
      livePolicy([
        { content: alpha.content, server: "alpha" },
        { content: beta.content, server: "beta" },
      ]),
    );
    const operatorEntry = { endpoints: [{ host: "operator.example.com" }] };
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_alpha: networkEntry(alpha.content, "alpha"),
        mcp_bridge_beta: operatorEntry,
        restrictive_baseline: {},
      },
    });

    const result = composeDeadlineManagedMcpPolicies(snapshot, current, ["mcp_bridge_alpha"]);
    const restored = YAML.parse(result.yaml);

    expect(restored.network_policies.mcp_bridge_alpha).toEqual(
      networkEntry(alpha.content, "alpha"),
    );
    expect(restored.network_policies.mcp_bridge_beta).toEqual(networkEntry(beta.content, "beta"));
    expect(result.omissions).toEqual([
      expect.objectContaining({
        key: "mcp_bridge_beta",
        reason: expect.stringMatching(/absent from the saved ownership manifest/),
      }),
    ]);
  });

  it("deadline composition strips every reserved shape with an empty manifest", () => {
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_: {},
        mcp_bridge_legacy_invalid_name: {},
        restrictive_baseline: {},
      },
    });

    const result = composeDeadlineManagedMcpPolicies(snapshot, [], []);

    expect(YAML.parse(result.yaml).network_policies).toEqual({ restrictive_baseline: {} });
    expect(result.omissions.map((entry) => entry.key)).toEqual([
      "mcp_bridge_",
      "mcp_bridge_legacy_invalid_name",
    ]);
  });

  it("deadline composition omits malformed and duplicate manifest entries without delaying lockdown", () => {
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        mcp_bridge_: {},
        mcp_bridge_alpha: {},
        restrictive_baseline: {},
      },
    });

    const result = composeDeadlineManagedMcpPolicies(
      snapshot,
      [],
      ["mcp_bridge_", "restrictive_baseline", "mcp_bridge_alpha", "mcp_bridge_alpha"],
    );

    expect(YAML.parse(result.yaml).network_policies).toEqual({ restrictive_baseline: {} });
    expect(result.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "mcp_bridge_",
          reason: expect.stringMatching(/ownership key.*invalid/),
        }),
        expect.objectContaining({
          key: "restrictive_baseline",
          reason: expect.stringMatching(/ownership key.*invalid/),
        }),
        expect.objectContaining({
          key: "mcp_bridge_alpha",
          reason: expect.stringMatching(/more than once/),
        }),
      ]),
    );
  });

  it("deadline composition restores the restrictive baseline when a saved key is absent", () => {
    const snapshot = YAML.stringify({
      version: 1,
      network_policies: {
        restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
      },
    });

    const result = composeDeadlineManagedMcpPolicies(snapshot, [], ["mcp_bridge_alpha"]);
    const restored = YAML.parse(result.yaml);

    expect(restored.network_policies).toEqual({
      restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
    });
    expect(result.omissions).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/already absent/) }),
    ]);
  });
});
