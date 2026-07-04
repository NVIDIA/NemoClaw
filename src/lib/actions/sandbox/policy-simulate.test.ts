// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SimulationSummary } from "../../policy/simulate";
import { type SimulatePolicyResult, simulateSandboxPolicy } from "./policy-simulate";

const SLACK_PRESET = {
  name: "slack",
  endpoints: [
    {
      host: "*.slack.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "POST", path: "/**" } }],
    },
  ],
};

const POST_TO_SLACK = '{"host":"api.slack.com","port":443,"method":"POST","path":"/api/x"}';

const CUSTOM_GITHUB_POLICY_YAML = [
  "network_policies:",
  "  generated:",
  "    endpoints:",
  "      - host: api.github.com",
  "        port: 443",
  "        rules:",
  "          - allow: { method: GET, path: '/**' }",
].join("\n");

function expectOk(result: SimulatePolicyResult): {
  summary: SimulationSummary;
  notes: string[];
} {
  expect(result.kind).toBe("ok");
  return result as { kind: "ok"; summary: SimulationSummary; notes: string[] };
}

function expectError(result: SimulatePolicyResult): string[] {
  expect(result.kind).toBe("error");
  return (result as { kind: "error"; lines: string[] }).lines;
}

function throwBadYaml(): never {
  throw new Error("bad yaml");
}

describe("simulateSandboxPolicy", () => {
  it("returns error when trace file does not exist", () => {
    const result = simulateSandboxPolicy(
      { sandboxName: "alpha", fromFile: "/missing/trace.jsonl" },
      { fileExists: () => false },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("Trace file not found");
  });

  it("returns error when the trace contains no rows at all", () => {
    const result = simulateSandboxPolicy(
      { sandboxName: "alpha", fromFile: "-", stdinLines: ["", "# only-a-comment"] },
      { fileExists: () => true },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("No trace requests found");
  });

  it("evaluates a trace whose only rows are invalid instead of dropping them", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: ["not-json"],
        policyFile: "/policies/slack.yaml",
      },
      {
        fileExists: () => true,
        loadPolicy: () => [SLACK_PRESET],
      },
    );
    const { summary } = expectOk(result);
    expect(summary.totalRequests).toBe(0);
    expect(summary.invalidTraceLines).toHaveLength(1);
    expect(summary.invalidTraceLines[0].reason).toBe("not valid JSON");
  });

  it("returns a clean error when the trace file read fails", () => {
    const result = simulateSandboxPolicy(
      { sandboxName: "alpha", fromFile: "/traces/gone.jsonl" },
      {
        fileExists: () => true,
        loadTrace: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("Failed to read trace file");
    expect(lines[0]).toContain("EACCES");
  });

  it("returns error when candidate policy file is missing", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
        policyFile: "/missing/policy.yaml",
      },
      { fileExists: (p) => p !== "/missing/policy.yaml" },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("Policy file not found");
  });

  it("returns a clean error when the candidate policy file has invalid YAML", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
        policyFile: "/policies/broken.yaml",
      },
      {
        fileExists: () => true,
        loadPolicy: () => throwBadYaml(),
      },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("Failed to parse policy file");
    expect(lines[0]).toContain("bad yaml");
  });

  it("simulates against a candidate policy file and notes candidate mode", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
        policyFile: "/policies/slack.yaml",
      },
      {
        fileExists: () => true,
        loadPolicy: () => [SLACK_PRESET],
      },
    );
    const { summary, notes } = expectOk(result);
    expect(summary.allowed).toBe(1);
    expect(summary.results[0].allowedBy).toBe("slack");
    expect(notes.join(" ")).toContain("Candidate mode");
  });

  it("applies presetName override to candidate presets", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
        policyFile: "/policies/slack.yaml",
        presetName: "candidate",
      },
      {
        fileExists: () => true,
        loadPolicy: () => [SLACK_PRESET],
      },
    );
    const { summary } = expectOk(result);
    expect(summary.results[0].allowedBy).toBe("candidate");
  });

  it("loads active sandbox presets from the registry when no policy file given", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
      },
      {
        fileExists: () => true,
        loadPolicy: () => [SLACK_PRESET],
        getSandboxPolicies: (name) => (name === "alpha" ? ["slack"] : []),
        getCustomPolicies: () => [],
        presetsDir: "/presets",
      },
    );
    const { summary } = expectOk(result);
    expect(summary.allowed).toBe(1);
  });

  it("includes custom and generated policies registered on the sandbox (#6269 review)", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: ['{"host":"api.github.com","port":443,"method":"GET","path":"/repos"}'],
      },
      {
        fileExists: () => false,
        getSandboxPolicies: () => [],
        getCustomPolicies: () => [
          { name: "mcp-bridge-github", content: CUSTOM_GITHUB_POLICY_YAML },
        ],
        presetsDir: "/presets",
      },
    );
    const { summary } = expectOk(result);
    expect(summary.allowed).toBe(1);
    expect(summary.results[0].allowedBy).toBe("mcp-bridge-github");
  });

  it("notes an applied preset whose file is missing instead of silently skipping it", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
      },
      {
        fileExists: () => false,
        getSandboxPolicies: () => ["slack"],
        getCustomPolicies: () => [
          { name: "mcp-bridge-github", content: CUSTOM_GITHUB_POLICY_YAML },
        ],
        presetsDir: "/presets",
      },
    );
    const { notes } = expectOk(result);
    expect(notes.join(" ")).toContain("Applied preset 'slack' has no readable file");
    expect(notes.join(" ")).toContain("under-report");
  });

  it("notes an unparseable custom policy instead of silently skipping it", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: [POST_TO_SLACK],
      },
      {
        fileExists: () => true,
        loadPolicy: () => [SLACK_PRESET],
        getSandboxPolicies: () => ["slack"],
        getCustomPolicies: () => [{ name: "broken-custom", content: "a: [unclosed" }],
        presetsDir: "/presets",
      },
    );
    const { notes } = expectOk(result);
    expect(notes.join(" ")).toContain("Custom policy 'broken-custom' could not be parsed");
  });

  it("returns error when the sandbox has no registered policy content", () => {
    const result = simulateSandboxPolicy(
      {
        sandboxName: "alpha",
        fromFile: "-",
        stdinLines: ['{"host":"api.slack.com","port":443}'],
      },
      {
        fileExists: () => true,
        getSandboxPolicies: () => [],
        getCustomPolicies: () => [],
      },
    );
    const lines = expectError(result);
    expect(lines[0]).toContain("No registered policy content");
  });
});
