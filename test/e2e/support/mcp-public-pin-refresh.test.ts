// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as policy from "../../../src/lib/policy";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { runOpenClawPublicPinRefreshProof } from "../live/mcp-bridge-reliability.ts";

describe("public MCP pin refresh denial proof", () => {
  it.each([
    "fresh DNS refusal",
    "strict HTTP refusal",
    "missing audit",
    "stale audit",
    "failed audit",
  ])("handles %s without retrying the network probe", async (scenario) => {
    vi.useFakeTimers();
    const original = "version: 1\nnetwork_policies: {}\n";
    const inspect = vi.spyOn(policy, "inspectPolicyMutationContext").mockResolvedValue({
      basePolicyDocument: original,
    } as never);
    const setPolicy = vi.spyOn(policy, "setPolicyDocument").mockResolvedValue(true);
    const result = { exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    const event =
      "2026-11-14T09:00:00Z OCSF NET:REFUSE [MED] DENIED mcp.example.test [reason:policy_dns_no_valid_address]\n";
    const order: string[] = [];
    const openshell = vi.fn(async () => {
      const before = order.length === 0;
      order.push(before ? "before" : "after");
      return {
        ...result,
        exitCode: !before && scenario === "failed audit" ? 1 : 0,
        stdout:
          scenario === "stale audit" || (!before && scenario !== "missing audit") ? event : "",
      };
    });
    const execShell = vi.fn(async () => {
      order.push("request");
      return scenario === "strict HTTP refusal"
        ? { ...result, stdout: '{"status":403,"body":"policy_denied"}' }
        : {
            ...result,
            exitCode: 1,
            stdout: 'NEMOCLAW_NETWORK_RESULT {"errorCode":"ENOTFOUND","syscall":"getaddrinfo"}\n',
          };
    });
    const nemoclaw = vi.fn().mockResolvedValue(result);
    const accepted = scenario === "fresh DNS refusal" || scenario === "strict HTTP refusal";
    try {
      const outcome = runOpenClawPublicPinRefreshProof(
        { nemoclaw } as unknown as HostCliClient,
        { openshell, execShell } as unknown as SandboxClient,
        "owned-sandbox",
        "https://mcp.example.test/mcp",
      ).then(
        () => true,
        () => false,
      );
      await vi.runAllTimersAsync();
      expect(await outcome).toBe(accepted);
      expect(execShell).toHaveBeenCalledOnce();
      expect(order.slice(0, 2)).toEqual(["before", "request"]);
      expect(openshell).toHaveBeenCalledTimes(
        scenario === "strict HTTP refusal" ? 1 : accepted ? 2 : 6,
      );
      expect(nemoclaw.mock.calls.map(([args]) => args)).toEqual(
        accepted ? [["owned-sandbox", "mcp", "update", "fake", "--refresh-public-pins"]] : [],
      );
      expect(setPolicy).toHaveBeenCalledTimes(accepted ? 1 : 2);
      expect(setPolicy.mock.calls.slice(1).map(([, document]) => document)).toEqual(
        accepted ? [] : [original],
      );
    } finally {
      inspect.mockRestore();
      setPolicy.mockRestore();
      vi.useRealTimers();
    }
  });
});
