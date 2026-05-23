// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Rebuild policy preset tests. Built-in presets can be restored from names,
// while custom presets need their stored YAML content replayed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { pruneDisabledMessagingPolicyPresets } from "../src/lib/onboard/messaging-policy-presets";

const REPO_ROOT = path.join(import.meta.dirname, "..");

const sandboxState = await import(path.join(REPO_ROOT, "dist", "lib", "state", "sandbox.js"));
const rebuildAction = await import(
  path.join(REPO_ROOT, "dist", "lib", "actions", "sandbox", "rebuild.js")
);

type ManifestWithOptionalPresets = {
  version: number;
  sandboxName: string;
  timestamp: string;
  agentType: string;
  agentVersion: string | null;
  expectedVersion: string | null;
  stateDirs: string[];
  dir: string;
  backupPath: string;
  blueprintDigest: string | null;
  policyPresets?: string[] | null;
  customPolicyPresets?: Array<{
    name: string;
    content: string;
    sourcePath?: string;
    appliedAt?: string;
  }>;
};

const customPresetYaml = `preset:
  name: internal-api
  description: "Internal service"
network_policies:
  internal-api:
    name: internal-api
    endpoints:
      - host: api.example.internal
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/health" }
    binaries:
      - { path: /usr/local/bin/node }
`;

function makeManifest(overrides: Record<string, unknown> = {}): ManifestWithOptionalPresets {
  return {
    version: 1,
    sandboxName: "my-assistant",
    timestamp: "2026-05-05T12-00-00-000Z",
    agentType: "openclaw",
    agentVersion: "1.0.0",
    expectedVersion: "1.0.0",
    stateDirs: ["workspace"],
    dir: "/sandbox/.openclaw",
    backupPath: "/tmp/backup",
    blueprintDigest: null,
    ...overrides,
  };
}

function collectMockOutput(...mocks: Mock[]) {
  return mocks.flatMap((mock) => mock.mock.calls.flat()).join("\n");
}

describe("rebuild policy preset restoration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-rebuild-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("manifest interface accepts policyPresets array", () => {
    const manifest = makeManifest({
      sandboxName: "test",
      timestamp: "2026-04-17",
      policyPresets: ["telegram", "npm"],
    });

    expect(manifest.policyPresets).toEqual(["telegram", "npm"]);
  });

  it("manifest policyPresets defaults to undefined when not set", () => {
    const manifest = makeManifest({ policyPresets: undefined });

    expect(manifest.policyPresets).toBeUndefined();
  });

  it("manifest policyPresets can be an empty array", () => {
    const manifest = makeManifest({ policyPresets: [] });

    expect(manifest.policyPresets).toEqual([]);
  });

  it("captures built-in names and custom policy content for the rebuild manifest", () => {
    const customPolicy = {
      name: "internal-api",
      content: customPresetYaml,
      sourcePath: "/tmp/internal-api.yaml",
      appliedAt: "2026-05-05T12:00:00.000Z",
    };
    const sandbox = {
      name: "my-assistant",
      policies: ["npm", "telegram"],
      customPolicies: [customPolicy],
    };

    const result = sandboxState.getPolicyPresetsForManifest(sandbox);

    expect(result.policyPresets).toEqual(["npm", "telegram"]);
    expect(result.customPolicyPresets).toEqual([customPolicy]);

    result.policyPresets.push("pypi");
    const capturedCustomPolicy = result.customPolicyPresets[0];
    if (!capturedCustomPolicy) throw new Error("expected custom policy to be captured");
    capturedCustomPolicy.name = "mutated";

    expect(sandbox.policies).toEqual(["npm", "telegram"]);
    expect(sandbox.customPolicies[0]?.name).toBe("internal-api");
  });

  it("serializes custom policy content in the rebuild manifest", () => {
    const customPolicyPresets = [
      {
        name: "internal-api",
        content: customPresetYaml,
        sourcePath: "/tmp/internal-api.yaml",
        appliedAt: "2026-05-05T12:00:00.000Z",
      },
    ];
    const manifest = makeManifest({
      policyPresets: ["npm"],
      customPolicyPresets,
    });
    const manifestPath = path.join(tmpDir, "rebuild-manifest.json");

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const read = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(read.policyPresets).toEqual(["npm"]);
    expect(read.customPolicyPresets).toEqual(customPolicyPresets);
  });

  it("older manifests without policyPresets read as empty through restore fallback", () => {
    const manifest = makeManifest({ policyPresets: undefined });
    const savedPresets = manifest.policyPresets || [];

    expect(savedPresets).toEqual([]);
  });

  it("replays built-in presets by name and custom presets by stored content", () => {
    const applyPreset = vi.fn(() => true);
    const applyPresetContent = vi.fn(() => true);
    const log = vi.fn();
    const stdout = { log: vi.fn() };
    const stderr = { error: vi.fn() };
    const manifest = makeManifest({
      policyPresets: ["npm"],
      customPolicyPresets: [
        {
          name: "internal-api",
          content: customPresetYaml,
          sourcePath: "/tmp/internal-api.yaml",
        },
      ],
    });

    const result = rebuildAction.restorePolicyPresetsFromManifest("my-assistant", manifest, {
      applyPreset,
      applyPresetContent,
      log,
      stdout,
      stderr,
    });

    expect(applyPreset).toHaveBeenCalledWith("my-assistant", "npm");
    expect(applyPresetContent).toHaveBeenCalledWith(
      "my-assistant",
      "internal-api",
      customPresetYaml,
      { custom: { sourcePath: "/tmp/internal-api.yaml" } },
    );
    expect(result).toEqual({
      restoredPresets: ["npm"],
      failedPresets: [],
      restoredCustomPresets: ["internal-api"],
      failedCustomPresets: [],
    });

    const output = collectMockOutput(log, stdout.log, stderr.error);
    expect(output).toContain("internal-api");
    expect(output).not.toContain("api.example.internal");
    expect(output).not.toContain(customPresetYaml);
  });

  it("does not restore disabled messaging channel policy presets", () => {
    const applyPreset = vi.fn(() => true);
    const manifest = makeManifest({ policyPresets: ["npm", "slack", "pypi"] });

    const result = rebuildAction.restorePolicyPresetsFromManifest("my-assistant", manifest, {
      applyPreset,
      disabledChannels: ["slack"],
      log: vi.fn(),
      stdout: { log: vi.fn() },
      stderr: { error: vi.fn() },
    });

    expect(applyPreset).toHaveBeenCalledWith("my-assistant", "npm");
    expect(applyPreset).toHaveBeenCalledWith("my-assistant", "pypi");
    expect(applyPreset).not.toHaveBeenCalledWith("my-assistant", "slack");
    expect(result.restoredPresets).toEqual(["npm", "pypi"]);
  });

  it("preserves non-required channel presets for later start and rebuild", () => {
    const savedPresets = pruneDisabledMessagingPolicyPresets(
      ["telegram", "npm", "pypi"],
      ["telegram"],
    );

    expect(savedPresets).toEqual(["telegram", "npm", "pypi"]);
  });

  it("replays multiple custom presets captured from directory application", () => {
    const applyPresetContent = vi.fn(() => true);
    const manifest = makeManifest({
      customPolicyPresets: [
        {
          name: "internal-api",
          content: customPresetYaml,
          sourcePath: "/tmp/presets/internal-api.yaml",
        },
        {
          name: "staging-api",
          content: customPresetYaml.replaceAll("internal-api", "staging-api"),
          sourcePath: "/tmp/presets/staging-api.yaml",
        },
      ],
    });

    const result = rebuildAction.restorePolicyPresetsFromManifest("my-assistant", manifest, {
      applyPreset: vi.fn(() => true),
      applyPresetContent,
      log: vi.fn(),
      stdout: { log: vi.fn() },
      stderr: { error: vi.fn() },
    });

    expect(applyPresetContent).toHaveBeenCalledTimes(2);
    expect(result.restoredCustomPresets).toEqual(["internal-api", "staging-api"]);
  });

  it("keeps old manifests without customPolicyPresets backward compatible", () => {
    const applyPreset = vi.fn(() => true);
    const applyPresetContent = vi.fn(() => true);
    const manifest = makeManifest({ policyPresets: ["telegram"] });

    const result = rebuildAction.restorePolicyPresetsFromManifest("my-assistant", manifest, {
      applyPreset,
      applyPresetContent,
      log: vi.fn(),
      stdout: { log: vi.fn() },
      stderr: { error: vi.fn() },
    });

    expect(applyPreset).toHaveBeenCalledWith("my-assistant", "telegram");
    expect(applyPresetContent).not.toHaveBeenCalled();
    expect(result.restoredPresets).toEqual(["telegram"]);
    expect(result.restoredCustomPresets).toEqual([]);
  });

  it("warns by custom preset name without printing custom YAML when restore fails", () => {
    const log = vi.fn();
    const stdout = { log: vi.fn() };
    const stderr = { error: vi.fn() };
    const manifest = makeManifest({
      customPolicyPresets: [
        {
          name: "internal-api",
          content: customPresetYaml,
          sourcePath: "/tmp/internal-api.yaml",
        },
      ],
    });

    const result = rebuildAction.restorePolicyPresetsFromManifest("my-assistant", manifest, {
      applyPreset: vi.fn(() => true),
      applyPresetContent: vi.fn(() => false),
      log,
      stdout,
      stderr,
    });

    expect(result.failedCustomPresets).toEqual(["internal-api"]);
    expect(stderr.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to restore custom presets: internal-api"),
    );

    const output = collectMockOutput(log, stdout.log, stderr.error);
    expect(output).toContain("internal-api");
    expect(output).not.toContain("api.example.internal");
    expect(output).not.toContain(customPresetYaml);
  });
});
