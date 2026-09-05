// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";

import { runBoundedOnboardScript } from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";
import { onboardScriptMocksPath } from "../helpers/onboard-split-context";

const repoRoot = path.join(import.meta.dirname, "../..");

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

type ProviderBoundaryMode = "create" | "deferred" | "ordinary-resume" | "superseded";

type ProviderBoundaryResult = {
  events: string[];
  firstError: string | null;
  gpuCreateCalls: number;
  portableTransactions: number;
  providerCalls: string[][];
  result: string;
};

const expectedProviderCalls = [
  ["provider", "get", "-g", "nemoclaw", "nvidia-prod"],
  ["provider", "update", "-g", "nemoclaw", "nvidia-prod"],
];

function runProviderBoundary(mode: ProviderBoundaryMode): ProviderBoundaryResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-boundary-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "provider-boundary.js");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeOkOpenshell(fakeBin);

  const modulePath = (relativePath: string) =>
    JSON.stringify(path.join(repoRoot, "src", "lib", relativePath));
  const script = String.raw`
const fixtureMocks = require(${onboardScriptMocksPath});
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const fs = require("node:fs");
const runner = require(${modulePath("runner.ts")});
const registry = require(${modulePath("state/registry.ts")});
const preflight = require(${modulePath("onboard/preflight.ts")});
const credentials = require(${modulePath("credentials/store.ts")});
const agentOnboardId = require.resolve(${modulePath("agent/onboard.ts")});
const createdSandboxFinalizationId = require.resolve(${modulePath("onboard/created-sandbox-finalization.ts")});
const dashboardPortId = require.resolve(${modulePath("onboard/dashboard-port.ts")});
const dashboardRuntimeId = require.resolve(${modulePath("onboard/dashboard-runtime.ts")});
const sandboxGpuCreateFlowId = require.resolve(${modulePath("onboard/sandbox-gpu-create-flow.ts")});
const sandboxProviderCleanupId = require.resolve(${modulePath("onboard/sandbox-provider-cleanup.ts")});
const normalize = (command) => Array.isArray(command) ? command.map(String) : [String(command)];
const events = [];
const providerCalls = [];
let gpuCreateCalls = 0;
let portableTransactions = 0;
const portableMode = ${JSON.stringify(mode !== "ordinary-resume")};
const customDockerfile = process.env.HOME + "/Dockerfile";
fs.writeFileSync(customDockerfile, [
  "FROM scratch",
  "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
  "ENV NEMOCLAW_TOOL_DISCLOSURE=" + "$" + "{NEMOCLAW_TOOL_DISCLOSURE}",
  "",
].join("\n"));
const sandboxName = "my-assistant";
const gatewayName = "nemoclaw";
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName,
  sandboxId: "sbx-hermes-provider-boundary",
  gatewayName,
});
createdSandbox.installRuntimeObservation();

runner.run = (command) => {
  const args = normalize(command);
  const providerIndex = args.indexOf("provider");
  const providerArgs = providerIndex < 0 ? null : args.slice(providerIndex);
  const text = providerArgs?.join(" ") ?? args.join(" ");
  if (providerArgs) providerCalls.push(providerArgs);
  const providerGet = fixtureMocks.mockNvidiaProviderGetRun(command, gatewayName);
  if (providerGet !== null) return providerGet;
  if (text === "provider update -g nemoclaw nvidia-prod") {
    events.push("provider:update");
    return { status: 0, stdout: "" };
  }
  return createdSandbox.run(command) ?? { status: 0, stdout: "" };
};
runner.runCapture = (command) => {
  const captured = createdSandbox.capture(command);
  if (captured !== null) return captured;
  const mocked = fixtureMocks.mockOnboardRunCapture(command, { defaultCurlOutput: "ok" });
  if (mocked !== null) return mocked;
  if (normalize(command).join(" ").includes("forward list")) return "";
  return "";
};
fixtureMocks.mockDockerSandboxLifecycleReleaseFromRunner();
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName,
  gatewayName,
  agentName: portableMode ? "hermes" : "langchain-deepagents-code",
  provider: "nvidia-prod",
  model: "gpt-5.4",
});
if (!portableMode) {
  const getSandbox = registry.getSandbox;
  registry.getSandbox = (name) => {
    const entry = getSandbox(name);
    return entry ? { ...entry, gatewayPort: 8080 } : entry;
  };
}
const registerSandbox = registry.registerSandbox;
let rejectRegistration = !portableMode;
registry.registerSandbox = (entry) => {
  if (rejectRegistration) {
    rejectRegistration = false;
    throw new Error("injected registry publication failure");
  }
  return registerSandbox(entry);
};

const portableRuntimeContext = {
  authority: {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    homeDir: process.env.HOME,
    configHome: process.env.HOME + "/.config",
    runtimeDir: process.env.HOME + "/runtime",
    socketPath: process.env.HOME + "/runtime/podman.sock",
  },
  environmentScope: {},
};
const dashboardPort = require(dashboardPortId);
require.cache[dashboardPortId].exports = {
  ...dashboardPort,
  reserveCreateSandboxDashboardPort: async (input) => {
    const effectivePort = input.controlUiPort ?? input.defaultPort ?? 18789;
    return {
      preferredPort: effectivePort,
      effectivePort,
      chatUiUrl: "http://127.0.0.1:" + effectivePort,
      reservation: null,
    };
  },
};
const dashboardRuntime = require(dashboardRuntimeId);
require.cache[dashboardRuntimeId].exports = {
  ...dashboardRuntime,
  shouldManageDashboardForAgent: () => false,
};
const createdSandboxFinalization = require(createdSandboxFinalizationId);
require.cache[createdSandboxFinalizationId].exports = {
  ...createdSandboxFinalization,
  completeOrdinaryOnboardSandboxCreation: ({ sandboxName }) => sandboxName,
};
const sandboxProviderCleanup = require(sandboxProviderCleanupId);
require.cache[sandboxProviderCleanupId].exports = {
  ...sandboxProviderCleanup,
  runSandboxProviderPreDeleteCleanup: () => ({ detached: [], failures: [] }),
};
const agentOnboard = require(agentOnboardId);
const createScopedEntryPoints = agentOnboard.createHermesApiPortScopedSandboxEntryPoints;
require.cache[agentOnboardId].exports = {
  ...agentOnboard,
  createHermesApiPortScopedSandboxEntryPoints: (deps) => createScopedEntryPoints({
    ...deps,
    resolvePortableRuntimeContext: () => portableRuntimeContext,
  }),
};

const sandboxGpuCreateFlow = require(sandboxGpuCreateFlowId);
require.cache[sandboxGpuCreateFlowId].exports = {
  ...sandboxGpuCreateFlow,
  runHermesPortableOnboardingFromOnboard: async (input) => {
    portableTransactions += 1;
    events.push("portable:transaction");
    if (${JSON.stringify(mode)} === "superseded") return { created: false };
    const attemptArgv = [...input.createArgv];
    const separator = attemptArgv.indexOf("--");
    attemptArgv.splice(
      separator < 0 ? attemptArgv.length : separator,
      0,
      "--label",
      "ai.nvidia.nemoclaw.create-attempt=" + "a".repeat(62),
    );
    const created = await input.createSandbox(
      attemptArgv,
      undefined,
      undefined,
      process.cwd(),
      input.createPolicyPath,
    );
    return { created: true, value: created };
  },
  runSandboxGpuCreateFlow: async (input) => {
    gpuCreateCalls += 1;
    events.push(input.resumeVerifiedCreate ? "sandbox:resume" : "sandbox:create");
    if (!input.resumeVerifiedCreate) {
      const observedCreateArgv = [...input.createArgv];
      if (!observedCreateArgv.some((value) => value.startsWith("ai.nvidia.nemoclaw.create-attempt="))) {
        const separator = observedCreateArgv.indexOf("--");
        observedCreateArgv.splice(
          separator < 0 ? observedCreateArgv.length : separator,
          0,
          "--label",
          "ai.nvidia.nemoclaw.create-attempt=" + "a".repeat(62),
        );
      }
      createdSandbox.create(observedCreateArgv);
    }
    const identity = {
      sandboxId: createdSandbox.state.sandboxId,
      liveIdentityFingerprint: require("node:crypto")
        .createHash("sha256")
        .update(createdSandbox.state.sandboxId)
        .digest("hex"),
      createAttemptNonce: "a".repeat(62),
      route: "native",
    };
    await input.verifyCreatedSandboxBeforeEffects(identity);
    events.push("sandbox:identity-verified");
    return {
      ...(input.resumeVerifiedCreate
        ? { origin: "resumed" }
        : {
            origin: "created",
            createResult: { status: 0, output: "created", sawProgress: true },
            firstCreateOutput: "created",
          }),
      runtimePatch: { applied: false },
      route: "native",
      registryImageRef: null,
      lifecycleRegistrationFields: input.lifecycleGeneration
        ? { lifecycleGeneration: input.lifecycleGeneration }
        : {},
    };
  },
};

const { createSandbox } = require(${modulePath("onboard.ts")});
const { loadAgent } = require(${modulePath("agent/defs.ts")});
const { resolveSandboxCreateIntent } = require(${modulePath("onboard/sandbox-create-intent.ts")});
const { resolveSandboxGpuConfig } = require(${modulePath("onboard/sandbox-gpu-mode.ts")});
(async () => {
  process.env.OPENSHELL_GATEWAY = gatewayName;
  const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "gpt-5.4", "nvidia-prod", null, sandboxName, null, null, portableMode ? null : customDockerfile, loadAgent(portableMode ? "hermes" : "langchain-deepagents-code"), null, null, null, []],
    createFixture,
  );
  if (portableMode) {
    createArgs[15] = {
      ...createArgs[15],
      deferSandboxEffectsUntilIdentityVerification: ${JSON.stringify(mode === "deferred")},
      resolved: resolveSandboxCreateIntent({
        basePolicyPath: ${JSON.stringify(path.join(repoRoot, "agents/hermes/policy-additions.yaml"))},
        sandboxName,
        inferenceProvider: "nvidia-prod",
        channels: [],
        enabledChannels: [],
        disabledChannelNames: new Set(),
        messagingProviderRequests: [],
        primaryMessagingCredentialEnvKeys: [],
        reusableMessagingChannels: [],
        reusableMessagingProviders: [],
        hermesToolGateways: [],
        sandboxGpuConfig: resolveSandboxGpuConfig(null, { env: {} }),
        gpuCreateArgs: [],
        gpuRoutePlan: "none",
        sandboxGpuLogMessage: null,
        agentName: "hermes",
      }),
    };
  }
  let firstError = null;
  if (!portableMode) {
    try {
      await createSandbox(...createArgs);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    if (!firstError) throw new Error("expected the first verified create to fail");
  }
  const result = await createSandbox(...createArgs);
  console.log(
    JSON.stringify({
      events,
      firstError,
      gpuCreateCalls,
      portableTransactions,
      providerCalls,
      result,
    }),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = runBoundedOnboardScript(scriptPath, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, ".config"),
      XDG_RUNTIME_DIR: path.join(tmpDir, "runtime"),
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_EXPERIMENTAL_PROFILE: mode === "ordinary-resume" ? "default" : "portable",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_SANDBOX_PREBUILD: "0",
      NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "0",
    },
  });

  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as ProviderBoundaryResult;
}

describe("sandbox-create provider publication branches", () => {
  it(
    "publishes providers before non-deferred Hermes portable creation (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("create");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableTransactions, 1);
      assert.ok(
        payload.events.indexOf("portable:transaction") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("provider:update") < payload.events.indexOf("sandbox:create"),
      );
    },
  );

  it(
    "publishes deferred Hermes portable providers after identity verification (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("deferred");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableTransactions, 1);
      assert.ok(
        payload.events.indexOf("portable:transaction") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("sandbox:create") < payload.events.indexOf("provider:update"),
      );
      assert.ok(
        payload.events.indexOf("provider:update") <
          payload.events.indexOf("sandbox:identity-verified"),
      );
    },
  );

  it(
    "does not replay provider publication when ordinary creation resumes (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("ordinary-resume");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, expectedProviderCalls);
      assert.equal(payload.portableTransactions, 0);
      assert.match(payload.firstError ?? "", /registry publication/u);
      assert.equal(payload.gpuCreateCalls, 2);
      assert.equal(payload.events.filter((event) => event === "provider:update").length, 1);
      assert.ok(payload.events.includes("sandbox:resume"));
      assert.ok(
        payload.events.indexOf("provider:update") < payload.events.indexOf("sandbox:create"),
      );
    },
  );

  it(
    "does not publish providers for a superseded Hermes portable transaction (#9806)",
    { timeout: 60_000 },
    () => {
      const payload = runProviderBoundary("superseded");

      assert.equal(payload.result, "my-assistant");
      assert.deepEqual(payload.providerCalls, []);
      assert.equal(payload.portableTransactions, 1);
      assert.equal(payload.gpuCreateCalls, 0);
      assert.deepEqual(payload.events, ["portable:transaction"]);
    },
  );
});
