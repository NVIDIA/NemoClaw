// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "nemoclaw.js"));
const CREDENTIALS_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js"),
);
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policy", "index.js"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"));

type PolicyCall = {
  type: string;
  message?: string;
  sandboxName?: string;
  presetName?: string;
  path?: string;
};

describe("compiled CLI policy contracts", () => {
  describe("policy-remove custom presets", () => {
    function runPolicyRemoveCustom(
      presetName: string,
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-remove-custom-"));
      const scriptPath = path.join(tmpDir, "policy-remove-custom-check.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
// No built-in matches.
policies.listPresets = () => [];
policies.listCustomPresets = () => [
  { file: "/tmp/my-api.yaml", name: "my-api", description: "custom preset" },
];
policies.getAppliedPresets = () => ["my-api"];
policies.loadPreset = () => null; // built-in lookup misses
policies.getPresetEndpoints = () => ["api.example.internal"];
policies.removePreset = (sandboxName, presetName) => {
  calls.push({ type: "remove", sandboxName, presetName });
  return true;
};
registry.getSandbox = (name) =>
  name === "test-sandbox" ? { name, policies: [], customPolicies: [] } : null;
registry.getCustomPolicies = () => [
  { name: "my-api", content: "network_policies:\n  my-api: {}\n", sourcePath: "/tmp/my-api.yaml" },
];
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
credentials.prompt = async () => "y";
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-remove", ${JSON.stringify(presetName)}, ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("removes a custom preset by name using registry-persisted content", () => {
      const result = runPolicyRemoveCustom("my-api", ["--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "my-api",
      });
      expect(result.stdout).toMatch(/api\.example\.internal/);
    });

    it("rejects an unknown preset name even when no built-ins are defined", () => {
      const result = runPolicyRemoveCustom("bogus", ["--yes"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown preset 'bogus'/);
    });
  });

  describe("policy-add --from-file / --from-dir", () => {
    function runPolicyAddExternal(
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
      promptAnswer = "y",
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-external-"));
      const scriptPath = path.join(tmpDir, "policy-add-external.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => null;
policies.listPresets = () => [];
policies.getAppliedPresets = () => [];
policies.loadPresetFromFile = (p) => {
  calls.push({ type: "load", path: p });
  if (String(p).includes("bad")) return null;
  const m = String(p).match(/([a-z0-9-]+)\.yaml$/);
  const name = m ? m[1] : "unknown";
  return { presetName: name, content: "network_policies:\n  " + name + ":\n    host: " + name + ".example.com\n" };
};
policies.applyPresetContent = (sandboxName, presetName) => {
  calls.push({ type: "apply", sandboxName, presetName });
  return true;
};
policies.getPresetEndpoints = (content) => {
  const m = String(content).match(/host:\s*([^\s]+)/);
  return m ? [m[1]] : [];
};
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(promptAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add", ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("applies a custom preset when --from-file and --yes are provided", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(
        file,
        "preset:\n  name: custom-rule\nnetwork_policies:\n  custom-rule:\n    name: r\n",
      );
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({ type: "load", path: file });
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
    });

    it("exits non-zero when --from-file points to an unreadable preset", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-bad-"));
      const file = path.join(tmp, "bad.yaml");
      fs.writeFileSync(file, "preset:\n  name: ignored\n");
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).not.toBe(0);
    });

    it("does not apply and does not prompt under --from-file --dry-run", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-dry-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file, "--dry-run", "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(result.stdout).toMatch(/--dry-run: 'custom-rule' not applied\./);
    });

    it("skips the confirmation prompt when NEMOCLAW_NON_INTERACTIVE=1", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-env-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], { NEMOCLAW_NON_INTERACTIVE: "1" });
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
    });

    it("does not apply an external preset when the confirmation prompt is declined", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-no-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], {}, "no");
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeTruthy();
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
    });

    it("errors when --from-file and --from-dir are combined", () => {
      const result = runPolicyAddExternal(["--from-file", "a.yaml", "--from-dir", "b"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/cannot also be provided/);
    });

    it("errors when --from-file is missing its path argument", () => {
      const result = runPolicyAddExternal(["--from-file"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--from-file/);
      expect(result.stderr).toMatch(/value|argument|path/);
    });

    it("applies every preset in --from-dir in sorted order and aborts on the first failure", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-"));
      fs.writeFileSync(
        path.join(dir, "a-good.yaml"),
        "preset:\n  name: a-good\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "b-bad.yaml"),
        "preset:\n  name: b-bad\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "c-skipped.yaml"),
        "preset:\n  name: c-skipped\nnetwork_policies: {}\n",
      );
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).not.toBe(0);
      // a-good succeeded (visible as the [a-good] endpoints log), b-bad triggered abort,
      // c-skipped was never loaded because the loop stopped at b-bad.
      expect(result.stdout).toMatch(/\[a-good\] Endpoints that would be opened/);
      expect(result.stdout).not.toMatch(/\[c-skipped\]/);
      expect(result.stderr).toMatch(/Aborting --from-dir/);
    });

    it("skips hidden dotfile YAML presets for --from-dir", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-hidden-"));
      fs.writeFileSync(path.join(dir, ".bad.yaml"), "preset:\n  name: bad\nnetwork_policies: {}\n");
      fs.writeFileSync(
        path.join(dir, "real.yaml"),
        "preset:\n  name: real\nnetwork_policies: {}\n",
      );
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      const loads = calls.filter((c) => c.type === "load").map((c) => c.path);
      expect(loads.length).toBe(1);
      expect(loads[0]).toMatch(/real\.yaml$/);
    });

    it("errors when --from-dir points at a non-directory", () => {
      const result = runPolicyAddExternal(["--from-dir", "/does/not/exist"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Directory not found/);
    });

    it("skips subdirectories ending in .yaml or .yml for --from-dir", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-skipdir-"));
      // A real preset file and a directory that happens to match the yaml glob.
      fs.writeFileSync(
        path.join(dir, "real.yaml"),
        "preset:\n  name: real\nnetwork_policies: {}\n",
      );
      fs.mkdirSync(path.join(dir, "archived.yaml"));
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      // Only the real file should have been loaded.
      const loads = calls.filter((c) => c.type === "load").map((c) => c.path);
      expect(loads.length).toBe(1);
      expect(loads[0]).toMatch(/real\.yaml$/);
    });
  });
});
