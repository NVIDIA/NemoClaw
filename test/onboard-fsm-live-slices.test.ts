// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

function runSliceProbe(slice: "initial" | "core" | "final") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-onboard-fsm-${slice}-`));
  const scriptPath = path.join(tmpDir, `probe-${slice}.js`);
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const flowSlicesPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "flow-slices.js"),
  );
  const resultPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "result.js"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const flowSlices = require(${flowSlicesPath});
const { advanceTo, branchTo } = require(${resultPath});
const called = [];
const sentinel = new Error("slice-called");

function baseContext(context, overrides = {}) {
  return {
    ...context,
    session: overrides.session ?? context.session ?? null,
    sandboxName: overrides.sandboxName ?? context.sandboxName ?? "fsm-sandbox",
    model: overrides.model ?? context.model ?? "model",
    provider: overrides.provider ?? context.provider ?? "provider",
    endpointUrl: overrides.endpointUrl ?? context.endpointUrl ?? null,
    credentialEnv: overrides.credentialEnv ?? context.credentialEnv ?? null,
    hermesAuthMethod: overrides.hermesAuthMethod ?? context.hermesAuthMethod ?? null,
    hermesToolGateways: overrides.hermesToolGateways ?? context.hermesToolGateways ?? [],
    preferredInferenceApi: overrides.preferredInferenceApi ?? context.preferredInferenceApi ?? null,
    nimContainer: overrides.nimContainer ?? context.nimContainer ?? null,
    webSearchConfig: overrides.webSearchConfig ?? context.webSearchConfig ?? null,
    webSearchSupported: overrides.webSearchSupported ?? context.webSearchSupported ?? false,
    selectedMessagingChannels: overrides.selectedMessagingChannels ?? context.selectedMessagingChannels ?? [],
    gpu: overrides.gpu ?? context.gpu ?? null,
    sandboxGpuConfig: overrides.sandboxGpuConfig ?? context.sandboxGpuConfig ?? { sandboxGpuEnabled: false, mode: "0" },
    gpuPassthrough: overrides.gpuPassthrough ?? context.gpuPassthrough ?? false,
    resumeHasResolvedGpuIntent: false,
    requestedGpuPassthrough: false,
  };
}

flowSlices.runInitialOnboardFlowSequence = async ({ context, runtime }) => {
  called.push("initial");
  if (${JSON.stringify(slice)} === "initial") throw sentinel;
  const initialSession = await runtime.session();
  if (initialSession.machine?.state === "init") {
    await runtime.applyResult(advanceTo("preflight"));
  }
  await runtime.applyResult(advanceTo("gateway", { metadata: { state: "preflight" } }));
  await runtime.applyResult(advanceTo("provider_selection", { metadata: { state: "gateway" } }));
  const session = await runtime.session();
  return { context: baseContext(context, { session }), session };
};

flowSlices.runCoreOnboardFlowSequence = async ({ context, runtime }) => {
  called.push("core");
  if (${JSON.stringify(slice)} === "core") throw sentinel;
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", { metadata: { state: "inference" } }));
  await runtime.applyResult(branchTo("openclaw", { metadata: { state: "sandbox" } }));
  const session = await runtime.session();
  return { context: baseContext(context, { session }), session };
};

flowSlices.runFinalOnboardFlowSequence = async ({ context }) => {
  called.push("final");
  if (${JSON.stringify(slice)} === "final") throw sentinel;
  throw new Error("unexpected final slice fallthrough");
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({ nonInteractive: true, autoYes: true, acceptThirdPartySoftware: true, noGpu: true });
    throw new Error("expected slice sentinel");
  } catch (error) {
    if (error === sentinel || error?.message === sentinel.message) {
      console.log(JSON.stringify({ called }));
      return;
    }
    console.error(error);
    process.exit(1);
  }
})();
`,
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_YES: "1",
    },
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const payload = JSON.parse(lines.at(-1) || "{}");
    return payload.called as string[];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("live onboard FSM slice boundaries", () => {
  it("enters the initial slice on fresh onboard runs", () => {
    assert.deepEqual(runSliceProbe("initial"), ["initial"]);
  });

  it("enters the core slice after the initial slice reaches provider selection", () => {
    assert.deepEqual(runSliceProbe("core"), ["initial", "core"]);
  });

  it("enters the final slice after the core slice reaches the branch state", () => {
    assert.deepEqual(runSliceProbe("final"), ["initial", "core", "final"]);
  });
});
