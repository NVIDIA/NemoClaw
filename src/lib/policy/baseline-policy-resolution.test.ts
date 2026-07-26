// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as agentDefs from "../agent/defs";
import { ROOT } from "../runner";
import * as registry from "../state/registry";
import { resolveSandboxBaselinePolicy } from "./index";

const tempDirs: string[] = [];

function writePolicy(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-policy-"));
  tempDirs.push(dir);
  const policyPath = path.join(dir, "policy-additions.yaml");
  fs.writeFileSync(policyPath, content);
  return policyPath;
}

function useAgentPolicy(content: string): void {
  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "hermes" } as never);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
    name: "hermes",
    policyAdditionsPath: writePolicy(content),
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sandbox baseline policy resolution (#7194)", () => {
  it.each([null, "openclaw"])("uses the OpenClaw baseline for agent %s (#7194)", (agent) => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent } as never);
    const loadAgentSpy = vi.spyOn(agentDefs, "loadAgent");

    expect(resolveSandboxBaselinePolicy("alpha")?.policyPath).toBe(
      path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
    );
    expect(loadAgentSpy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", policyAdditionsPath: null },
    { label: "unreadable", policyAdditionsPath: ROOT },
  ])("refuses to substitute OpenClaw for a $label recorded-agent baseline (#7194)", ({
    policyAdditionsPath,
  }) => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "hermes" } as never);
    vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
      name: "hermes",
      policyAdditionsPath,
    } as never);

    expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
      "Refusing to substitute the OpenClaw baseline",
    );
  });

  it("rejects malformed agent baseline YAML through the canonical parser (#7194)", () => {
    useAgentPolicy("version: [unterminated");

    expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
      "Sandbox policy is malformed or is not an OpenShell policy YAML mapping",
    );
  });

  it("rejects a schema-invalid agent baseline with an unscoped network entry (#7194)", () => {
    useAgentPolicy(`
version: 1
network_policies:
  unsafe_entry:
    name: unsafe_entry
    endpoints:
      - host: api.example.test
        port: 443
        access: full
`);

    expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
      /does not satisfy the shipped sandbox policy schema \(required: must have required property 'binaries'/,
    );
  });

  it("accepts every checked-in non-OpenClaw agent baseline under the runtime schema (#7194)", () => {
    const getSandbox = vi.spyOn(registry, "getSandbox");
    // Keep this immutable: listAgents() observes the shared agents directory,
    // where parallel definition tests intentionally create transient manifests.
    const agentNames = ["hermes", "langchain-deepagents-code"] as const;

    for (const agentName of agentNames) {
      getSandbox.mockReturnValue({ name: "alpha", agent: agentName } as never);
      expect(resolveSandboxBaselinePolicy("alpha")?.policyPath).toBe(
        agentDefs.loadAgent(agentName).policyAdditionsPath,
      );
    }
  });
});
