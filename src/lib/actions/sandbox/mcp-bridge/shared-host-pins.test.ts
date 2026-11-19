// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { trailingJsonPayload } from "../../../../../test/helpers/host-process-harness";

import type { McpSourceEntry } from "../mcp-bridge-contracts";
import { alignMcpTargetWithSharedHostPins } from "./shared-host-pins";

function entry(server: string, overrides: Partial<McpSourceEntry> = {}): McpSourceEntry {
  return {
    server,
    agent: "deepagents",
    url: `https://mcp.example.test/${server}`,
    env: [`${server.toUpperCase()}_TOKEN`],
    policyName: `mcp-bridge-${server}`,
    allowedIps: ["8.8.8.8"],
    ...overrides,
  };
}

function align(
  bridges: Record<string, McpSourceEntry>,
  addresses: string[],
  url = "https://mcp.example.test/two",
  target: Partial<{ trustedPrivateHost: string }> = {},
) {
  return alignMcpTargetWithSharedHostPins({
    operation: "add",
    sandboxName: "alpha",
    server: "two",
    url,
    target: { addresses, ...target },
    bridges,
  });
}

describe("MCP shared-host address pins", () => {
  it("leaves the target alone when no other server uses the host and port", () => {
    const target = { addresses: ["1.1.1.1"] };
    expect(
      alignMcpTargetWithSharedHostPins({
        operation: "add",
        sandboxName: "alpha",
        server: "two",
        url: "https://mcp.example.test/two",
        target,
        bridges: {
          other: entry("other", { url: "https://elsewhere.example.test/mcp" }),
          sameHostOtherPort: entry("sameHostOtherPort", {
            url: "https://mcp.example.test:8443/mcp",
          }),
        },
      }),
    ).toEqual({ ok: true, target, reusedFrom: [] });
  });

  it("reuses the recorded pins when the new answer is a different address of the same host (#13800)", () => {
    const aligned = align({ one: entry("one", { allowedIps: ["8.8.8.8"] }) }, ["1.1.1.1"]);
    expect(aligned).toEqual({
      ok: true,
      target: { addresses: ["8.8.8.8"] },
      reusedFrom: ["one"],
    });
  });

  it("treats an explicit default port as the same endpoint", () => {
    const aligned = align({ one: entry("one", { url: "https://mcp.example.test:443/one" }) }, [
      "1.1.1.1",
    ]);
    expect(aligned).toMatchObject({ ok: true, reusedFrom: ["one"] });
  });

  it("keeps the target when its answer already equals the recorded pins", () => {
    const target = { addresses: ["1.1.1.1", "8.8.8.8"] };
    const aligned = alignMcpTargetWithSharedHostPins({
      operation: "add",
      sandboxName: "alpha",
      server: "two",
      url: "https://mcp.example.test/two",
      target,
      bridges: { one: entry("one", { allowedIps: ["8.8.8.8", "1.1.1.1"] }) },
    });
    expect(aligned).toEqual({ ok: true, target, reusedFrom: [] });
  });

  it("reuses one pin set recorded by several servers", () => {
    const aligned = align(
      { one: entry("one"), three: entry("three", { allowedIps: ["8.8.8.8"] }) },
      ["1.1.1.1"],
    );
    expect(aligned).toMatchObject({ ok: true, reusedFrom: ["one", "three"] });
  });

  it("ignores the server being added and unpinned siblings without endpoint conflicts", () => {
    const aligned = align(
      {
        two: entry("two", { allowedIps: ["9.9.9.9"] }),
        unpinned: entry("unpinned", { allowedIps: undefined }),
      },
      ["1.1.1.1"],
    );
    expect(aligned).toEqual({ ok: true, target: { addresses: ["1.1.1.1"] }, reusedFrom: [] });
  });

  it.each(["add", "update", "refresh"] as const)(
    "refuses %s when a sibling's live endpoint differs only by path",
    (operation) => {
      const refused = alignMcpTargetWithSharedHostPins({
        operation,
        sandboxName: "alpha",
        server: "two",
        url: "https://mcp.example.test/two",
        target: { addresses: ["1.1.1.1"] },
        bridges: {
          one: entry("one", {
            policyConflict: "Agent URL differs from live policy endpoint at /renamed.",
            policyEndpointConflict: true,
          }),
        },
      });
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.message).toMatch(
        /live policy endpoint.*'one'.*Resolve.*conflict.*mcp\.example\.test:443/,
      );
    },
  );

  it.each([{ url: "https://other.example.test/one" }, { allowedIps: undefined }])(
    "refuses unresolved live authority before filtering sibling $url / $allowedIps",
    (overrides) => {
      const refused = align({ one: entry("one", { ...overrides, policyEndpointConflict: true }) }, [
        "1.1.1.1",
      ]);
      expect(refused.ok).toBe(false);
    },
  );

  it.each(["add", "update", "refresh"] as const)(
    "rejects %s when a sibling with invalid denied tools records conflicting pins",
    (operation) => {
      const refused = alignMcpTargetWithSharedHostPins({
        operation,
        sandboxName: "alpha",
        server: "two",
        url: "https://mcp.example.test/two",
        target: { addresses: ["1.1.1.1"] },
        bridges: {
          one: entry("one"),
          three: entry("three", {
            allowedIps: ["9.9.9.9"],
            policyConflict: "Live policy contains invalid denied-tool selectors.",
          }),
        },
      });
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.message).toMatch(
        /'one': 8\.8\.8\.8; 'three': 9\.9\.9\.9.*nemoclaw alpha mcp remove <server>/,
      );
    },
  );

  it("reuses public pins despite a sibling's invalid denied tools", () => {
    expect(
      align(
        {
          one: entry("one", {
            policyConflict: "Live policy contains invalid denied-tool selectors.",
          }),
        },
        ["1.1.1.1"],
      ),
    ).toEqual({ ok: true, target: { addresses: ["8.8.8.8"] }, reusedFrom: ["one"] });
  });

  it("names the servers and pins when existing servers already disagree", () => {
    const refused = align(
      {
        one: entry("one", { allowedIps: ["8.8.8.8"] }),
        three: entry("three", { allowedIps: ["8.8.4.4"] }),
      },
      ["1.1.1.1"],
    );
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.message).toMatch(
      /'two' was not added.*mcp\.example\.test:443.*'one': 8\.8\.8\.8; 'three': 8\.8\.4\.4.*nemoclaw alpha mcp remove <server>/,
    );
  });

  it("refuses to reuse or replace trusted-private pins", () => {
    const privateSibling = entry("one", {
      url: "https://mcp.corp.example/one",
      allowedIps: ["10.20.30.40"],
      trustedPrivateHost: "mcp.corp.example",
      policyConflict: "Live policy contains invalid denied-tool selectors.",
    });
    const privateTarget = align(
      { one: privateSibling },
      ["10.20.30.41"],
      "https://mcp.corp.example/two",
      { trustedPrivateHost: "mcp.corp.example" },
    );
    expect(privateTarget.ok ? "" : privateTarget.message).toMatch(
      /'one' records 10\.20\.30\.40.*does not reuse or replace trusted-private pins/,
    );
    const publicTarget = align(
      { one: privateSibling },
      ["1.1.1.1"],
      "https://mcp.corp.example/two",
    );
    expect(publicTarget.ok ? "" : publicTarget.message).toMatch(
      /does not reuse or replace trusted-private pins/,
    );
  });

  it.each([
    [
      "conflicting public pins",
      { one: entry("one"), three: entry("three", { allowedIps: ["8.8.4.4"] }) },
    ],
    ["trusted-private mismatch", { one: entry("one", { trustedPrivateHost: "mcp.example.test" }) }],
  ])("explains complete retained-provider recovery for %s", (_label, bridges) => {
    const refused = align(bridges, ["1.1.1.1"]);
    expect(refused.ok).toBe(false);
    const message = refused.ok ? "" : refused.message;
    expect(message).toContain("re-export the affected credential variables");
    expect(message).toContain("Removal preserves providers");
    expect(message).toContain("explicit provider cleanup");
    expect(message).toContain("no other sandbox uses them");
    expect(message).toMatch(
      /Before removing.*follow .*manage-mcp-servers#rotate-a-credential to record current denied-tool selectors/,
    );
    expect(message).toContain("Re-add with the recorded selectors");
  });

  it("accepts trusted-private siblings whose pins already match", () => {
    const privateSibling = entry("one", {
      url: "https://mcp.corp.example/one",
      allowedIps: ["10.20.30.40"],
      trustedPrivateHost: "mcp.corp.example",
    });
    const target = { addresses: ["10.20.30.40"], trustedPrivateHost: "mcp.corp.example" };
    expect(
      alignMcpTargetWithSharedHostPins({
        operation: "add",
        sandboxName: "alpha",
        server: "two",
        url: "https://mcp.corp.example/two",
        target,
        bridges: { one: privateSibling },
      }),
    ).toEqual({ ok: true, target, reusedFrom: [] });
  });

  it("rejects recorded public pins that are private or special-use", () => {
    expect(() => align({ one: entry("one", { allowedIps: ["127.0.0.1"] }) }, ["1.1.1.1"])).toThrow(
      /private, local, or special-use address pin/,
    );
  });
});

describe("mcp add on a host that rotates DNS answers (#13800)", () => {
  function runAdd(options: {
    siblings: Record<string, unknown>;
    dnsAnswer: string;
    livePolicy?: Record<string, unknown>;
  }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-shared-host-"));
    const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
process.env.T_MCP_02 = "host-only-secret";
require("node:dns/promises").lookup = async () => [{ address: ${JSON.stringify(options.dnsAnswer)}, family: 4 }];
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const policy = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const sourceState = require("./src/lib/actions/sandbox/mcp-bridge-source.js");
const providerInspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
const livePolicy = ${JSON.stringify(options.livePolicy ?? null)};
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
let appliedTarget;
let mutated = false;
replace(policies, "getPresetContentGatewayState", () => "absent");
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: "absent" }));
replace(adapters, "registerAgentAdapterAtCurrentCredentialRevision", () => { mutated = true; return "v1"; });
replace(policy, "applyGeneratedPolicy", (_sandbox, _entry, target) => { mutated = true; appliedTarget = target; });
replace(state, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "getMcpProviderInspectionRuntimeSelection", () => ({ gatewayName: "nemoclaw-9090", workspace: "default" }));
replace(provider, "ensureMcpBridgeProviderProfile", () => {});
replace(provider, "inspectMcpProvider", () => ({
  credentialKeys: null, exists: false, id: null, resourceVersion: null, type: null,
}));
replace(provider, "inspectMcpProviderAttachments", () => ({ attachments: [] }));
replace(provider, "upsertMcpProvider", () => {
  mutated = true;
  return {
    action: "created",
    inspection: {
      credentialKeys: ["T_MCP_02"], exists: true,
      id: "11111111-2222-4333-8444-555555555555", resourceVersion: 1, type: "nemoclaw-mcp-v1",
    },
  };
});
replace(provider, "attachProvider", () => {});
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(provider, "observeMcpCredentialRevision", () => "v1");
replace(provider, "waitForAttachedMcpCredential", () => "v1");
replace(processRecovery, "restartSandboxGateway", () => ({
  ok: true, restarted: true, healthPassed: true, forwardRecovered: true,
}));
if (livePolicy) {
  replace(policies, "captureRecordedSandboxBasePolicy", async () => JSON.stringify(livePolicy));
  replace(providerInspection, "inspectMcpProvider", async () => ({
    credentialKeys: null, exists: false, id: null, resourceVersion: null, type: null,
  }));
}
replace(sourceState, "inspectSourceBridgeState", async (sandbox, runtimeSelection) => ({
  bridges: livePolicy
    ? await sourceState.joinMcpEntriesToOpenShell(sandbox, ${JSON.stringify(options.siblings)}, runtimeSelection)
    : ${JSON.stringify(options.siblings)},
  sources: { native: {}, legacy: {} },
}));
registry.registerSandbox({
  name: "alpha", agent: "openclaw", gatewayName: "nemoclaw-9090", gatewayPort: 9090,
});
const finish = (error) => process.stdout.write(JSON.stringify({
  message: error ? String(error.message || error) : null,
  appliedAddresses: appliedTarget ? appliedTarget.addresses : null,
  mutated,
}), () => process.exit(0));
require("./src/lib/actions/sandbox/mcp-bridge.js").addMcpBridge("alpha", {
  server: "two",
  url: "https://mcp.example.test/mcp/two",
  env: [{ name: "T_MCP_02" }],
}).then(() => finish(null), finish);
`;
    try {
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
            .filter(Boolean)
            .join(" "),
        },
        timeout: 30_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("host-only-secret");
      return trailingJsonPayload<{
        message: string | null;
        appliedAddresses: string[] | null;
        mutated: boolean;
      }>(result.stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const sibling = (server: string, allowedIps: string[]) => ({
    server,
    agent: "openclaw",
    adapter: "openclaw-config",
    url: `https://mcp.example.test/mcp/${server}`,
    env: [`${server.toUpperCase()}_TOKEN`],
    allowedIps,
    providerName: `nemoclaw-mcp-${server}`,
    policyName: `mcp-bridge-${server}`,
    source: "native",
  });

  it("applies the first server's pins instead of the second answer", { timeout: 40_000 }, () => {
    const outcome = runAdd({
      siblings: { one: sibling("one", ["8.8.8.8"]) },
      dnsAnswer: "8.8.4.4",
      livePolicy: {
        network_policies: {
          mcp_bridge_one: {
            endpoints: [
              {
                host: "mcp.example.test",
                port: 443,
                path: "/mcp/one",
                protocol: "mcp",
                allowed_ips: ["8.8.8.8"],
              },
            ],
          },
        },
      },
    });
    expect(outcome.message).toBeNull();
    expect(outcome.appliedAddresses).toEqual(["8.8.8.8"]);
  });

  it.each([
    ["path", { host: "mcp.example.test", port: 443, path: "/renamed" }],
    ["host", { host: "other.example.test", port: 443, path: "/mcp/one" }],
    ["port", { host: "mcp.example.test", port: 8443, path: "/mcp/one" }],
  ] as const)(
    "refuses before mutation when the joined live sibling has %s drift",
    { timeout: 40_000 },
    (_kind, endpoint) => {
      const outcome = runAdd({
        siblings: { one: sibling("one", ["8.8.8.8"]) },
        dnsAnswer: "1.1.1.1",
        livePolicy: {
          network_policies: {
            mcp_bridge_one: {
              endpoints: [{ ...endpoint, protocol: "mcp", allowed_ips: ["8.8.8.8"] }],
            },
          },
        },
      });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        mutated: false,
        appliedAddresses: null,
        message: expect.stringMatching(/not added.*live policy endpoint.*'one'.*Resolve.*conflict/),
      });
    },
  );

  it.each([undefined, "Live policy contains invalid denied-tool selectors."])(
    "fails before changing anything when existing servers disagree (policy conflict: %s)",
    { timeout: 40_000 },
    (policyConflict) => {
      const outcome = runAdd({
        siblings: {
          one: sibling("one", ["8.8.8.8"]),
          three: {
            ...sibling("three", ["9.9.9.9"]),
            ...(policyConflict ? { policyConflict } : {}),
          },
        },
        dnsAnswer: "8.8.4.4",
      });
      expect(outcome.message).toMatch(/'one': 8\.8\.8\.8; 'three': 9\.9\.9\.9/);
      expect(outcome.mutated).toBe(false);
    },
  );
});
