// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "./initial-policy";

type PolicyRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type PolicyEndpoint = {
  host?: string;
  rules?: PolicyRule[];
};

type PolicyEntry = {
  binaries?: Array<{ path?: string }>;
  endpoints?: PolicyEndpoint[];
};

type PolicyDocument = {
  network_policies?: Record<string, PolicyEntry>;
};

const cleanupFns: Array<() => boolean | undefined> = [];

afterEach(() => {
  for (const cleanup of cleanupFns.splice(0)) {
    cleanup();
  }
});

function repoPath(...segments: string[]): string {
  return path.join(import.meta.dirname, "..", "..", "..", ...segments);
}

function readPreparedPolicy(prepared: {
  policyPath: string;
  cleanup?: () => boolean;
}): PolicyDocument {
  cleanupFns.push(() => prepared.cleanup?.());
  return YAML.parse(fs.readFileSync(prepared.policyPath, "utf-8")) as PolicyDocument;
}

describe("initial sandbox policy real preset merge", () => {
  it("uses Hermes channel YAML when the Hermes base policy path implies the agent", () => {
    const prepared = prepareInitialSandboxCreatePolicy(
      repoPath("agents", "hermes", "policy-additions.yaml"),
      ["discord", "slack"],
    );
    const policy = readPreparedPolicy(prepared);

    expect(prepared.appliedPresets).toEqual(["discord", "slack"]);

    const slackBinaries =
      policy.network_policies?.slack?.binaries?.map((binary) => binary.path) ?? [];
    expect(slackBinaries).toEqual([
      "/usr/local/bin/hermes",
      "/usr/bin/python3*",
      "/opt/hermes/.venv/bin/python",
    ]);

    const discordBinaries =
      policy.network_policies?.discord?.binaries?.map((binary) => binary.path) ?? [];
    expect(discordBinaries).toContain("/usr/bin/python3*");
    expect(discordBinaries).toContain("/opt/hermes/.venv/bin/python");
    expect(discordBinaries).not.toContain("/usr/bin/node");

    const discordRules =
      policy.network_policies?.discord?.endpoints
        ?.find((endpoint) => endpoint.host === "discord.com")
        ?.rules?.map((rule) => rule.allow) ?? [];
    expect(discordRules).not.toContainEqual({ method: "PUT", path: "/**" });
    expect(discordRules).not.toContainEqual({ method: "PATCH", path: "/**" });
  });
});
