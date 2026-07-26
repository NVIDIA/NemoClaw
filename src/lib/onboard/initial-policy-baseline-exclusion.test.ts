// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { resolveAgentBaselinePolicy } from "../policy";
import {
  BaselineExclusionDriftError,
  digestBaselineEntry,
  getBaselineEntry,
} from "../policy/baseline-exclusion";
import { prepareInitialSandboxCreatePolicy } from "./initial-policy";

const BASE_POLICY = `version: 1
network_policies:
  nous_research:
    name: nous_research
    endpoints:
      - host: nousresearch.com
        port: 443
        protocol: rest
        rules:
          - allow: { method: GET, path: "/**" }
  managed_inference:
    name: managed_inference
    endpoints:
      - host: inference.local
        port: 443
        protocol: rest
        rules:
          - allow: { method: POST, path: "/v1/**" }
`;

const tempDirs: string[] = [];

function writeBasePolicy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-exclusion-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "policy-additions.yaml");
  fs.writeFileSync(filePath, BASE_POLICY);
  return filePath;
}

function digestOf(key: string): string {
  const entry = getBaselineEntry(BASE_POLICY, key);
  expect(entry).not.toBeNull();
  return digestBaselineEntry(entry!);
}

function exclusion(key: string, digest: string, agent = "openclaw") {
  return { version: 1 as const, agent, key, digest };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareInitialSandboxCreatePolicy baseline exclusions (#7178)", () => {
  it("drops an excluded entry from the generated policy", () => {
    const basePath = writeBasePolicy();
    const result = prepareInitialSandboxCreatePolicy(basePath, [], {
      agentName: "openclaw",
      baselineExclusions: [exclusion("nous_research", digestOf("nous_research"))],
    });
    const generated = YAML.parse(fs.readFileSync(result.policyPath, "utf-8"));
    expect(Object.keys(generated.network_policies)).toEqual(["managed_inference"]);
    result.cleanup?.();
  });

  it("leaves the base policy untouched when no exclusions are requested", () => {
    const basePath = writeBasePolicy();
    const result = prepareInitialSandboxCreatePolicy(basePath, [], {});
    expect(result.policyPath).toBe(basePath);
    result.cleanup?.();
  });

  it("fails closed when the recorded digest no longer matches the baseline", () => {
    const basePath = writeBasePolicy();
    expect(() =>
      prepareInitialSandboxCreatePolicy(basePath, [], {
        agentName: "openclaw",
        baselineExclusions: [exclusion("nous_research", "stale-digest")],
      }),
    ).toThrowError(BaselineExclusionDriftError);
  });

  it("fails closed when the excluded entry was removed by a release", () => {
    const basePath = writeBasePolicy();
    expect(() =>
      prepareInitialSandboxCreatePolicy(basePath, [], {
        agentName: "openclaw",
        baselineExclusions: [exclusion("removed_key", "any")],
      }),
    ).toThrowError(BaselineExclusionDriftError);
  });

  it("rejects the shipped Hermes pypi preset when pypi is excluded from its baseline (#7194)", () => {
    const hermes = resolveAgentBaselinePolicy("hermes");
    expect(hermes).not.toBeNull();
    const entry = getBaselineEntry(hermes!.content, "pypi");
    expect(entry).not.toBeNull();

    expect(() =>
      prepareInitialSandboxCreatePolicy(hermes!.policyPath, [], {
        agentName: "hermes",
        additionalPresets: ["pypi"],
        baselineExclusions: [exclusion("pypi", digestBaselineEntry(entry!), "hermes")],
      }),
    ).toThrow(/network policy key 'pypi' is reserved by a baseline exclusion/);
  });
});
