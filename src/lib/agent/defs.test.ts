// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({ digests: [] as string[] }));

vi.mock("./candidate-authority", () => ({
  CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: { pi: authority.digests },
  acceptedCandidateReceiptDigests: () => authority.digests,
}));

import {
  type CandidateQualificationFixture,
  candidateQualificationEnvironment,
} from "./candidate-test-fixture";
import YAML from "yaml";

import {
  AGENTS_DIR,
  getAgentChoices,
  listAgents,
  loadAgent,
  requireAgentPolicyAdditionsPath,
  resolveAgentName,
  resolveAgentNameAlias,
} from "./defs";
import { resolveAgent } from "./onboard";

const tempAgentDirs: string[] = [];

function writeTempAgentManifest(name: string, contents: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "manifest.yaml"), contents);
}

const qualificationFixtures: CandidateQualificationFixture[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_AGENT;
  delete process.env.NEMOCLAW_CUA_ENABLED;
  authority.digests.splice(0, authority.digests.length);
  while (qualificationFixtures.length > 0) qualificationFixtures.pop()?.cleanup();
  while (tempAgentDirs.length > 0) {
    const agentDir = tempAgentDirs.pop();
    if (agentDir) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }
});

describe("agent definitions", () => {
  it("exposes NemoCUA only behind the exact experimental feature flag (#9649)", () => {
    expect(fs.existsSync(path.join(AGENTS_DIR, "nemocua", "manifest.yaml"))).toBe(true);
    expect(listAgents({})).not.toContain("nemocua");
    expect(listAgents({ NEMOCLAW_CUA_ENABLED: "true" })).not.toContain("nemocua");
    expect(() => loadAgent("nemocua", {})).toThrow("NemoCUA is disabled");

    const enabledEnv = { NEMOCLAW_CUA_ENABLED: "1" };
    expect(listAgents(enabledEnv)).toContain("nemocua");
    expect(loadAgent("nemocua", enabledEnv)).toMatchObject({
      name: "nemocua",
      runtime: {
        kind: "terminal",
        headless_command: "python3 /app/run_with_harness.py",
      },
    });
  });

  it("keeps NemoCUA out of choices and direct resolution until enabled (#9649)", () => {
    expect(getAgentChoices().map((choice) => choice.name)).not.toContain("nemocua");
    expect(() => resolveAgent({ agentFlag: "nemocua" })).toThrow("Unknown agent 'nemocua'");

    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");

    expect(getAgentChoices().map((choice) => choice.name)).toContain("nemocua");
    expect(resolveAgent({ agentFlag: "nemocua" })?.name).toBe("nemocua");
  });

  it("keeps the Pi candidate manifest out of agent selection by default (#7925)", () => {
    expect(fs.existsSync(path.join(AGENTS_DIR, "pi", "manifest.yaml"))).toBe(true);

    expect(listAgents({})).not.toContain("pi");
    expect(getAgentChoices().map((choice) => choice.name)).not.toContain("pi");
    expect(resolveAgentNameAlias("pi", listAgents({}))).toBeNull();
    expect(() => loadAgent("pi", {})).toThrow(
      "Agent 'pi' is a release candidate and is not selectable in this release",
    );
  });

  it("does not let an ordinary environment setting expose Pi (#7925)", () => {
    const ordinaryEnv = { NEMOCLAW_PI_QUALIFICATION: "1" };

    expect(listAgents(ordinaryEnv)).not.toContain("pi");
    expect(resolveAgentNameAlias("pi", listAgents(ordinaryEnv))).toBeNull();
    expect(() => loadAgent("pi", ordinaryEnv)).toThrow(
      "Agent 'pi' is a release candidate and is not selectable in this release",
    );
  });

  it("selects Pi only with protected candidate qualification authority (#7927)", () => {
    const fixture = candidateQualificationEnvironment();
    qualificationFixtures.push(fixture);
    authority.digests.push(fixture.receiptDigest);

    expect(listAgents(fixture.env)).toContain("pi");
    expect(resolveAgentNameAlias("pi", listAgents(fixture.env))).toBe("pi");
    expect(loadAgent("pi", fixture.env).name).toBe("pi");
  });

  it("withholds Pi from a receipt the repository has not published (#7927)", () => {
    const fixture = candidateQualificationEnvironment();
    qualificationFixtures.push(fixture);

    expect(listAgents(fixture.env)).not.toContain("pi");
    expect(() => loadAgent("pi", fixture.env)).toThrow("is not selectable in this release");
  });

  it("does not expose Pi from the protected flag alone (#7927)", () => {
    expect(listAgents({ NEMOCLAW_CANDIDATE_AGENTS: "1" })).not.toContain("pi");
    expect(listAgents({ NEMOCLAW_CANDIDATE_AGENTS: "0" })).not.toContain("pi");
    expect(listAgents({ NEMOCLAW_CANDIDATE_AGENTS: "true" })).not.toContain("pi");
  });

  it("keeps the Pi candidate manifest readable without public resolution (#7925)", () => {
    const manifest = YAML.parse(
      fs.readFileSync(path.join(AGENTS_DIR, "pi", "manifest.yaml"), "utf8"),
    ) as {
      name: string;
      expected_version: string;
      runtime: { kind: string };
      config: { dir: string };
      state_dirs: { path: string; backup?: boolean }[];
      state_files: { path: string; restore: Record<string, unknown> }[];
    };

    expect(manifest.name).toBe("pi");
    expect(manifest.expected_version).toBe("0.84.1");
    expect(manifest.runtime.kind).toBe("terminal");
    expect(manifest.config.dir).toBe("/sandbox/.pi/agent");
    expect(
      manifest.state_dirs.filter(({ backup }) => backup !== false).map(({ path }) => path),
    ).toEqual(["sessions", "prompts", "themes"]);
    expect(
      manifest.state_dirs.filter(({ backup }) => backup === false).map(({ path }) => path),
    ).toEqual(["tools", "bin"]);
    expect(manifest.state_files.map((file) => file.path)).toEqual(["settings.json"]);
    const restore = manifest.state_files[0]?.restore as {
      merge?: string;
      user_keys?: unknown[];
    };
    expect(restore?.merge).toBe("key-allowlist");
    expect(restore?.user_keys).toEqual([
      { key: "theme", type: "string", max_length: 128 },
      { key: "hideThinkingBlock", type: "boolean" },
      { key: "showCacheMissNotices", type: "boolean" },
      { key: "quietStartup", type: "boolean" },
      { key: "steeringMode", type: "enum", values: ["all", "one-at-a-time"] },
      { key: "followUpMode", type: "enum", values: ["all", "one-at-a-time"] },
      {
        key: "defaultThinkingLevel",
        type: "enum",
        values: ["off", "minimal", "low", "medium", "high", "xhigh"],
      },
    ]);
  });

  it("orders OpenClaw first in interactive choices", () => {
    const choices = getAgentChoices();
    expect(choices[0]?.name).toBe("openclaw");
    expect(choices.map((choice) => choice.name)).toContain("hermes");
  });

  it("uses agent display names in interactive choices", () => {
    const choices = getAgentChoices();
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "openclaw", displayName: "OpenClaw" }),
        expect.objectContaining({ name: "hermes", displayName: "Hermes Agent" }),
      ]),
    );
  });

  it("requires a readable regular policy-additions file for non-OpenClaw baselines (#7194)", () => {
    const agentName = `missing-baseline-${String(Date.now())}`;
    writeTempAgentManifest(agentName, `name: ${agentName}\ndisplay_name: Missing Baseline\n`);
    const agent = loadAgent(agentName);
    const policyPath = path.join(AGENTS_DIR, agentName, "policy-additions.yaml");

    expect(() => requireAgentPolicyAdditionsPath(agent)).toThrow(
      "Refusing to substitute the OpenClaw baseline",
    );

    fs.mkdirSync(policyPath);
    expect(() => requireAgentPolicyAdditionsPath(agent)).toThrow(
      "Refusing to substitute the OpenClaw baseline",
    );
    fs.rmSync(policyPath, { recursive: true });
    fs.writeFileSync(policyPath, "version: 1\nnetwork_policies: {}\n");

    expect(requireAgentPolicyAdditionsPath(agent)).toBe(policyPath);
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

  it("rejects the superseded runtime auth directory inventory (#8006)", () => {
    const agentName = `runtime-auth-inventory-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Runtime Auth Inventory",
        "state_dirs:",
        "  - identity",
        "runtime_auth_state_dirs:",
        "  - identity",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/replaced.*backup: false/);
  });

  it("derives protected configuration files from each agent manifest (#8006)", () => {
    expect(loadAgent("hermes").configPaths.shieldsFiles).toEqual([".env"]);
    expect(loadAgent("openclaw").configPaths.shieldsFiles).toEqual([]);
    expect(loadAgent("langchain-deepagents-code").configPaths.shieldsFiles).toEqual([]);
  });

  it("derives image state-lock-plan support from each agent manifest (#8006)", () => {
    expect(loadAgent("openclaw").stateLockPlanInImage).toBe(true);
    expect(loadAgent("hermes").stateLockPlanInImage).toBe(true);
    expect(loadAgent("langchain-deepagents-code").stateLockPlanInImage).toBe(false);
  });

  it("rejects a non-boolean image state-lock-plan declaration (#8006)", () => {
    const agentName = `invalid-image-plan-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "state_lock_plan_in_image: yes-please"].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_lock_plan_in_image.*boolean/);
  });

  it.each([
    ["a scalar", "  shields_files: .env"],
    ["a non-string entry", "  shields_files:\n    - 42"],
  ])("rejects config.shields_files with %s", (_case, declaration) => {
    const agentName = `invalid-shields-files-${String(Date.now())}-${_case.replaceAll(" ", "-")}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Invalid Shields Files",
        "config:",
        "  dir: /sandbox/.invalid",
        "  config_file: config.json",
        declaration,
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/config\.shields_files/);
  });

  it.each([1023, 70000])("rejects invalid forward_ports value %s in manifests", (port) => {
    const agentName = `invalid-forward-port-${String(port)}-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Broken Ports", "forward_ports:", `  - ${port}`].join(
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

  it.each(["42", '"bad model"'])(
    "rejects invalid inference default models in manifests (%s)",
    (defaultModel) => {
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
    },
  );

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
