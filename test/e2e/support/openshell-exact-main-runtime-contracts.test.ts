// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildExactMainLiveExeIdentityScript,
  inspectExactMainNftRuleset,
  parseExactMainPolicyStatus,
} from "../live/openshell-exact-main-runtime-contracts.ts";

function match(left: Record<string, unknown>, right: string | number): Record<string, unknown> {
  return { match: { left, op: "==", right } };
}

function rejectRule(family: "ipv4" | "ipv6", protocol: "tcp" | "udp") {
  return {
    rule: {
      chain: "output",
      expr: [
        match({ meta: { key: "nfproto" } }, family),
        match({ meta: { key: "l4proto" } }, protocol),
        {
          reject: {
            expr: "port-unreachable",
            type: family === "ipv4" ? "icmp" : "icmpv6",
          },
        },
      ],
      family: "inet",
      table: "openshell_bypass",
    },
  };
}

function completeRuleset(): Record<string, unknown> {
  return {
    nftables: [
      { metainfo: { json_schema_version: 1 } },
      { table: { family: "inet", name: "openshell_bypass" } },
      {
        chain: {
          family: "inet",
          hook: "output",
          name: "output",
          policy: "accept",
          prio: 0,
          table: "openshell_bypass",
          type: "filter",
        },
      },
      {
        rule: {
          chain: "output",
          expr: [
            match({ payload: { field: "daddr", protocol: "ip" } }, "10.200.0.1"),
            match({ payload: { field: "dport", protocol: "tcp" } }, 3128),
            { accept: null },
          ],
          family: "inet",
          table: "openshell_bypass",
        },
      },
      {
        rule: {
          chain: "output",
          expr: [match({ meta: { key: "oifname" } }, "lo"), { accept: null }],
          family: "inet",
          table: "openshell_bypass",
        },
      },
      rejectRule("ipv4", "tcp"),
      rejectRule("ipv6", "tcp"),
      rejectRule("ipv4", "udp"),
      rejectRule("ipv6", "udp"),
    ],
  };
}

describe("OpenShell exact-main policy, nft, and process-identity proof helpers", () => {
  it("parses effective and stored revision identities without discarding version or hash", () => {
    expect(
      parseExactMainPolicyStatus(
        JSON.stringify({
          active_version: 17,
          config_revision: 23,
          hash: "sha256:effective",
          policy_source: "sandbox",
          sandbox: "e2e-mcp-dcode",
          status: "effective",
          version: 17,
        }),
      ),
    ).toEqual({
      activeVersion: 17,
      configRevision: 23,
      hash: "sha256:effective",
      policySource: "sandbox",
      sandbox: "e2e-mcp-dcode",
      status: "effective",
      version: 17,
    });
    expect(
      parseExactMainPolicyStatus(
        JSON.stringify({
          active_version: 17,
          hash: "sha256:effective",
          sandbox: "e2e-mcp-dcode",
          status: "loaded",
          version: 17,
        }),
      ),
    ).toMatchObject({ activeVersion: 17, status: "loaded", version: 17 });
  });

  it("requires the policy-accept chain, proxy/loopback accepts, and all four L4 rejects", () => {
    expect(inspectExactMainNftRuleset(JSON.stringify(completeRuleset()))).toEqual({
      chainPolicy: "accept",
      loopbackAcceptIndex: 1,
      proxyAcceptIndex: 0,
      rejectIndexes: { ipv4Tcp: 2, ipv4Udp: 4, ipv6Tcp: 3, ipv6Udp: 5 },
      ruleCount: 6,
    });
  });

  it("rejects the feasible sequential-install partial state instead of calling it green", () => {
    const partial = completeRuleset();
    const entries = partial.nftables as Array<Record<string, unknown>>;
    entries.pop();
    expect(() => inspectExactMainNftRuleset(JSON.stringify(partial))).toThrow(
      "expected exactly one ipv6 udp reject rule, got 0",
    );
  });

  it("keeps the old live inode and new altered-path denial in one process-level probe", () => {
    const script = buildExactMainLiveExeIdentityScript("https://mcp.example.test/mcp");
    const syntax = spawnSync("bash", ["-n"], { encoding: "utf8", input: script });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain('sha256sum "/proc/$old_pid/exe"');
    expect(script).toContain("NEMOCLAW_EXACT_MAIN_REPLACEMENT");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_OLD_FIRST=%s");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_OLD_SECOND=%s");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_NEW=%s");
    expect(script).toContain('[ "$new_status" = 403 ]');
  });
});
