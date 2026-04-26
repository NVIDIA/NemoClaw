// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENTS_DIR,
  getAgentChoices,
  loadAgent,
  resolveAgentName,
} from "../../dist/lib/agent-defs";

const tempAgentDirs: string[] = [];

function writeTempAgentManifest(name: string, contents: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "manifest.yaml"), contents);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_AGENT;
  while (tempAgentDirs.length > 0) {
    const agentDir = tempAgentDirs.pop();
    if (agentDir) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }
});

describe("agent definitions", () => {
  it("loads computed OpenClaw manifest properties", () => {
    const openclaw = loadAgent("openclaw");

    expect(openclaw.name).toBe("openclaw");
    expect(openclaw.displayName).toBe("OpenClaw");
    expect(openclaw.healthProbe.port).toBe(18789);
    expect(openclaw.forwardPort).toBe(18789);
    expect(openclaw.configPaths).toEqual({
      immutableDir: "/sandbox/.openclaw",
      writableDir: "/sandbox/.openclaw-data",
      configFile: "openclaw.json",
      envFile: null,
      format: "json",
    });
    expect(openclaw.messagingPlatforms).toEqual(["telegram", "discord", "slack"]);
    expect(openclaw.legacyPaths?.startScript).toContain("scripts/nemoclaw-start.sh");
  });

  it("loads Hermes manifest properties without falling back to OpenClaw defaults", () => {
    const hermes = loadAgent("hermes");

    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.hasDevicePairing).toBe(false);
    expect(hermes.configPaths).toEqual({
      immutableDir: "/sandbox/.hermes",
      writableDir: "/sandbox/.hermes-data",
      configFile: "config.yaml",
      envFile: ".env",
      format: "yaml",
    });
    expect(hermes.healthProbe.url).toBe("http://localhost:8642/health");
    expect(hermes.messagingPlatforms).toEqual(["telegram", "discord", "slack"]);
  });

  it("orders OpenClaw first in interactive choices", () => {
    const choices = getAgentChoices();
    expect(choices[0]?.name).toBe("openclaw");
    expect(choices.map((choice) => choice.name)).toContain("hermes");
  });

  it("falls back to openclaw when session references an unknown agent", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveAgentName({ session: { agent: "missing-agent" } })).toBe("openclaw");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("session references unknown agent 'missing-agent'"),
    );
  });

  it("rejects non-object manifest payloads", () => {
    const agentName = `invalid-top-level-manifest-${String(Date.now())}`;
    writeTempAgentManifest(agentName, ["- not", "- an", "- object"].join("\n"));

    expect(() => loadAgent(agentName)).toThrow(/YAML object/);
  });

  it("rejects invalid forward_ports values in manifests", () => {
    const agentName = `invalid-forward-port-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken Ports", "forward_ports:", "  - 70000"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/forward_ports\[0\]/);
  });

  it("rejects invalid health_probe.port values in manifests", () => {
    const agentName = `invalid-health-port-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Health Probe",
        "health_probe:",
        '  url: "http://localhost:9000/health"',
        "  port: 0.5",
        "  timeout_seconds: 30",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/health_probe\.port/);
  });
});
