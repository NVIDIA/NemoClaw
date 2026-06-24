// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyAgentsManifestEnv, loadAgentsManifest } from "./agents-manifest";

let tmpDir: string;

function manifestPath(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agents-manifest-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAgentsManifest", () => {
  it("returns an empty agents list for an empty file", () => {
    const file = manifestPath("empty.yaml", "");
    expect(loadAgentsManifest(file)).toEqual({ agents: [] });
  });

  it("parses the proposed manager-worker example shape", () => {
    const file = manifestPath(
      "manager-worker.yaml",
      [
        "agents:",
        "  - id: manager",
        "    model: test-provider/nemotron-super",
        "    tools:",
        "      allow: [read]",
        "    subagents:",
        "      allowAgents: [logs-reader]",
        "      delegationMode: prefer",
        "      requireAgentId: true",
        "  - id: logs-reader",
        "    model: test-provider/nemotron-nano",
        "    tools:",
        "      allow: [kubectl]",
        "",
      ].join("\n"),
    );
    const payload = loadAgentsManifest(file);
    expect(payload.agents).toHaveLength(2);
    expect(payload.agents[0]).toMatchObject({
      id: "manager",
      workspace: "/sandbox/.openclaw/workspace-manager",
      agentDir: "/sandbox/.openclaw/agents/manager",
      model: "test-provider/nemotron-super",
      subagents: {
        allowAgents: ["logs-reader"],
        delegationMode: "prefer",
        requireAgentId: true,
      },
    });
    expect(payload.agents[1]).toMatchObject({
      id: "logs-reader",
      workspace: "/sandbox/.openclaw/workspace-logs-reader",
      agentDir: "/sandbox/.openclaw/agents/logs-reader",
    });
  });

  it("preserves operator-supplied workspace/agentDir without overwriting", () => {
    const file = manifestPath(
      "explicit-paths.yaml",
      [
        "agents:",
        "  - id: alpha",
        "    workspace: /sandbox/.openclaw/workspace-alpha",
        "    agentDir: /sandbox/.openclaw/agents/alpha",
        "    tools:",
        "      allow: [read]",
        "",
      ].join("\n"),
    );
    const payload = loadAgentsManifest(file);
    expect(payload.agents[0]).toMatchObject({
      id: "alpha",
      workspace: "/sandbox/.openclaw/workspace-alpha",
      agentDir: "/sandbox/.openclaw/agents/alpha",
    });
  });

  it("passes through defaults and main blocks unchanged", () => {
    const file = manifestPath(
      "with-defaults-main.yaml",
      [
        "defaults:",
        "  subagents:",
        "    maxSpawnDepth: 3",
        "main:",
        "  subagents:",
        "    allowAgents: [alpha]",
        "    delegationMode: prefer",
        "agents:",
        "  - id: alpha",
        "    tools:",
        "      allow: [read]",
        "",
      ].join("\n"),
    );
    const payload = loadAgentsManifest(file);
    expect(payload.defaults).toEqual({ subagents: { maxSpawnDepth: 3 } });
    expect(payload.main).toEqual({
      subagents: { allowAgents: ["alpha"], delegationMode: "prefer" },
    });
  });

  it("rejects unknown top-level keys", () => {
    const file = manifestPath("rogue.yaml", "rogue: true\nagents: []\n");
    expect(() => loadAgentsManifest(file)).toThrow(
      /agents manifest contains unsupported top-level field "rogue"/,
    );
  });

  it("rejects a list at the top level", () => {
    const file = manifestPath("list.yaml", "- id: alpha\n");
    expect(() => loadAgentsManifest(file)).toThrow(
      /must be a YAML mapping \(object\) at the top level/,
    );
  });

  it("rejects a non-list agents field", () => {
    const file = manifestPath("scalar-agents.yaml", "agents: not-a-list\n");
    expect(() => loadAgentsManifest(file)).toThrow(/'agents' must be a list/);
  });

  it("surfaces YAML parse errors with the underlying reason", () => {
    const file = manifestPath("broken.yaml", "agents:\n  - id: alpha\n    tools: [\n");
    expect(() => loadAgentsManifest(file)).toThrow(/--agents YAML parse error:/);
  });

  it("reports a clear error when the path does not exist", () => {
    const missing = path.join(tmpDir, "does-not-exist.yaml");
    expect(() => loadAgentsManifest(missing)).toThrow(/path not found:/);
  });

  it("reports a clear error when the path is a directory", () => {
    const dir = path.join(tmpDir, "child-dir");
    fs.mkdirSync(dir);
    expect(() => loadAgentsManifest(dir)).toThrow(/must point to a file:/);
  });

  it("rejects manifests with nested credential-named keys before they reach the build", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "API_KEY",
      "token",
      "secret",
      "password",
      "passphrase",
      "credential",
      "bearer",
      "auth",
      "clientSecret",
      "client_secret",
      "accessToken",
      "refreshToken",
      "refresh-token",
      "sessionToken",
      "idToken",
      "apiToken",
      "privateKey",
      "private_key",
      "publicKey",
      "signingKey",
      "encryptionKey",
      "AccessKey",
      "bearerToken",
      "webhookSecret",
      "encryption_passphrase",
    ]) {
      const file = manifestPath(
        `credential-${key}.yaml`,
        [
          "agents:",
          "  - id: alpha",
          "    tools:",
          "      allow: [read]",
          "    subagents:",
          `      ${key}: leaking-secret-disguised-as-config`,
          "",
        ].join("\n"),
      );
      expect(() => loadAgentsManifest(file)).toThrow(/looks like a credential and is not allowed/);
    }
  });

  it("accepts benign field names that are not credential-shaped", () => {
    for (const key of ["model", "workspace", "agentDir", "allowAgents", "maxSpawnDepth"]) {
      const file = manifestPath(
        `benign-${key}.yaml`,
        [
          "agents:",
          "  - id: alpha",
          "    subagents:",
          `      ${key}: ok-not-a-credential`,
          "",
        ].join("\n"),
      );
      expect(() => loadAgentsManifest(file)).not.toThrow();
    }
  });
});

describe("applyAgentsManifestEnv", () => {
  const previous = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
  beforeEach(() => {
    delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
  });
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    } else {
      process.env.NEMOCLAW_EXTRA_AGENTS_JSON = previous;
    }
  });

  it("sets NEMOCLAW_EXTRA_AGENTS_JSON to the parsed payload", () => {
    const file = manifestPath(
      "set-env.yaml",
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const returned = applyAgentsManifestEnv(file);
    expect(returned.agents).toHaveLength(1);
    const raw = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    expect(typeof raw).toBe("string");
    const decoded = JSON.parse(raw as string);
    expect(decoded.agents[0]).toMatchObject({
      id: "alpha",
      workspace: "/sandbox/.openclaw/workspace-alpha",
      agentDir: "/sandbox/.openclaw/agents/alpha",
    });
  });
});
