// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";

import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
  runOnboardProcess,
  trailingJsonPayload,
} from "../helpers/onboard-child-process-harness";

type HandoffScenario = "prepared" | "ordinary" | "mismatch";

type HandoffResult = {
  error: string | null;
  flowCalls: number;
  gatewayAtInitialFlow: string | null;
};

const repoRoot = path.join(import.meta.dirname, "../..");
const sourceRequireHook = path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs");

function runHandoffScenario(scenario: HandoffScenario): HandoffResult {
  const workspace = createOnboardProcessWorkspace(`nemoclaw-gateway-handoff-${scenario}-`);
  const home = workspace.homeDir;
  const scriptPath = workspace.path("scenario.cjs");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const sessionPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
  );
  const checkpointPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "state", "onboard-checkpoint-migrate.ts"),
  );
  const initialFlowPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "initial-flow-phases.ts"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const initialFlow = require(${initialFlowPath});
const onboardSession = require(${sessionPath});
const { deriveCheckpointFromSession } = require(${checkpointPath});
const scenario = ${JSON.stringify(scenario)};
const stopAtInitialFlow = new Error("stop at initial onboarding flow");
let flowCalls = 0;
let gatewayAtInitialFlow = null;

initialFlow.runInitialOnboardFlowSlice = async () => {
  flowCalls += 1;
  gatewayAtInitialFlow = process.env.OPENSHELL_GATEWAY || null;
  throw stopAtInitialFlow;
};

if (scenario === "prepared") {
  const session = onboardSession.createSession({
    mode: "non-interactive",
    agent: "langchain-deepagents-code",
    sandboxName: "prepared-dcode",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  });
  session.checkpoint = deriveCheckpointFromSession(session, { profile: "default" });
  onboardSession.saveSession(session);
}

process.env.OPENSHELL_GATEWAY = "ambient-other-gateway";
if (scenario === "prepared") process.env.NEMOCLAW_SANDBOX_NAME = "prepared-dcode";
const preparedBuildContext = {
  buildCtx: ${JSON.stringify(path.join(home, "prepared-context"))},
  stagedDockerfile: ${JSON.stringify(path.join(home, "prepared-context", "Dockerfile"))},
  buildId: "6195-prepared",
  origin: "generated",
  cleanupBuildCtx: () => true,
};
const common = {
  nonInteractive: true,
  acceptThirdPartySoftware: true,
  noGpu: true,
  agent: "langchain-deepagents-code",
};
const options = scenario === "prepared"
  ? {
      ...common,
      resume: true,
      recreateSandbox: true,
      preparedDcodeRebuild: {
        buildContext: preparedBuildContext,
        gatewayName: "nemoclaw",
        dcodeAutoApprovalMode: "disabled",
      },
    }
  : scenario === "mismatch"
    ? {
        ...common,
        resume: true,
        recreateSandbox: true,
        preparedDcodeRebuild: {
          buildContext: preparedBuildContext,
          gatewayName: "nemoclaw-18080",
          dcodeAutoApprovalMode: "disabled",
        },
      }
    : { ...common, fresh: true, sandboxName: "ordinary-dcode" };

const { onboard } = require(${onboardPath});

(async () => {
  let error = null;
  try {
    await onboard(options);
    error = "onboard unexpectedly completed";
  } catch (caught) {
    if (caught !== stopAtInitialFlow && caught?.message !== stopAtInitialFlow.message) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  console.log(JSON.stringify({ error, flowCalls, gatewayAtInitialFlow }));
})().catch((caught) => {
  console.error(caught?.stack || caught);
  process.exit(1);
});
`,
  );

  const result = runOnboardProcess(["--require", sourceRequireHook, scriptPath], {
    env: minimalSpawnEnv(home),
    timeoutMs: 45_000,
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return trailingJsonPayload<HandoffResult>(result.stdout);
  } finally {
    workspace.remove();
  }
}

describe("prepared DCode gateway handoff", { timeout: 60_000 }, () => {
  it("preserves the recorded gateway into the initial onboard flow (#6195)", () => {
    assert.deepEqual(runHandoffScenario("prepared"), {
      error: null,
      flowCalls: 1,
      gatewayAtInitialFlow: "nemoclaw",
    });
  });

  it("scopes an ordinary onboard run to the default gateway (#6315)", () => {
    assert.deepEqual(runHandoffScenario("ordinary"), {
      error: null,
      flowCalls: 1,
      gatewayAtInitialFlow: "nemoclaw",
    });
  });

  it("rejects a mismatched prepared gateway before the initial onboard flow (#6195)", () => {
    const result = runHandoffScenario("mismatch");

    assert.match(result.error ?? "", /does not match 'nemoclaw'/);
    assert.equal(result.flowCalls, 0);
    assert.equal(result.gatewayAtInitialFlow, null);
  });
});
