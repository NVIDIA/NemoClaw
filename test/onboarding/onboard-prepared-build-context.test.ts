// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

type PreparedContextScenario = "create" | "custom-dockerfile";

type PreparedContextResult = {
  buildCtx: string;
  buildId: string;
  cleanupCalls: number;
  commands: string[];
  errorMessage: string | null;
  patchCalls: number;
  patchSleepUsesSeconds: boolean | null;
  planFromRefs: string[];
  registerCalls: Array<{ imageTag?: string | null }>;
  resolvedBuildIds: string[];
  stageCalls: number;
};

const repoRoot = path.join(import.meta.dirname, "../..");

function runPreparedContextScenario(scenario: PreparedContextScenario): PreparedContextResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-prepared-context-test-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "scenario.js");
  const preparedBuildCtx = path.join(tmpDir, "prepared-build-context");
  const buildId = "6195000123456";

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(preparedBuildCtx, { recursive: true });
  writeOkOpenshell(fakeBin, { readySandboxGet: true });
  fs.writeFileSync(
    path.join(preparedBuildCtx, "Dockerfile"),
    ["FROM scratch", `ARG NEMOCLAW_BUILD_ID=${buildId}`, 'CMD ["/bin/true"]', ""].join("\n"),
  );

  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
  const preflightPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
  );
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
  );
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
  const buildContextStagePath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "build-context-stage.ts"),
  );
  const dockerfilePatchFlowPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "sandbox-dockerfile-patch-flow.ts"),
  );
  const sandboxCreatePlanPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "sandbox-create-plan-materialization.ts"),
  );
  const imageTagPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "domain", "sandbox", "image-tag.ts"),
  );
  const dockerGpuSandboxCreatePath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "docker-gpu-sandbox-create.ts"),
  );
  const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));
  const onboardScriptMocksPath = JSON.stringify(
    path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
  );

  const script = String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const scenario = ${JSON.stringify(scenario)};
const buildCtx = ${JSON.stringify(preparedBuildCtx)};
const buildId = ${JSON.stringify(buildId)};
const sandboxName = "prepared-dcode";
const commands = [];
const registerCalls = [];
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName,
  provider: "nvidia-prod",
  model: "nvidia/nemotron-3-super-120b-a12b",
  registerSandbox: (entry) => registerCalls.push(entry),
});
const runner = require(${runnerPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const buildContextStage = require(${buildContextStagePath});
const dockerfilePatchFlow = require(${dockerfilePatchFlowPath});
const sandboxCreatePlanMaterialization = require(${sandboxCreatePlanPath});
const imageTag = require(${imageTagPath});
const dockerGpuSandboxCreate = require(${dockerGpuSandboxCreatePath});
const wait = require(${waitPath});
const { loadAgent } = require(${agentDefsPath});
const planFromRefs = [];
const resolvedBuildIds = [];
let cleanupCalls = 0;
let patchCalls = 0;
let patchSleepUsesSeconds = null;
let stageCalls = 0;
let sandboxCreated = false;

dockerGpuSandboxCreate.createDockerGpuSandboxCreatePatch = (options) => {
  patchSleepUsesSeconds = options.deps.sleep === wait.sleepSeconds;
  return {
  maybeApplyDuringCreate: () => {},
  createFailureMessage: () => null,
  exitOnPatchError: async () => {},
  attachManagedBootstrapCutover: () => {},
  rollbackManagedStartupAfterCreateFailure: async () => {},
  ensureApplied: async () => {},
  waitForSupervisorReconnectIfNeeded: () => {},
  commitAfterReady: async () => {},
  selectedMode: () => null,
  printReadinessFailureIfEnabled: () => {},
  verifyGpuOrExit: async (verify) => verify(sandboxName),
  };
};

buildContextStage.stageCreateSandboxBuildContext = () => {
  stageCalls += 1;
  throw new Error("prepared context was unexpectedly restaged");
};
dockerfilePatchFlow.prepareSandboxDockerfilePatch = async () => {
  patchCalls += 1;
  throw new Error("prepared context was unexpectedly repatched");
};

const materializeSandboxCreatePlan = sandboxCreatePlanMaterialization.materializeSandboxCreatePlan;
sandboxCreatePlanMaterialization.materializeSandboxCreatePlan = (input) => {
  planFromRefs.push(input.fromRef);
  return materializeSandboxCreatePlan(input);
};
const resolveSandboxImageTagFromCreateOutput = imageTag.resolveSandboxImageTagFromCreateOutput;
imageTag.resolveSandboxImageTagFromCreateOutput = (output, receivedBuildId, warn) => {
  resolvedBuildIds.push(receivedBuildId);
  return resolveSandboxImageTagFromCreateOutput(output, receivedBuildId, warn);
};

const normalize = (command) =>
  (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
runner.run = (command) => {
  const normalized = normalize(command);
  commands.push(normalized);
  const profileResult = require(${onboardScriptMocksPath}).mockManagedEndpointlessProviderProfileRun(command);
  if (profileResult !== null) return profileResult;
  return normalized.includes("sandbox get") && normalized.includes(sandboxName)
    ? { status: 0, stdout: Buffer.from(sandboxName + "\nId: sbx-4f2a91c0d7\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
runner.runFile = (file, args = []) => {
  commands.push(normalize([file, ...args]));
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = normalize(command);
  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName });
  if (createdIdentity !== null) return createdIdentity;
  if (
    normalized.includes(
      "sandbox exec --name " +
        sandboxName +
        " --gateway nemoclaw -- /usr/local/bin/dcode identity",
    )
  ) {
    return [
      "Route:    inference",
      "Provider: nvidia-prod",
      "Model:    openai:nvidia/nemotron-3-super-120b-a12b",
      "Endpoint: https://inference.local/v1",
    ].join("\n");
  }
  if (normalized.includes("sandbox get")) {
    return sandboxCreated ? sandboxName + "\nId: sbx-4f2a91c0d7\n" : "";
  }
  if (normalized.includes("sandbox list")) return sandboxName + " Ready";
  return "";
};
registry.getDefault = () => null;
registry.listExtraProviders = () => [];
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 6195;
  commands.push(normalize([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]));
  process.nextTick(() => {
    sandboxCreated = true;
    child.stdout.emit("data", Buffer.from("Created sandbox: " + sandboxName + "\n"));
    child.emit("close", 0);
  });
  return child;
};

const preparedBuildContext = {
  buildCtx,
  stagedDockerfile: buildCtx + "/Dockerfile",
  buildId,
  origin: "generated",
  cleanupBuildCtx: () => {
    cleanupCalls += 1;
    fs.rmSync(buildCtx, { recursive: true, force: true });
    return true;
  },
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const agent = loadAgent("langchain-deepagents-code");
  let errorMessage = null;
  try {
    await createSandbox(
      null,
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia-prod",
      null,
      sandboxName,
      null,
      null,
      scenario === "custom-dockerfile" ? "/tmp/custom/Dockerfile" : null,
      agent,
      null,
      null,
      null,
      [],
      null,
      { sessionId: createFixture.sessionId },
      null,
      null,
      preparedBuildContext,
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify({
    buildCtx,
    buildId,
    cleanupCalls,
    commands,
    errorMessage,
    patchCalls,
    patchSleepUsesSeconds,
    planFromRefs,
    registerCalls,
    resolvedBuildIds,
    stageCalls,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  fs.writeFileSync(scriptPath, script);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_HOME: path.join(tmpDir, ".nemoclaw"),
      NEMOCLAW_NON_INTERACTIVE: "1",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payloadLine = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("{") && line.endsWith("}"));
  assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
  return JSON.parse(payloadLine) as PreparedContextResult;
}

describe("onboard prepared DCode build context", () => {
  it(
    "creates from the supplied context without restaging or repatching it (#6195)",
    {
      timeout: 90_000,
    },
    () => {
      const result = runPreparedContextScenario("create");

      assert.equal(result.errorMessage, null);
      assert.equal(result.stageCalls, 0);
      assert.equal(result.patchCalls, 0);
      assert.deepEqual(result.planFromRefs, [`${result.buildCtx}/Dockerfile`]);
      assert.deepEqual(result.resolvedBuildIds, [result.buildId]);
      assert.equal(result.cleanupCalls, 1);
      assert.ok(
        result.commands.some((command) =>
          command.includes(`sandbox create --from ${result.buildCtx}/Dockerfile`),
        ),
        `expected create command to use prepared context; commands:\n${result.commands.join("\n")}`,
      );
      assert.ok(
        result.registerCalls.some(
          (entry) => entry.imageTag === `openshell/sandbox-from:${result.buildId}`,
        ),
        "expected the prepared build ID to determine the registered image tag",
      );
    },
  );

  it(
    "passes the seconds-based sleep helper to the Docker GPU patch during prepared-context onboarding (#9218)",
    {
      timeout: 90_000,
    },
    () => {
      const result = runPreparedContextScenario("create");

      assert.equal(result.errorMessage, null);
      assert.equal(result.patchSleepUsesSeconds, true);
    },
  );

  it(
    "rejects a prepared context combined with a custom Dockerfile (#6195)",
    {
      timeout: 90_000,
    },
    () => {
      const result = runPreparedContextScenario("custom-dockerfile");

      assert.match(
        result.errorMessage ?? "",
        /prepared DCode build context cannot be used for this sandbox target/i,
      );
      assert.equal(result.stageCalls, 0);
      assert.equal(result.patchCalls, 0);
      assert.deepEqual(result.planFromRefs, []);
      assert.deepEqual(result.resolvedBuildIds, []);
      assert.equal(result.cleanupCalls, 0);
      assert.equal(
        result.commands.some((command) => command.includes("sandbox create")),
        false,
      );
      assert.deepEqual(result.registerCalls, []);
    },
  );
});
