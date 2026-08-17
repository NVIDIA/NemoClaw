// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENTS_DIR } from "../agent/defs";
import * as registry from "../state/registry";
import { isAgentBasePreset } from "./index";

const tempAgentDirs: string[] = [];

function createAgentFixture(policyAdditions?: string): string {
  const agentName = `agent-base-preset-${randomUUID()}`;
  const agentDir = path.join(AGENTS_DIR, agentName);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "manifest.yaml"),
    `name: ${agentName}\ndisplay_name: Agent Base Preset Fixture\n`,
  );
  fs.writeFileSync(
    path.join(agentDir, "policy-additions.yaml"),
    policyAdditions ??
      `version: 1
network_policies:
  github:
    name: github
    endpoints:
      - host: api.github.com
        port: 443
        access: full
    binaries:
      - path: /usr/bin/git
`,
  );
  return agentName;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const agentDir of tempAgentDirs.splice(0)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("agent base preset detection", () => {
  it("loads the recorded agent policy and distinguishes matching preset names (#9079)", () => {
    const agent = createAgentFixture();
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent } as never);

    expect(isAgentBasePreset("alpha", "github")).toBe(true);
    expect(isAgentBasePreset("alpha", "slack")).toBe(false);
  });

  it("recognizes the Hermes base policy when its preset name also exists in the catalog (#9079)", () => {
    const hermesPolicy = fs.readFileSync(
      path.join(AGENTS_DIR, "hermes", "policy-additions.yaml"),
      "utf8",
    );
    const agent = createAgentFixture(hermesPolicy);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "hermes", agent } as never);

    expect(isAgentBasePreset("hermes", "pypi")).toBe(true);
  });

  it("reports pypi and github as non-baseline presets for the Pi policy (#7924)", () => {
    const piPolicy = fs.readFileSync(path.join(AGENTS_DIR, "pi", "policy-additions.yaml"), "utf8");
    const agent = createAgentFixture(piPolicy);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "pi", agent } as never);

    expect(isAgentBasePreset("pi", "managed_inference")).toBe(true);
    expect(isAgentBasePreset("pi", "pypi")).toBe(false);
    expect(isAgentBasePreset("pi", "github")).toBe(false);
  });
});
