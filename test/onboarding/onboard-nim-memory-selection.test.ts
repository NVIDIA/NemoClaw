// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
  createOnboardProcessWorkspace,
  type OnboardProcessWorkspace,
} from "../helpers/onboard-child-process-harness.js";
import { onboardChildRuntimeSource } from "../helpers/onboard-child-runtime.js";

const repoRoot = path.join(import.meta.dirname, "../..");
const credentialsPath = JSON.stringify(
  path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
);
const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));
const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
const unifiedGpu = JSON.stringify({
  type: "nvidia",
  totalMemoryMB: 131072,
  availableMemoryMB: 119808,
  unifiedMemory: true,
  nimCapable: true,
});

function writeSuccessfulCurl(workspace: OnboardProcessWorkspace): void {
  workspace.writeExecutable(
    "curl",
    `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' '{"data":[{"id":"nvidia/nemotron-3-nano"}]}' > "$outfile"
printf '%s' "200"
`,
  );
}

describe("NIM onboarding memory selection", () => {
  it("selects Nemotron 3 Nano when Nemotron 3 Super exceeds usable unified memory", () => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-nim-memory-");
    writeSuccessfulCurl(workspace);
    const script = String.raw`
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nimMod = require(${nimPath});
let selectedNimModel = null;
nimMod.pullNimImage = (model) => { selectedNimModel = model; };
nimMod.containerName = () => "nemoclaw-nim-test";
nimMod.startNimContainerByName = () => "container-123";
nimMod.waitForNimHealth = () => true;
nimMod.isNgcLoggedIn = () => true;
nimMod.adoptServedModelId = () => "nvidia/nemotron-3-nano";
const { messages } = installPromptQueue(credentials, ["8", "1", "ngc-test"]);
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
reportChildScenario(async () => {
  const result = await setupNim(${unifiedGpu});
  return { result, messages, selectedNimModel };
});
`;

    try {
      const result = workspace.runNodeSource(script, {
        name: "nim-memory-selection.js",
        cwd: repoRoot,
        env: workspace.environment({ NEMOCLAW_EXPERIMENTAL: "1" }),
      });
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.result.provider, "vllm-local");
      assert.equal(payload.result.model, "nvidia/nemotron-3-nano");
      assert.equal(payload.selectedNimModel, "nvidia/nemotron-3-nano-30b-a3b");
      assert.ok(
        payload.lines.some((line: string) =>
          line.includes("Models that fit 65536 MB of usable GPU memory"),
        ),
      );
    } finally {
      workspace.remove();
    }
  });

  it("removes the NIM container before selecting cloud inference after a health failure", () => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-nim-health-fallback-");
    const script = String.raw`
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nimMod = require(${nimPath});
let stoppedContainer = null;
nimMod.pullNimImage = () => {};
nimMod.containerName = () => "nemoclaw-nim-test";
nimMod.startNimContainerByName = () => "container-123";
nimMod.waitForNimHealth = () => false;
nimMod.stopNimContainerByNameOrThrow = (name) => { stoppedContainer = name; };
nimMod.isNgcLoggedIn = () => true;
installPromptQueue(credentials, ["8", "1", "ngc-test"]);
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
reportChildScenario(async () => {
  const result = await setupNim(${unifiedGpu});
  return { result, stoppedContainer };
});
`;

    try {
      const result = workspace.runNodeSource(script, {
        name: "nim-health-fallback.js",
        cwd: repoRoot,
        env: workspace.environment({ NEMOCLAW_EXPERIMENTAL: "1" }),
      });
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.stoppedContainer, "nemoclaw-nim-test");
      assert.notEqual(payload.result.provider, "vllm-local");
      assert.equal(payload.result.nimContainer, null);
    } finally {
      workspace.remove();
    }
  });

  it("stops instead of selecting cloud inference when NIM removal is not confirmed", () => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-nim-cleanup-failure-");
    const script = String.raw`
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nimMod = require(${nimPath});
nimMod.pullNimImage = () => {};
nimMod.containerName = () => "nemoclaw-nim-test";
nimMod.startNimContainerByName = () => "nemoclaw-nim-test";
nimMod.waitForNimHealth = () => false;
nimMod.stopNimContainerByNameOrThrow = () => {
  throw new Error("Could not remove NIM container 'nemoclaw-nim-test'. Refusing to continue because it may still own its credentials and port.");
};
nimMod.isNgcLoggedIn = () => true;
installPromptQueue(credentials, ["8", "1", "ngc-test"]);
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
setupNim(${unifiedGpu}).then(() => {
  console.error("unexpected cloud fallback");
  process.exit(2);
});
`;

    try {
      const result = workspace.runNodeSource(script, {
        name: "nim-cleanup-failure.js",
        cwd: repoRoot,
        env: workspace.environment({ NEMOCLAW_EXPERIMENTAL: "1" }),
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /Refusing to continue because it may still own its credentials and port/,
      );
      assert.doesNotMatch(result.stderr, /unexpected cloud fallback/);
    } finally {
      workspace.remove();
    }
  });

  it("rejects a non-interactive NIM model whose minimum exceeds usable memory before image pull", () => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-nim-memory-reject-");
    const script = String.raw`
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nimMod = require(${nimPath});
nimMod.pullNimImage = () => { throw new Error("unexpected NIM image pull"); };
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
setupNim(${unifiedGpu}).then(() => {
  console.error("unexpected NIM selection success");
  process.exit(2);
}).catch((error) => {
  console.error(error);
  process.exit(3);
});
`;

    try {
      const result = workspace.runNodeSource(script, {
        name: "nim-memory-reject.js",
        cwd: repoRoot,
        env: workspace.environment({
          NEMOCLAW_EXPERIMENTAL: "1",
          NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_PROVIDER: "nim-local",
        }),
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /requires at least 127386 MB; NIM can use 65536 MB/);
      assert.doesNotMatch(result.stderr, /unexpected NIM image pull/);
    } finally {
      workspace.remove();
    }
  });
});
