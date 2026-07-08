// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const policyTierOnboardScriptRepoRoot = path.join(import.meta.dirname, "..", "..");

export function runPolicyTierOnboardScript(
  scriptBody: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tier-onboard-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpDir,
    NEMOCLAW_NON_INTERACTIVE: "1",
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: policyTierOnboardScriptRepoRoot,
    encoding: "utf-8",
    env,
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

export function buildPolicyTierOnboardPreamble({
  tierEnv = "balanced",
  policyMode = "skip",
  policyPresets = "",
  stubOpenshellBin = false,
  runCaptureReturn = "",
}: {
  tierEnv?: string;
  policyMode?: string;
  policyPresets?: string;
  stubOpenshellBin?: boolean;
  runCaptureReturn?: string;
} = {}): string {
  const repoRoot = policyTierOnboardScriptRepoRoot;
  const credPath = JSON.stringify(path.join(repoRoot, "src", "lib", "credentials", "store.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const resolveOpenshellPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "adapters", "openshell", "resolve.ts"),
  );

  const openshellStub = stubOpenshellBin
    ? `require(${resolveOpenshellPath}).resolveOpenshell = () => "/usr/bin/true";`
    : "";

  return String.raw`
const credentials = require(${credPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});

Object.defineProperty(process, "platform", { value: "darwin" });

credentials.prompt = async (msg) => { throw new Error("unexpected prompt: " + msg); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;
runner.run = () => {};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  if (text.includes("sandbox list")) return "test-sb Ready";
  return ${JSON.stringify(runCaptureReturn)};
};
${openshellStub}

const updates = [];
registry.registerSandbox = () => true;
registry.updateSandbox = (_name, fields) => { updates.push(fields); return true; };
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });

process.env.NEMOCLAW_POLICY_TIER = ${JSON.stringify(tierEnv)};
process.env.NEMOCLAW_POLICY_MODE = ${JSON.stringify(policyMode)};
process.env.NEMOCLAW_POLICY_PRESETS = ${JSON.stringify(policyPresets)};

const { selectPolicyTier, setupPoliciesWithSelection } = require(${onboardPath});
`;
}
