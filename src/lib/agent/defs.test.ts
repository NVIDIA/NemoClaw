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
  resolveAgentNameAlias,
} from "./defs";

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

  it("treats an explicit agent flag as overriding NEMOCLAW_AGENT", () => {
    process.env.NEMOCLAW_AGENT = "hermes";

    expect(resolveAgentName({ agentFlag: "openclaw" })).toBe("openclaw");
  });

  it("resolves common user-facing agent aliases to canonical manifest names", () => {
    const available = ["openclaw", "hermes", "langchain-deepagents-code"];

    expect(resolveAgentNameAlias("nemohermes", available)).toBe("hermes");
    expect(resolveAgentNameAlias("NEMO_HERMES", available)).toBe("hermes");
    expect(resolveAgentNameAlias("dcode", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("deepagent", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("deepagents", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("deep agents code", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("deepagentscode", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("langchain", available)).toBe("langchain-deepagents-code");
    expect(resolveAgentNameAlias("nemoclaw", available)).toBe("openclaw");
  });

  it("resolves --agent and NEMOCLAW_AGENT aliases through resolveAgentName", () => {
    expect(resolveAgentName({ agentFlag: "dcode" })).toBe("langchain-deepagents-code");

    vi.stubEnv("NEMOCLAW_AGENT", "nemohermes");
    expect(resolveAgentName()).toBe("hermes");
  });

  it("rejects non-object manifest payloads", () => {
    const agentName = `invalid-top-level-manifest-${String(Date.now())}`;
    writeTempAgentManifest(agentName, ["- not", "- an", "- object"].join("\n"));

    expect(() => loadAgent(agentName)).toThrow(/YAML object/);
  });

  it("rejects invalid forward_ports values in manifests", () => {
    for (const port of [1023, 70000]) {
      const agentName = `invalid-forward-port-${String(port)}-${String(Date.now())}`;
      writeTempAgentManifest(
        agentName,
        [`name: ${agentName}`, "display_name: Broken Ports", "forward_ports:", `  - ${port}`].join(
          "\n",
        ),
      );

      expect(() => loadAgent(agentName)).toThrow(/forward_ports\[0\]/);
    }
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

  it("rejects invalid dashboard auth values in manifests", () => {
    const agentName = `invalid-dashboard-auth-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Dashboard Auth",
        "dashboard:",
        "  kind: ui",
        "  auth: bearer",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/dashboard\.auth/);
  });

  it("rejects invalid dashboard health path values in manifests", () => {
    const agentName = `invalid-dashboard-health-path-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Dashboard Health Path",
        "dashboard:",
        "  kind: ui",
        "  health_path: api/status",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/dashboard\.health_path/);
  });

  it("rejects invalid dashboard_ui.port values in manifests", () => {
    const agentName = `invalid-dashboard-ui-port-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Dashboard UI",
        "dashboard_ui:",
        "  label: Web dashboard",
        "  port: 1023",
        "  enable_env: NEMOCLAW_TEST_DASHBOARD",
        "  port_env: NEMOCLAW_TEST_DASHBOARD_PORT",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/dashboard_ui\.port/);
  });

  it("rejects invalid inference provider options in manifests", () => {
    const agentName = `invalid-inference-options-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Inference",
        "inference:",
        "  provider_options:",
        "    - hermesProvider",
        "    - 42",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/inference\.provider_options/);
  });

  it("rejects invalid inference provider type in manifests", () => {
    const agentName = `invalid-inference-provider-type-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Inference Type",
        "inference:",
        "  provider_type: 42",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/inference\.provider_type/);
  });

  it.each([
    "42",
    '"bad model"',
  ])("rejects invalid inference default models in manifests (%s)", (defaultModel) => {
    const agentName = `invalid-inference-default-model-${String(Date.now())}-${defaultModel.length}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Inference Default",
        "inference:",
        `  default_model: ${defaultModel}`,
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/inference\.default_model/);
  });

  it("rejects invalid MCP bridge adapter declarations in manifests", () => {
    const agentName = `invalid-mcp-adapter-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken MCP",
        "mcp:",
        "  support: bridge",
        "  adapter: unsupported-adapter",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/mcp\.adapter/);
  });

  it("requires an MCP adapter when bridge support is declared", () => {
    const agentName = `missing-mcp-adapter-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Missing MCP Adapter", "mcp:", "  support: bridge"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/mcp\.adapter/);
  });

  it("loads terminal runtime manifests without OpenClaw gateway defaults", () => {
    const agentName = `terminal-agent-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Terminal Agent",
        "binary_path: /usr/local/bin/terminal-agent",
        "version_command: terminal-agent --version",
        "runtime:",
        "  kind: terminal",
        "  interactive_command: terminal-agent",
        "  headless_command: terminal-agent -n",
        "  smoke_commands:",
        "    - terminal-agent --version",
      ].join("\n"),
    );

    const agent = loadAgent(agentName);

    expect(agent.runtime).toEqual({
      kind: "terminal",
      interactive_command: "terminal-agent",
      headless_command: "terminal-agent -n",
      smoke_commands: ["terminal-agent --version"],
    });
    expect(agent.healthProbe).toBeNull();
    expect(agent.forwardPort).toBe(0);
  });

  it("rejects invalid runtime kinds in manifests", () => {
    const agentName = `invalid-runtime-kind-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken Runtime", "runtime:", "  kind: daemon"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/runtime\.kind/);
  });

  it("requires terminal manifests to declare a launch command", () => {
    const agentName = `invalid-terminal-runtime-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken Terminal", "runtime:", "  kind: terminal"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/interactive_command or headless_command/);
  });

  it("rejects invalid terminal smoke command values in manifests", () => {
    const agentName = `invalid-terminal-smoke-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Terminal Smoke",
        "runtime:",
        "  kind: terminal",
        "  interactive_command: broken-terminal",
        "  smoke_commands:",
        "    - broken-terminal --version",
        "    - 42",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/runtime\.smoke_commands/);
  });

  it("rejects non-string user_managed_files entries", () => {
    const agentName = `invalid-umf-nonstring-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken UMF",
        "user_managed_files:",
        "  - .env",
        "  - 42",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files\[1\].*string/);
  });

  it("rejects non-array user_managed_files values", () => {
    const agentName = `invalid-umf-nonarray-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken UMF", "user_managed_files: not-an-array"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files.*must be an array/);
  });

  it("rejects empty-string user_managed_files entries", () => {
    const agentName = `invalid-umf-empty-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken UMF", "user_managed_files:", '  - ""'].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files\[0\].*empty/);
  });

  it("rejects absolute paths in user_managed_files entries", () => {
    const agentName = `invalid-umf-absolute-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken UMF",
        "user_managed_files:",
        "  - /sandbox/.env",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files\[0\].*absolute/);
  });

  it("rejects '..' traversal in user_managed_files entries", () => {
    const agentName = `invalid-umf-traversal-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken UMF",
        "user_managed_files:",
        '  - "../secret"',
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files\[0\].*'\.\.'/);
  });

  it("rejects control characters in user_managed_files entries", () => {
    const agentName = `invalid-umf-control-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken UMF",
        "user_managed_files:",
        '  - ".env\\n.malicious"',
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_managed_files\[0\].*control characters/);
  });
});
