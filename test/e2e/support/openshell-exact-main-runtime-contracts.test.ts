// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import * as policy from "../../../src/lib/policy";
import {
  assertExactMainPolicyNftAndIdentityContracts,
  buildExactMainLiveExeIdentityScript,
  buildExactMainNftInspectionScript,
  DIRECT_BYPASS_PROBE_CODE,
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
  it("applies and restores the identity proof through live OpenShell policy authority", async () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF", "1");
    const basePolicy = "version: 1\nnetwork_policies: {}\n";
    const policyMutations: Array<{ document: string; operation: string | undefined }> = [];
    const setPolicy = vi
      .spyOn(policy, "setPolicyDocument")
      .mockImplementation((_sandboxName, document, options) => {
        policyMutations.push({ document, operation: options?.operation });
        return true;
      });
    const success = (stdout: string) => ({
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout,
      timedOut: false,
    });
    const openshell = vi
      .fn()
      .mockResolvedValueOnce(success(basePolicy))
      .mockResolvedValueOnce(
        success(
          JSON.stringify({
            active_version: 1,
            config_revision: 1,
            hash: "sha256:before",
            policy_source: "sandbox",
            sandbox: "exact-main-proof",
            status: "effective",
            version: 1,
          }),
        ),
      )
      .mockResolvedValueOnce({
        ...success(""),
        exitCode: 1,
        stderr: "stop after live-policy mutation",
      })
      .mockResolvedValueOnce(success(basePolicy));
    const sandbox = {
      openshell,
    } as never;

    try {
      await expect(
        assertExactMainPolicyNftAndIdentityContracts({
          artifacts: {} as never,
          cleanup: { add: vi.fn() } as never,
          host: {} as never,
          mcpUrl: "https://mcp.example.test/mcp",
          sandbox,
          sandboxName: "exact-main-proof",
        }),
      ).rejects.toThrow("stop after live-policy mutation");
    } finally {
      setPolicy.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(policyMutations).toHaveLength(2);
    expect(policyMutations[0]?.document).toContain("exact_main_live_exe_identity");
    expect(policyMutations[0]?.operation).toBe("apply the exact-main live-exe identity policy");
    expect(policyMutations[1]?.document).toBe(basePolicy.trim());
    expect(policyMutations[1]?.operation).toBe("restore the exact-main policy proof");
    const openshellCalls = openshell.mock.calls.map(([args]) => args as string[]);
    expect(openshellCalls.some((args) => args[0] === "policy" && args[1] === "set")).toBe(false);
  });

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
      configRevision: "23",
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

  it("preserves OpenShell unsigned 64-bit config revisions as exact decimal strings", () => {
    const status = parseExactMainPolicyStatus(
      '{"active_version":2,"config_revision":7692118364955054884,"hash":"sha256:effective","policy_source":"sandbox","sandbox":"e2e-mcp-dcode","status":"effective","version":2}',
    );

    expect(status.configRevision).toBe("7692118364955054884");
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

  it("inspects nft rules in either supported OpenShell network topology", () => {
    const script = buildExactMainNftInspectionScript();
    const syntax = spawnSync("sh", ["-n"], { encoding: "utf8", input: script });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain("/usr/sbin/nft /sbin/nft /usr/bin/nft");
    expect(script).toContain("nft executable not found");
    expect(script).toContain("/var/run/netns/sandbox-*");
    expect(script).toContain('ip netns pids "$namespace" 2>/dev/null');
    expect(script).toContain('nsenter --net="$namespace_path" -- "$nft_path"');
    expect(script).toContain('exec "$nft_path" -j list table inet openshell_bypass');
    expect(script).toContain('if [ "$active_namespace_count" -gt 1 ]');
  });

  it("accepts immediate refused and permission-denied bypass outcomes", () => {
    expect(DIRECT_BYPASS_PROBE_CODE).toContain("denial_errnos = {errno.ECONNREFUSED, errno.EPERM}");
    expect(DIRECT_BYPASS_PROBE_CODE).toContain(
      'tcp_error.get("errno") not in denial_errnos or udp_error.get("errno") not in denial_errnos',
    );
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
    expect(script).toContain('while [ "$allowed_attempt" -lt 50 ]');
    expect(script).toContain('[ "$allowed_status" = 200 ] && break');
    expect(script).toContain('connect_until_allowed "$first_result"');
    expect(script).toContain('connect_until_allowed "$second_result"');
    expect(script).toContain("expected initial live-exe CONNECT 200");
    expect(script).toContain("expected replacement live-exe CONNECT 403");
  });
});
