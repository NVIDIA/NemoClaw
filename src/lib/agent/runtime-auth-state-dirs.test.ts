// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENTS_DIR, loadAgent } from "./defs";

const tempAgentDirs: string[] = [];

function writeTempAgentManifest(name: string, contents: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "manifest.yaml"), contents);
}

afterEach(() => {
  for (const agentDir of tempAgentDirs.splice(0)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("runtime_auth_state_dirs manifest field (#6852)", () => {
  it("parses runtime_auth_state_dirs as a subset of state_dirs", () => {
    const agentName = `runtime-auth-parse-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: RuntimeAuth",
        "state_dirs:",
        "  - agents",
        "  - identity",
        "  - devices",
        "runtime_auth_state_dirs:",
        "  - identity",
        "  - devices",
      ].join("\n"),
    );

    const agent = loadAgent(agentName);
    expect(agent.stateDirs).toEqual(["agents", "identity", "devices"]);
    expect(agent.runtimeAuthStateDirs).toEqual(["identity", "devices"]);
  });

  it("defaults to no runtime auth dirs when the field is absent", () => {
    const agentName = `runtime-auth-absent-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: RuntimeAuth", "state_dirs:", "  - agents"].join("\n"),
    );

    expect(loadAgent(agentName).runtimeAuthStateDirs).toEqual([]);
  });

  it("rejects a runtime auth dir that is not also a state dir", () => {
    const agentName = `runtime-auth-orphan-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: RuntimeAuth",
        "state_dirs:",
        "  - agents",
        "runtime_auth_state_dirs:",
        "  - identity",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(
      /runtime_auth_state_dirs.*'identity'.*must also be listed in 'state_dirs'/,
    );
  });

  it("declares OpenClaw device identity and paired-device state as runtime auth dirs", () => {
    const agent = loadAgent("openclaw");
    expect(agent.runtimeAuthStateDirs).toEqual(["identity", "devices"]);
    // Still wiped on destroy: the dirs must remain declared durable state.
    expect(agent.stateDirs).toEqual(expect.arrayContaining(["identity", "devices"]));
  });
});
