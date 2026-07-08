// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

type HandoffScenario = "prepared" | "ordinary" | "mismatch";

type HandoffResult = {
  error: string | null;
  flowCalls: number;
  gatewayAtInitialFlow: string | null;
};

const repoRoot = path.join(import.meta.dirname, "..");
const sourceRequireHook = path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs");

function runHandoffScenario(scenario: HandoffScenario): HandoffResult {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-gateway-handoff-${scenario}-`));
  const scriptPath = path.join(home, "scenario.cjs");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const sessionPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
  );
  const initialFlowPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "initial-flow-phases.ts"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const initialFlow = require(${initialFlowPath});
const onboardSession = require(${sessionPath});
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
  onboardSession.saveSession(onboardSession.createSession({
    mode: "non-interactive",
    agent: "langchain-deepagents-code",
    sandboxName: "prepared-dcode",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  }));
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

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH || "/usr/bin:/bin",
    NO_COLOR: "1",
  };
  Object.assign(
    env,
    Object.fromEntries(
      ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]
        .map((key) => [key, process.env[key]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
  );

  const result = spawnSync(process.execPath, ["--require", sourceRequireHook, scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    timeout: 15_000,
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = result.stdout
      .trim()
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payload, `expected JSON payload in stdout:\n${result.stdout}`);
    return JSON.parse(payload) as HandoffResult;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("prepared DCode gateway handoff", () => {
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
