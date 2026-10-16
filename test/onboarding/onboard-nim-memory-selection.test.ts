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
const onboardProbesPath = JSON.stringify(
  path.join(repoRoot, "src", "lib", "inference", "onboard-probes.ts"),
);
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
nimMod.startNimContainerByName = () => ({ name: "container-123", id: "a".repeat(64) });
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

  it("stops the production Local NIM handler before model adoption after a health failure", () => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-nim-health-fallback-");
    const script = String.raw`
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nimMod = require(${nimPath});
const onboardProbes = require(${onboardProbesPath});
let stoppedContainer = null;
let adoptedModel = false;
let validationProbes = 0;
onboardProbes.probeOpenAiLikeEndpointOptimized = async () => {
  validationProbes++;
  throw new Error("unexpected provider validation after failed NIM health check");
};
nimMod.pullNimImage = () => {};
nimMod.containerName = () => "nemoclaw-nim-test";
nimMod.startNimContainerByName = () => ({ name: "container-returned-by-start", id: "b".repeat(64) });
nimMod.waitForNimHealth = () => false;
nimMod.stopNimContainerByIdOrThrow = (id) => { stoppedContainer = id; };
nimMod.adoptServedModelId = () => { adoptedModel = true; return "unexpected-model"; };
nimMod.isNgcLoggedIn = () => true;
installPromptQueue(credentials, ["8", "1", "ngc-test"]);
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
reportChildScenario(async () => {
  let failure = null;
  try {
    await setupNim(${unifiedGpu});
  } catch (error) {
    failure = String(error);
  }
  return { failure, stoppedContainer, adoptedModel, validationProbes };
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
      assert.equal(payload.stoppedContainer, "b".repeat(64));
      assert.match(payload.failure, /Local NVIDIA NIM failed to become healthy/);
      assert.equal(payload.adoptedModel, false);
      assert.equal(payload.validationProbes, 0);
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
nimMod.startNimContainerByName = () => ({ name: "nemoclaw-nim-test", id: "c".repeat(64) });
nimMod.waitForNimHealth = () => false;
nimMod.stopNimContainerByIdOrThrow = () => {
  throw new Error("Could not remove owned NIM container after failed health check.");
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
      assert.match(result.stderr, /Could not remove owned NIM container after failed health check/);
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
