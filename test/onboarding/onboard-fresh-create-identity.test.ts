// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";
import { type CommandEntry, onboardScriptMocksPath } from "../helpers/onboard-split-context";
import { encodeMessagingPlan, makeMessagingPlan } from "../helpers/messaging-plan-fixtures";

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

describe("fresh create identity", () => {
  it.each([
    {
      title: "binds ordinary providers at create time before managed registration (#9833)",
      apfInterceptorRequested: false,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "managed-provider" as const,
    },
    {
      title: "rejects provider-backed APF creation before sandbox or provider effects (#9833)",
      apfInterceptorRequested: true,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "provider-refusal" as const,
    },
    {
      title: "rejects a nondefault agent before credential reads or sandbox inspection (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: { name: "hermes" },
      expectedOutcome: "unsupported-agent-refusal" as const,
    },
    {
      title:
        "rejects pre-resolved nondefault agent intent before credential reads or sandbox inspection (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "resolved-agent-refusal" as const,
    },
    {
      title:
        "registers providerless APF only after identity, policy, and checkpoint verification (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "providerless-apf" as const,
    },
    {
      title: "rejects mismatched selector and get identities before later effects (#10463)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "identity-mismatch-refusal" as const,
    },
    {
      title: "surfaces retained sandbox recovery through the public error message (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-authority-refusal" as const,
    },
    {
      title: "retains recovery state when the create runner fails after verification (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-runner-refusal" as const,
    },
    {
      title: "retains recovery state when registry publication fails after create (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-registration-refusal" as const,
    },
    {
      title: "blocks every reentry when registry-failure recovery has no durable journal (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-registration-recovery-readback-failure" as const,
    },
    {
      title: "retries registry-failure recovery from the process-exit owner (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-registration-recovery-retry" as const,
    },
    {
      title: "retains recovery state when final checks fail after registration (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "post-create-finalization-refusal" as const,
    },
    {
      title: "rejects staged messaging intent before any onboarding side effect (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "staged-messaging-refusal" as const,
    },
    {
      title: "makes a tier-cancelled created sandbox recovery-only (#9833)",
      apfInterceptorRequested: false,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "cancel-after-create-tier" as const,
    },
    {
      title: "makes a tier-preset-cancelled created sandbox recovery-only (#9833)",
      apfInterceptorRequested: false,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "cancel-after-create-tier-presets" as const,
    },
    {
      title: "makes a custom-preset-cancelled created sandbox recovery-only (#9833)",
      apfInterceptorRequested: false,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "cancel-after-create-custom-presets" as const,
    },
  ])(
    "$title",
    {
      timeout: 45000,
    },
    async ({ agent, apfInterceptorRequested, expectedOutcome, model, provider }) => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-ready-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "create-sandbox-ready-check.js");
      const payloadPath = path.join(tmpDir, "payload.json");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const recreateJournalPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "onboard-recreate-journal.ts"),
      );
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );
      const entryOptionsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "entry-options.ts"),
      );
      const retainedRecoveryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
      );
      const dockerExecPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "adapters", "docker", "exec.ts"),
      );
      const policyMergePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "policy", "merge.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
let _deleted = false;
const registry = require(${registryPath});
const recreateJournal = require(${recreateJournalPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const entryOptions = require(${entryOptionsPath});
const retainedRecovery = require(${retainedRecoveryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const dockerExec = require(${dockerExecPath});
dockerExec.dockerSpawn = () => {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("close", 0));
  return child;
};
const fs = require("node:fs");

const commands = [];
const lifecycleObservationCommands = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName: "my-assistant",
  sandboxId: "sbx-fresh-create",
  gatewayName: "nemoclaw-18080",
});
const mismatchedSandboxId = createdSandbox.state.sandboxId + "-mismatch";
let sandboxListCalls = 0;
let dockerPsCalls = 0;
let registeredSandbox = null;
let effectivePolicy = {};
let credentialReadCalls = 0;
let identityMismatchGetCalls = 0;
let policyVerificationCalls = 0;
let routeReservationCalls = 0;
const keepAlive = setInterval(() => {}, 1000);
const apfInterceptorRequested = ${JSON.stringify(apfInterceptorRequested)};
const agent = ${JSON.stringify(agent)};
const model = ${JSON.stringify(model)};
const provider = ${JSON.stringify(provider)};
const selectedChannels = ${JSON.stringify(expectedOutcome === "provider-refusal" ? ["telegram"] : null)};
const cancellationSelector = ${JSON.stringify(
        expectedOutcome.startsWith("cancel-after-create-")
          ? expectedOutcome.slice("cancel-after-create-".length)
          : null,
      )};
const cancelAfterCreate = cancellationSelector !== null;
const recoveryReentry = process.env.NEMOCLAW_RECOVERY_REENTRY || "";
const identityMismatchRefusal = ${JSON.stringify(
        expectedOutcome === "identity-mismatch-refusal",
      )};
const stagedMessagingRefusal = ${JSON.stringify(expectedOutcome === "staged-messaging-refusal")};
const postCreateAuthorityRefusal = ${JSON.stringify(
        expectedOutcome === "post-create-authority-refusal",
      )};
const postCreateRunnerRefusal = ${JSON.stringify(expectedOutcome === "post-create-runner-refusal")};
const postCreateRegistrationRefusal = ${JSON.stringify(
        expectedOutcome === "post-create-registration-refusal" ||
          expectedOutcome === "post-create-registration-recovery-readback-failure" ||
          expectedOutcome === "post-create-registration-recovery-retry",
      )};
let recoveryJournalReadbackFailuresRemaining = ${JSON.stringify(
        expectedOutcome === "post-create-registration-recovery-readback-failure"
          ? 100
          : expectedOutcome === "post-create-registration-recovery-retry" ||
              expectedOutcome === "post-create-runner-refusal"
            ? 1
            : 0,
      )};
const postCreateFinalizationRefusal = ${JSON.stringify(
        expectedOutcome === "post-create-finalization-refusal",
      )};
let cancelPrompt = false;
const originalGetCredential = credentials.getCredential;
credentials.getCredential = (...args) => {
  credentialReadCalls += 1;
  if (typeof args[0] !== "string") return null;
  return originalGetCredential(...args);
};
const originalReserveSandboxInferenceRoute = registry.reserveSandboxInferenceRoute;
registry.reserveSandboxInferenceRoute = (...args) => {
  routeReservationCalls += 1;
  return originalReserveSandboxInferenceRoute(...args);
};
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  _deleted = _deleted || cmd.includes("sandbox delete");
  commands.push({ command: cmd, env: opts.env || null });
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox delete") && createdSandbox.state.lifecycleState === "created") {
    createdSandbox.delete();
  }
  const sandboxResult = createdSandbox.run(command);
  return sandboxResult ?? { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:18080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) {
	    if (postCreateFinalizationRefusal && registeredSandbox) {
	      throw new Error("final onboarding policy check failed");
	    }
	    return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: effectivePolicy });
	  }
	  if (cmd.includes("sandbox get") || cmd.includes("sandbox list")) {
	    lifecycleObservationCommands.push(cmd);
	  }
  if (cmd.includes("sandbox list") && !cmd.includes("--selector")) {
    sandboxListCalls += 1;
    createdSandbox.setPhase(sandboxListCalls >= 2 ? "Ready" : "Pending");
  }
	  const sandboxCapture = createdSandbox.capture(command);
	  if (sandboxCapture !== null) {
    if (
      identityMismatchRefusal &&
      cmd.includes("sandbox get") &&
      sandboxCapture.includes("Id: " + createdSandbox.state.sandboxId)
    ) {
      identityMismatchGetCalls += 1;
      return sandboxCapture.replace(createdSandbox.state.sandboxId, mismatchedSandboxId);
    }
    return sandboxCapture;
  }
  if (cmd.startsWith("docker ps -a --no-trunc ")) {
    dockerPsCalls += 1;
    if (dockerPsCalls === 1) return "a".repeat(64);
  }
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
	const retainedRegistryEntry = recoveryReentry && fs.existsSync(${JSON.stringify(payloadPath)})
	  ? JSON.parse(fs.readFileSync(${JSON.stringify(payloadPath)}, "utf8")).currentRegistryEntry
	  : null;
	const registryMutationCalls = [];
  let checkpointReadCalls = 0;
	if (!recoveryReentry) {
	  const session = retainedRecovery.createSession({
	    sessionId: "session-owner",
	    sandboxName: "my-assistant",
	    agent: agent?.name ?? "openclaw",
	  });
	  retainedRecovery.saveSession(session);
	  registry.save({
	    defaultSandbox: null,
	    sandboxes: {
	      "my-assistant": {
	        name: "my-assistant",
	        gatewayName: "nemoclaw-18080",
	        gatewayPort: 18080,
	        provider,
	        model,
	        endpointUrl: null,
	        endpointSource: null,
	        credentialEnv: null,
	        preferredInferenceApi: null,
	        pendingRouteReservation: true,
	        reservationSessionId: "session-owner",
	      },
	    },
	  });
	  recreateJournal.openOnboardRecreateJournal({
	    target: {
	      sandboxName: "my-assistant",
	      gatewayName: "nemoclaw-18080",
	      gatewayPort: 18080,
	    },
	    agentName: agent?.name ?? "openclaw",
	    note: () => {},
	    observe: () => ({ state: "missing", liveIdentityFingerprint: null }),
	    intent: {
	      agent: agent?.name ?? "openclaw",
	      fromDockerfile: null,
	      provider,
	      model,
	      preferredInferenceApi: null,
	      sandboxGpuConfig: null,
	      gatewayName: "nemoclaw-18080",
	      gatewayPort: 18080,
	      toolDisclosure: "progressive",
	      dcodeAutoApprovalMode: null,
	      observabilityEnabled: false,
	      policyTier: null,
	    },
	  });
	}
	const durableGetSandbox = registry.getSandbox.bind(registry);
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  gatewayName: "nemoclaw-18080",
	  gatewayPort: 18080,
	  provider,
	  model,
	  sessionId: "session-owner",
	  apfInterceptorRequested,
	  getSandbox: (name) => retainedRegistryEntry ?? durableGetSandbox(name),
	  onVerifyCreatedPolicy: (input) => {
	    policyVerificationCalls += 1;
	    if (postCreateAuthorityRefusal) {
	      throw new Error("external policy authority changed");
	    }
	    effectivePolicy = require(${policyMergePath}).parseOpenShellPolicy(
	      fs.readFileSync(input.policySourcePath, "utf8"),
	    ).policy;
	  },
	  registerSandbox: (entry) => {
	    if (postCreateRegistrationRefusal) {
	      throw new Error("registry publication failed");
	    }
	    registeredSandbox = entry;
	    registryMutationCalls.push({ operation: "register", name: entry.name });
	  },
	  updateSandbox: (name) => { registryMutationCalls.push({ operation: "update", name }); },
	  setDefault: (name) => { registryMutationCalls.push({ operation: "set-default", name }); },
	  removeSandbox: (name) => { registryMutationCalls.push({ operation: "remove", name }); },
	});
if (postCreateRunnerRefusal) {
  const requireCurrentCheckpoint = registry.requireCurrentPendingSandboxPolicyVerification;
  registry.requireCurrentPendingSandboxPolicyVerification = (...args) => {
    checkpointReadCalls += 1;
    if (checkpointReadCalls === 6) {
      throw new Error("post-verification create runner checkpoint failed");
    }
    return requireCurrentCheckpoint(...args);
  };
}
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => {
  if (cancelPrompt) {
    throw Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
  }
  return "";
};

const groupKillCalls = [];
const realProcessKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0) {
    groupKillCalls.push({ pid, signal });
    const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
    process.nextTick(() => createCommand.child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  }
  return realProcessKill(pid, signal);
};

childProcess.spawn = (...args) => {
  const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
  createdSandbox.create(command);
  if (_n(command).includes("sandbox create")) _deleted = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  child.killCalls = [];
  child.unrefCalls = 0;
  child.stdout.destroyCalls = 0;
  child.stderr.destroyCalls = 0;
  child.stdout.destroy = () => {
    child.stdout.destroyCalls += 1;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyCalls += 1;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    process.nextTick(() => child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  };
  commands.push({ command: _n(command), env: args[2]?.env || null, child });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.stderr.emit("data", Buffer.from("Setting up NemoClaw...\n"));
  });
  return child;
};

const onboardModule = require(${onboardPath});
const { createSandbox } = onboardModule;
if (recoveryJournalReadbackFailuresRemaining > 0) {
  const renameSync = fs.renameSync.bind(fs);
  fs.renameSync = (source, destination) => {
    renameSync(source, destination);
    if (
      recoveryJournalReadbackFailuresRemaining > 0 &&
      String(destination).endsWith("retained-sandbox-recovery.json")
    ) {
      recoveryJournalReadbackFailuresRemaining -= 1;
      fs.writeFileSync(
        destination,
        JSON.stringify({ schemaVersion: 1, unresolved: [], resolutions: [] }),
      );
    }
  };
}
if (cancelAfterCreate && !recoveryReentry) {
  const session = onboardModule.onboardSession.loadSession();
  if (!session) throw new Error("missing seeded onboarding session");
  session.mode = "interactive";
  session.sandboxName = "my-assistant";
  session.metadata = { gatewayName: "nemoclaw-18080", fromDockerfile: null };
  onboardModule.onboardSession.saveSession(session);
  onboardModule.registerIncompleteOnboardExitHandlerForSession(
    onboardModule.onboardSession,
    () => false,
  );
}

const writePayload = (sandboxName, creationError, exitCode = 0) => {
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    creationError,
    exitCode,
    deleted: _deleted,
    sandboxCreated: createdSandbox.state.lifecycleState === "created",
    sandboxId: createdSandbox.state.sandboxId,
    sandboxListCalls,
    killCalls: createCommand?.child?.killCalls ?? [],
    groupKillCalls,
    unrefCalls: createCommand?.child?.unrefCalls ?? 0,
    stdoutDestroyCalls: createCommand?.child?.stdout.destroyCalls ?? 0,
    stderrDestroyCalls: createCommand?.child?.stderr.destroyCalls ?? 0,
    lifecycleObservationCommands,
    registeredSandbox,
    credentialReadCalls,
    identityMismatchGetCalls,
    mismatchedSandboxId,
    policyVerificationCalls,
    routeReservationCalls,
    checkpointReadCalls,
    registryMutationCalls,
    currentRegistryEntry: cancelAfterCreate ? registry.getSandbox("my-assistant") : null,
    recoveryRegistryEntry: registry.getSandbox("my-assistant"),
    savedSession:
      cancelAfterCreate ||
      postCreateAuthorityRefusal ||
      postCreateRunnerRefusal ||
      postCreateRegistrationRefusal ||
      postCreateFinalizationRefusal
        ? onboardModule.onboardSession.loadSession()
        : null,
    retainedRecoveryRecords: retainedRecovery.listRetainedSandboxRecoveryRecords(),
    createCommand: createCommand?.command ?? null,
    commandNames: commands.map((entry) => entry.command),
  }));
};
let finalCreationError = null;
if (${JSON.stringify(
        expectedOutcome === "post-create-registration-recovery-retry" ||
          expectedOutcome === "post-create-runner-refusal",
      )}) {
  process.on("exit", (code) => writePayload(null, finalCreationError, code));
}

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw-18080";
	  if (recoveryReentry) {
	    if (recoveryReentry === "fresh-different-no-journal") {
	      try {
	        await onboardModule.onboard({
	          fresh: true,
	          sandboxName: "replacement-sb",
	          deferProcessExit: true,
	        });
	        writePayload(null, "recovery-only onboarding unexpectedly continued", 0);
	      } catch (error) {
	        writePayload(
	          null,
	          error instanceof Error ? error.message : String(error),
	          typeof error?.code === "number" ? error.code : 1,
	        );
	      }
	      clearInterval(keepAlive);
	      return;
	    }
	    if (recoveryReentry === "fresh-different") {
	      const retainedNames = retainedRecovery
	        .listRetainedSandboxRecoveryRecords()
	        .map((record) => record.sandboxName);
	      const resolved = entryOptions.resolveDefaultRunEntryOptions(
	        { fresh: true, sandboxName: "replacement-sb" },
	        onboardModule.onboardSession.loadSession(),
	        runner.validateName,
	        process.env,
	        retainedNames,
	      );
	      onboardModule.onboardSession.clearSession();
	      onboardModule.onboardSession.saveSession(
	        onboardModule.onboardSession.createSession({
	          mode: resolved.nonInteractive ? "non-interactive" : "interactive",
	          sandboxName: resolved.requestedSandboxName,
	          metadata: { gatewayName: "nemoclaw-18080", fromDockerfile: null },
	        }),
	      );
	      writePayload("replacement-sb", null, 0);
	      clearInterval(keepAlive);
	      return;
	    }
	    try {
	      await onboardModule.onboard({
	        resume: recoveryReentry === "explicit",
	        fresh: recoveryReentry === "fresh-same",
	        recreateSandbox: recoveryReentry === "recreate",
	        sandboxName: "my-assistant",
	        deferProcessExit: true,
	      });
	      writePayload(null, "recovery-only onboarding unexpectedly continued", 0);
	    } catch (error) {
	      writePayload(
	        null,
	        error instanceof Error ? error.message : String(error),
	        typeof error?.code === "number" ? error.code : 1,
	      );
	    }
	    clearInterval(keepAlive);
	    return;
	  }
	  const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, model, provider, null, null, null, selectedChannels, null, agent, null, null, null, []],
	    createFixture,
	  );
	  createArgs[15] = {
	    ...createArgs[15],
	    ...(apfInterceptorRequested
	      ? {
	          apfInterceptorRequested: true,
	          deferSandboxEffectsUntilPolicyVerification: true,
	        }
	      : {}),
	    recreate: false,
	    toolDisclosure: "progressive",
	    observabilityEnabled: false,
	    ...(${JSON.stringify(expectedOutcome === "resolved-agent-refusal")}
	      ? {
	          resolved: {
	            policy: { options: { agentName: "hermes" } },
	          },
	        }
	      : {}),
	  };
	  try {
	    const sandboxName = await createSandbox(...createArgs);
	    if (cancelAfterCreate) {
	      process.on("exit", (code) => writePayload(sandboxName, null, code));
	      cancelPrompt = true;
	      if (cancellationSelector === "tier") {
	        await onboardModule.selectPolicyTier();
	      } else if (cancellationSelector === "tier-presets") {
	        await onboardModule.selectTierPresetsAndAccess(
	          "balanced",
	          [{ name: "github", description: "GitHub" }],
	          ["github"],
	        );
	      } else {
	        await onboardModule.presetsCheckboxSelector(
	          [{ name: "github", description: "GitHub" }],
	          ["github"],
	        );
	      }
	      throw new Error("expected policy selection cancellation");
	    }
	    writePayload(sandboxName, null);
	  } catch (error) {
	    if (cancelAfterCreate) throw error;
	    if (!apfInterceptorRequested) throw error;
	    finalCreationError = error instanceof Error ? error.message : String(error);
    writePayload(null, finalCreationError);
	  }
  clearInterval(keepAlive);
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const childEnv = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: expectedOutcome.startsWith("cancel-after-create-") ? "" : "1",
        NEMOCLAW_GATEWAY_PORT: "18080",
        OPENSHELL_DRIVERS: "docker",
        NEMOCLAW_MESSAGING_PLAN_B64:
          expectedOutcome === "staged-messaging-refusal"
            ? encodeMessagingPlan(
                makeMessagingPlan({ sandboxName: "my-assistant", channels: ["telegram"] }),
              )
            : "",
      };
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: childEnv,
        timeout: 30000,
      });

      const cancellationOutcome = expectedOutcome.startsWith("cancel-after-create-");
      assert.equal(result.status, cancellationOutcome ? 1 : 0, result.stderr);
      assert.ok(fs.existsSync(payloadPath), result.stderr);
      const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
      const providerEffectCommands = payload.commandNames.filter((command: string) =>
        /(?:^|\s)provider (?:create|update|delete|profile import)\b|(?:^|\s)sandbox provider (?:attach|detach)\b/u.test(
          command,
        ),
      );
      const providerExposureCommands = payload.commandNames.filter((command: string) =>
        /(?:^|\s)provider (?:create|update|profile import)\b|(?:^|\s)sandbox provider attach\b/u.test(
          command,
        ),
      );
      const identityFingerprint = createHash("sha256").update(payload.sandboxId).digest("hex");
      const assertRecoveryTuple = (record: Record<string, unknown>) => {
        assert.equal(record.gatewayName, "nemoclaw-18080");
        assert.equal(record.gatewayPort, 18080);
        assert.equal(record.sandboxIdentityFingerprint, identityFingerprint);
        assert.equal(record.lifecycleGeneration, payload.recoveryRegistryEntry.lifecycleGeneration);
        assert.deepEqual(record.verifiedEffectivePolicyIdentity, {
          hash: "fixture-policy",
          activeVersion: 1,
        });
      };
      const assertProviderBackedApfRefusal = () => {
        assert.match(
          payload.creationError,
          /supports providerless sandbox creation only.*No sandbox or provider was created/u,
        );
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, false);
        assert.equal(payload.createCommand, null);
        assert.equal(payload.registeredSandbox, null);
        assert.equal(payload.credentialReadCalls, 0);
        assert.equal(payload.routeReservationCalls, 0);
        assert.deepEqual(payload.registryMutationCalls, []);
        assert.deepEqual(providerEffectCommands, []);
        assert.equal(
          payload.commandNames.some((command: string) => command.includes("sandbox create")),
          false,
        );
      };
      const assertUnsupportedAgentRefusal = () => {
        assertProviderBackedApfRefusal();
        assert.deepEqual(payload.commandNames, []);
        assert.equal(payload.sandboxListCalls, 0);
      };
      const assertStagedMessagingRefusal = () => {
        assert.match(
          payload.creationError,
          /supports providerless sandbox creation only.*No sandbox or provider was created/u,
        );
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, false);
        assert.equal(payload.createCommand, null);
        assert.equal(payload.registeredSandbox, null);
        assert.equal(payload.credentialReadCalls, 0);
        assert.equal(payload.routeReservationCalls, 0);
        assert.deepEqual(providerEffectCommands, []);
        assert.equal(
          payload.commandNames.some((command: string) =>
            /(?:^|\s)(?:docker build|policy (?:set|apply)|sandbox create)(?:\s|$)/u.test(command),
          ),
          false,
        );
      };
      const assertSuccessfulCreation = () => {
        assert.equal(payload.creationError, null, result.stderr);
        assert.equal(payload.sandboxName, "my-assistant");
        assert.ok(payload.sandboxListCalls >= 2);
        assert.deepEqual(payload.groupKillCalls, [{ pid: -4242, signal: "SIGTERM" }]);
        assert.deepEqual(payload.killCalls, []);
        assert.equal(payload.unrefCalls, 0);
        assert.equal(payload.stdoutDestroyCalls, 0);
        assert.equal(payload.stderrDestroyCalls, 0);
        assert.equal(payload.registeredSandbox.workload.kind, "managed-image");
        assert.match(payload.registeredSandbox.lifecycleGeneration, /^[0-9a-f-]{36}$/u);
        assert.equal(
          payload.registeredSandbox.lifecycleLiveIdentityFingerprint,
          createHash("sha256").update(payload.sandboxId).digest("hex"),
        );
        assert.match(
          payload.createCommand,
          /--label ai\.nvidia\.nemoclaw\.create-attempt=[0-9a-f]{62}/u,
        );
        const ownerScopedObservations = payload.lifecycleObservationCommands.filter(
          (command: string) => command.includes("-g nemoclaw-18080"),
        );
        assert.ok(
          ownerScopedObservations.length >= 6,
          "expected owner-scoped sandbox identity observations",
        );
        assert.ok(
          ownerScopedObservations.every(
            (command: string) =>
              command.includes("sandbox get -g nemoclaw-18080 my-assistant") ||
              command.includes("sandbox list -g nemoclaw-18080"),
          ),
          `fresh identity observations must remain scoped to the owning gateway: ${JSON.stringify(ownerScopedObservations)}`,
        );
      };
      const assertManagedProviderCreation = () => {
        assertSuccessfulCreation();
        assert.equal(payload.registeredSandbox.policyAuthority, "nemoclaw-managed");
        assert.ok(payload.registeredSandbox.policyCreationReceipt);
        assert.match(payload.createCommand, /--policy \S+/u);
        assert.match(payload.createCommand, /--provider nvidia-prod/u);
      };
      const assertProviderlessApfCreation = () => {
        assertSuccessfulCreation();
        assert.equal(payload.registeredSandbox.policyAuthority, "externally-managed");
        assert.equal(payload.registeredSandbox.policyCreationReceipt, undefined);
        assert.deepEqual(payload.registeredSandbox.appliedPolicies ?? [], []);
        assert.doesNotMatch(payload.createCommand, /(?:^|\s)--policy(?:=|\s)/u);
        assert.doesNotMatch(payload.createCommand, /(?:^|\s)--provider(?:\s|$)/u);
        assert.equal(payload.credentialReadCalls, 0);
        assert.deepEqual(providerExposureCommands, []);
        const createIndex = payload.commandNames.findIndex((command: string) =>
          command.includes("sandbox create"),
        );
        const deferredEffectIndexes = payload.commandNames
          .map((command: string, index: number) => ({ command, index }))
          .filter(({ command }: { command: string }) =>
            /provider (?:profile import|create)|sandbox provider attach/u.test(command),
          )
          .map(({ index }: { index: number }) => index);
        assert.ok(deferredEffectIndexes.every((index: number) => index > createIndex));
      };
      const assertIdentityMismatchRefusal = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.match(payload.creationError, /automatic sandbox cleanup was not safe/u);
        assert.notEqual(payload.mismatchedSandboxId, payload.sandboxId);
        assert.ok(payload.identityMismatchGetCalls >= 1);
        assert.equal(payload.policyVerificationCalls, 0);
        assert.equal(payload.registeredSandbox, null);
        assert.equal(payload.credentialReadCalls, 0);
        assert.deepEqual(payload.registryMutationCalls, [
          { operation: "update", name: "my-assistant" },
        ]);
        assert.deepEqual(providerEffectCommands, []);
        assert.equal(
          payload.commandNames.some((command: string) =>
            /(?:^|\s)policy (?:set|apply)(?:\s|$)/u.test(command),
          ),
          false,
        );
      };
      const assertPostCreateAuthorityRefusal = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.match(payload.creationError, /left sandbox 'my-assistant' in place/u);
        assert.match(payload.creationError, new RegExp(identityFingerprint, "u"));
        assert.match(
          payload.creationError,
          /did not run OpenShell's mutable-name deletion command because the name may now identify a replacement sandbox/u,
        );
        assert.match(payload.creationError, /Do not delete the sandbox by mutable sandbox name/u);
        assert.match(
          payload.creationError,
          /Ask the OpenShell administrator.*identity-bound recovery or removal procedure/u,
        );
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(
          payload.savedSession.cancellationRecovery.reason,
          "retained_after_sandbox_creation_failure",
        );
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(payload.retainedRecoveryRecords.length, 1);
        const record = payload.retainedRecoveryRecords[0];
        assert.equal(record.sandboxName, "my-assistant");
        assert.equal(record.sandboxIdentityFingerprint, identityFingerprint);
        assert.equal(record.identityWasUnavailable, false);
        assert.equal(record.gatewayName, "nemoclaw-18080");
        assert.equal(record.gatewayPort, 18080);
        assert.match(record.lifecycleGeneration, /^[0-9a-f-]{36}$/u);
        assert.equal(record.verifiedEffectivePolicyIdentity, null);
        assert.equal(record.reason, "retained_after_sandbox_creation_failure");
      };
      const assertPostCreateRunnerRefusal = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox, null);
        assert.match(payload.creationError, /automatic sandbox cleanup was not safe/u);
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(payload.retainedRecoveryRecords.length, 1);
        assert.equal(payload.retainedRecoveryRecords[0].sandboxName, "my-assistant");
        assertRecoveryTuple(payload.retainedRecoveryRecords[0]);
        assert.ok(payload.checkpointReadCalls >= 6);
        assert.equal(
          payload.commandNames.filter((command: string) => command.includes("sandbox create"))
            .length,
          1,
        );
      };
      const assertPostCreateRegistrationRefusal = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox, null);
        assert.match(payload.creationError, /registry publication failed/u);
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(payload.retainedRecoveryRecords.length, 1);
        const record = payload.retainedRecoveryRecords[0];
        assert.equal(record.sandboxName, "my-assistant");
        assert.equal(record.identityWasUnavailable, false);
        assert.equal(record.reason, "retained_after_sandbox_creation_failure");
        assertRecoveryTuple(record);
      };
      const assertPostCreateRegistrationRecoveryReadbackFailure = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox, null);
        assert.match(payload.creationError, /recovery record could not be persisted/u);
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assert.deepEqual(payload.retainedRecoveryRecords, []);

        const reentryCases = [
          {
            mode: "fresh-different-no-journal",
            message: /independent retained sandbox recovery record is unavailable/u,
          },
          {
            mode: "fresh-same",
            message: /explicit sandbox name different from the retained sandbox/u,
          },
        ] as const;
        for (const { message, mode } of reentryCases) {
          const reentry = spawnSync(process.execPath, [scriptPath], {
            cwd: repoRoot,
            encoding: "utf-8",
            env: {
              ...childEnv,
              NEMOCLAW_RECOVERY_REENTRY: mode,
            },
            timeout: 30000,
          });
          assert.equal(reentry.status, 0, reentry.stderr);
          const reentryPayload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
          assert.equal(reentryPayload.exitCode, 1);
          assert.match(reentry.stderr, message);
          assert.deepEqual(reentryPayload.commandNames, []);
          assert.equal(reentryPayload.credentialReadCalls, 0);
          assert.equal(reentryPayload.routeReservationCalls, 0);
          assert.deepEqual(reentryPayload.registryMutationCalls, []);
          assert.equal(reentryPayload.savedSession.sandboxName, "my-assistant");
          assert.deepEqual(reentryPayload.retainedRecoveryRecords, []);
        }
      };
      const assertPostCreateRegistrationRecoveryRetry = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox, null);
        assert.match(payload.creationError, /recovery record could not be persisted/u);
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(payload.retainedRecoveryRecords.length, 1);
        assert.equal(payload.retainedRecoveryRecords[0].sandboxName, "my-assistant");
        assertRecoveryTuple(payload.retainedRecoveryRecords[0]);
        assert.equal(
          payload.commandNames.filter((command: string) => command.includes("sandbox create"))
            .length,
          1,
        );
      };
      const assertPostCreateFinalizationRefusal = () => {
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, true);
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox.name, "my-assistant");
        assert.match(
          payload.creationError,
          /OpenShell sandbox policy authority inspection failed/u,
        );
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assertRecoveryTuple(payload.retainedRecoveryRecords[0]);
      };
      const assertCancellationRecovery = () => {
        assert.equal(payload.exitCode, 1);
        assert.equal(payload.sandboxName, "my-assistant");
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox.name, "my-assistant");
        assert.equal(
          payload.currentRegistryEntry.lifecycleLiveIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(payload.currentRegistryEntry.name, "my-assistant");
        assert.equal(payload.savedSession.status, "recovery_required");
        assert.equal(payload.savedSession.resumable, false);
        assert.equal(payload.savedSession.sandboxName, "my-assistant");
        assert.equal(
          payload.savedSession.cancellationRecovery.reason,
          "cancelled_after_sandbox_creation",
        );
        assert.equal(payload.savedSession.cancellationRecovery.sandboxName, "my-assistant");
        assert.equal(
          payload.savedSession.cancellationRecovery.sandboxIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(
          payload.commandNames.some((command: string) => command.includes("sandbox delete")),
          false,
        );
        assertRecoveryTuple(payload.retainedRecoveryRecords[0]);
        assert.match(result.stderr, /preserved incomplete sandbox 'my-assistant'/u);
        assert.match(result.stderr, new RegExp(identityFingerprint, "u"));
        assert.match(result.stderr, /Do not delete the sandbox by mutable sandbox name/u);
        assert.match(result.stderr, /Shared inference providers are gateway configuration/u);
        assert.match(result.stderr, /not sandbox cleanup targets/u);
        assert.match(result.stderr, /sandbox-scoped resources whose ownership is confirmed/u);
        assert.match(result.stderr, /no supported operation to clear this recovery record/u);
        assert.match(result.stderr, /credential environment name alone does not prove exposure/u);
        assert.match(
          result.stderr,
          /rotate a credential only when identity-bound inspection proves/u,
        );
        assert.doesNotMatch(result.stderr, /rotate any credential/u);

        const differentName = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...childEnv,
            NEMOCLAW_RECOVERY_REENTRY: "fresh-different",
          },
          timeout: 30000,
        });
        assert.equal(differentName.status, 0, differentName.stderr);
        const differentNamePayload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
        assert.equal(differentNamePayload.exitCode, 0);
        assert.equal(differentNamePayload.savedSession.sandboxName, "replacement-sb");
        assert.deepEqual(
          differentNamePayload.retainedRecoveryRecords,
          payload.retainedRecoveryRecords,
        );
        assert.deepEqual(differentNamePayload.commandNames, []);
        assert.equal(differentNamePayload.credentialReadCalls, 0);
        assert.equal(differentNamePayload.routeReservationCalls, 0);
        assert.deepEqual(differentNamePayload.registryMutationCalls, []);

        const reentryCases = [
          {
            mode: "automatic",
            messages: [
              /cannot use retained sandbox 'my-assistant'/u,
              /same-name fresh onboarding remain disabled/u,
            ],
          },
          {
            mode: "explicit",
            messages: [
              /cannot use retained sandbox 'my-assistant'/u,
              /same-name fresh onboarding remain disabled/u,
            ],
          },
          {
            mode: "recreate",
            messages: [
              /cannot use retained sandbox 'my-assistant'/u,
              /same-name fresh onboarding remain disabled/u,
            ],
          },
          {
            mode: "fresh-same",
            messages: [
              /cannot use retained sandbox 'my-assistant'/u,
              /same-name fresh onboarding remain disabled/u,
            ],
          },
        ] as const;
        for (const { messages, mode: reentryMode } of reentryCases) {
          const reentry = spawnSync(process.execPath, [scriptPath], {
            cwd: repoRoot,
            encoding: "utf-8",
            env: {
              ...childEnv,
              NEMOCLAW_RECOVERY_REENTRY: reentryMode,
            },
            timeout: 30000,
          });
          assert.equal(reentry.status, 0, reentry.stderr);
          const reentryPayload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
          assert.equal(reentryPayload.exitCode, 1);
          messages.forEach((message) => assert.match(reentry.stderr, message));
          assert.deepEqual(reentryPayload.commandNames, []);
          assert.equal(reentryPayload.credentialReadCalls, 0);
          assert.equal(reentryPayload.routeReservationCalls, 0);
          assert.deepEqual(reentryPayload.registryMutationCalls, []);
          assert.deepEqual(reentryPayload.currentRegistryEntry, payload.currentRegistryEntry);
          assert.deepEqual(reentryPayload.savedSession, differentNamePayload.savedSession);
          assert.deepEqual(reentryPayload.retainedRecoveryRecords, payload.retainedRecoveryRecords);
        }
      };
      const assertions = {
        "managed-provider": assertManagedProviderCreation,
        "provider-refusal": assertProviderBackedApfRefusal,
        "unsupported-agent-refusal": assertUnsupportedAgentRefusal,
        "resolved-agent-refusal": assertUnsupportedAgentRefusal,
        "providerless-apf": assertProviderlessApfCreation,
        "identity-mismatch-refusal": assertIdentityMismatchRefusal,
        "post-create-authority-refusal": assertPostCreateAuthorityRefusal,
        "post-create-runner-refusal": assertPostCreateRunnerRefusal,
        "post-create-registration-refusal": assertPostCreateRegistrationRefusal,
        "post-create-registration-recovery-readback-failure":
          assertPostCreateRegistrationRecoveryReadbackFailure,
        "post-create-registration-recovery-retry": assertPostCreateRegistrationRecoveryRetry,
        "post-create-finalization-refusal": assertPostCreateFinalizationRefusal,
        "staged-messaging-refusal": assertStagedMessagingRefusal,
        "cancel-after-create-tier": assertCancellationRecovery,
        "cancel-after-create-tier-presets": assertCancellationRecovery,
        "cancel-after-create-custom-presets": assertCancellationRecovery,
      };
      assertions[expectedOutcome]();
    },
  );
});
