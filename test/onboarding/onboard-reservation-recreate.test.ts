// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import {
  createOnboardProcessWorkspace,
  runOnboardProcess,
  trailingJsonPayload,
  workspaceEnv,
} from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

const repoRoot = path.join(import.meta.dirname, "../..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard sandbox recreate reservation safety", () => {
  it.each([
    {
      name: "preserves a current-session pending route reservation across a not-ready recreate",
      reservationSessionId: "session-owner",
      expectedRemoval: false,
      replaceBeforeCleanup: false,
      expectedRetainedReservation: {
        name: "my-assistant",
        gpuEnabled: false,
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      },
    },
    {
      name: "removes a foreign-session pending route reservation before a not-ready recreate",
      reservationSessionId: "session-other",
      expectedRemoval: true,
      replaceBeforeCleanup: false,
      expectedRetainedReservation: null,
    },
    {
      name: "removes an unstamped pending route reservation before a not-ready recreate",
      reservationSessionId: null,
      expectedRemoval: true,
      replaceBeforeCleanup: false,
      expectedRetainedReservation: null,
    },
    {
      name: "preserves a replacement written after stale reservation classification",
      reservationSessionId: "session-other",
      expectedRemoval: false,
      replaceBeforeCleanup: true,
      expectedRetainedReservation: {
        name: "my-assistant",
        gpuEnabled: false,
        pendingRouteReservation: true,
        reservationSessionId: "session-replacement",
        model: "replacement-model",
      },
    },
  ] as const)(
    "$name (#6562)",
    { timeout: 60_000 },
    async ({
      reservationSessionId,
      expectedRemoval,
      replaceBeforeCleanup,
      expectedRetainedReservation,
    }) => {
      const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-reservation-survives-");
      onTestFinished(() => workspace.remove());
      const scriptPath = workspace.path("reservation-survives.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const onboardSessionPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
      );

      writeOkOpenshell(workspace.binDir);

      const script = String.raw`
const runner = require(${runnerPath});
require(${onboardScriptMocksPath}).mockStandaloneGatewayTeardownAuthority();
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const onboardSession = require(${onboardSessionPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
let sandboxDeleted = false;
let sandboxRecreated = false;
runner.run = (command) => {
  const cmd = _n(command);
  events.push({ kind: "run", cmd });
  const profileResult = require(${onboardScriptMocksPath}).mockManagedEndpointlessProviderProfileRun(command);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox list")) return { status: 0, stdout: "No sandboxes found." };
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: "No sandboxes found.\n" };
  }
  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
    ? { status: 0, stdout: Buffer.from("Name: my-assistant\nId: " + fixtureMocks.ONBOARD_CREATED_SANDBOX_ID + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command);
  if (createdIdentity !== null) return createdIdentity;
  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return sandboxRecreated ? ["my-assistant", "Id: " + fixtureMocks.ONBOARD_CREATED_SANDBOX_ID].join(String.fromCharCode(10)) : sandboxDeleted ? "" : ["my-assistant", "Id: " + fixtureMocks.ONBOARD_CREATED_SANDBOX_ID].join(String.fromCharCode(10));
  if (cmd.includes("sandbox list")) {
    return sandboxRecreated ? "my-assistant Ready" : sandboxDeleted ? "" : "my-assistant NotReady";
  }
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();

onboardSession.saveSession(onboardSession.createSession({
  sessionId: "session-owner",
  sandboxName: "my-assistant",
  agent: "openclaw",
}));

const reservationSessionId = ${JSON.stringify(reservationSessionId)};
const initialSourceEntry = {
  name: "my-assistant",
  gpuEnabled: false,
  pendingRouteReservation: true,
  ...(reservationSessionId === null ? {} : { reservationSessionId }),
};
registry.save({ defaultSandbox: null, sandboxes: { "my-assistant": initialSourceEntry } });
let sourceEntry = registry.getSandbox("my-assistant");
if (!sourceEntry) throw new Error("failed to seed the stale route reservation");
const removeReservationIfCurrent = registry.removeSandboxRouteReservationIfCurrent;
registry.removeSandboxRouteReservationIfCurrent = (expected) => {
  if (${JSON.stringify(replaceBeforeCleanup)}) {
    const data = registry.load();
    data.sandboxes[expected.name] = {
      ...expected,
      reservationSessionId: "session-replacement",
      model: "replacement-model",
    };
    registry.save(data);
    events.push({ kind: "replacementWritten", name: expected.name });
  }
  const removed = removeReservationIfCurrent(expected);
  events.push({ kind: "removeReservation", name: expected.name, removed });
  return removed;
};
registry.getSandbox = () => sourceEntry;
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
const removeSandbox = (name) => {
  events.push({ kind: "removeSandbox", name });
  sourceEntry = null;
  return true;
};
registry.removeSandbox = removeSandbox;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  sessionId: "session-owner",
  getSandbox: registry.getSandbox,
  removeSandbox,
  sourceSandboxId: fixtureMocks.ONBOARD_CREATED_SANDBOX_ID,
});

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });
const policyAuthorityPreflight = require(${JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "policy-authority", "preflight.ts"),
      )});
policyAuthorityPreflight.qualifySandboxPolicyAuthority = () => ({
  authority: "nemoclaw-managed",
});

childProcess.spawn = (...args) => {
  sandboxRecreated = true;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4246;
  events.push({ kind: "spawn", cmd: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]) });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  const lock = onboardSession.acquireOnboardLock("integration recreate reservation cleanup");
  if (!lock.acquired) throw new Error("failed to acquire the real onboarding writer lock");
  try {
    const sandboxName = await createSandbox(
      ...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
        [
          null,
          "gpt-5.4",
          "nvidia-prod",
          null,
          "my-assistant",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          [],
        ],
        createFixture,
      ),
    );
    console.log(JSON.stringify({
      sandboxName,
      events,
      retainedReservation: registry.load().sandboxes["my-assistant"] || null,
    }));
  } finally {
    onboardSession.releaseOnboardLock();
  }
})().catch((error) => {
  console.log(JSON.stringify({
    sandboxName: null,
    error: error instanceof Error ? error.message : String(error),
    events,
    retainedReservation: registry.load().sandboxes["my-assistant"] || null,
  }));
  process.exitCode = 1;
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = runOnboardProcess([scriptPath], {
        env: workspaceEnv(workspace, {
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
          NEMOCLAW_SANDBOX_PREBUILD: "1",
        }),
        timeoutMs: 30_000,
      });

      assert.equal(
        result.status,
        replaceBeforeCleanup ? 1 : 0,
        result.stderr ||
          result.error?.message ||
          "onboarding subprocess returned an unexpected status",
      );
      const payload = trailingJsonPayload<{
        sandboxName: string | null;
        error?: string;
        events: Array<{ kind: string; cmd?: string; name?: string; removed?: boolean }>;
        retainedReservation: { reservationSessionId?: string; model?: string } | null;
      }>(result.stdout);
      assert.equal(payload.sandboxName, replaceBeforeCleanup ? null : "my-assistant");
      assert.match(
        payload.error ?? "completed",
        replaceBeforeCleanup
          ? /pending create recovery state.*--resume.*only when that session retains authority/u
          : /^completed$/u,
      );

      const events = payload.events;
      const removedReservation = events.some(
        (e) => e.kind === "removeReservation" && e.name === "my-assistant" && e.removed === true,
      );
      assert.equal(
        removedReservation,
        expectedRemoval,
        expectedRemoval
          ? "must delete abandoned pending route reservations during recreate"
          : "must not delete the current session's pending route reservation during recreate",
      );
      assert.ok(
        events.some((e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete")),
        "should still delete the not-ready gateway sandbox before rebuilding",
      );
      assert.equal(
        events.some(
          (event) => event.kind === "spawn" && (event.cmd ?? "").includes("sandbox create"),
        ),
        !replaceBeforeCleanup,
        "must refuse before creating after the reservation snapshot changes",
      );
      assert.deepEqual(payload.retainedReservation, expectedRetainedReservation);
    },
  );

  it.each([
    { scenario: "same-session", resumes: true },
    { scenario: "foreign-reservation", resumes: false },
    { scenario: "changed-checkpoint", resumes: false },
  ] as const)(
    "recovers a verified create in a new process for $scenario authority (#9833)",
    { timeout: 90_000 },
    async ({ scenario, resumes }) => {
      const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-verified-create-resume-");
      onTestFinished(() => workspace.remove());
      const scriptPath = workspace.path("verified-create-resume.js");
      const createCountPath = workspace.path("sandbox-create-count.txt");
      const effectCountPath = workspace.path("deferred-effect-count.txt");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const onboardSessionPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
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
      const dockerExecPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "adapters", "docker", "exec.ts"),
      );

      writeOkOpenshell(workspace.binDir);

      const script = String.raw`
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const runner = require(${runnerPath});
const fixtureMocks = require(${onboardScriptMocksPath});
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const registry = require(${registryPath});
const onboardSession = require(${onboardSessionPath});
const recreateJournal = require(${recreateJournalPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const dockerExec = require(${dockerExecPath});
const mode = process.argv[2];
const scenario = process.argv[3];
const createCountPath = ${JSON.stringify(createCountPath)};
const effectCountPath = ${JSON.stringify(effectCountPath)};
const normalize = (command) => (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
const keepAlive = setInterval(() => {}, 1000);

process.env.OPENSHELL_GATEWAY = "nemoclaw";
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
dockerExec.dockerSpawn = () => {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("close", 0));
  return child;
};

if (mode === "seed") {
  onboardSession.saveSession(onboardSession.createSession({
    sessionId: "session-owner",
    sandboxName: "my-assistant",
    agent: "openclaw",
  }));
  registry.save({
    defaultSandbox: null,
    sandboxes: {
      "my-assistant": {
        name: "my-assistant",
        gatewayName: "nemoclaw",
        provider: null,
        model: null,
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
    target: { sandboxName: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
    agentName: "openclaw",
    note: () => {},
    observe: () => ({ state: "missing", liveIdentityFingerprint: null }),
    intent: {
      agent: "openclaw",
      fromDockerfile: null,
      provider: null,
      model: null,
      preferredInferenceApi: null,
      sandboxGpuConfig: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: null,
      observabilityEnabled: false,
      policyTier: null,
    },
  });
}

const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: null,
  model: null,
  sessionId: "session-owner",
  durableRegistry: true,
});

if (mode === "resume" && scenario === "foreign-reservation") {
  const data = registry.load();
  data.sandboxes["my-assistant"].reservationSessionId = "session-foreign";
  registry.save(data);
}
if (mode === "resume" && scenario === "changed-checkpoint") {
  const requireCurrent = registry.requireCurrentPendingSandboxPolicyVerification;
  let reads = 0;
  registry.requireCurrentPendingSandboxPolicyVerification = (reservation, checkpoint) => {
    const current = requireCurrent(reservation, checkpoint);
    reads += 1;
    if (reads === 1) {
      const data = registry.load();
      const changed = data.sandboxes["my-assistant"].pendingPolicyVerification;
      changed.policyVersion += 1;
      changed.policyCreationReceipt.policyVersion += 1;
      registry.save(data);
    }
    return current;
  };
}

let sandboxCreated = mode === "resume";
let createChild = null;
runner.run = (command) => {
  const cmd = normalize(command);
  const profile = fixtureMocks.mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profile !== null) return profile;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from(sandboxCreated ? "my-assistant Ready\n" : "No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
  if (cmd.includes("sandbox get") && cmd.includes("my-assistant") && sandboxCreated) {
    return { status: 0, stdout: Buffer.from("my-assistant\nId: sbx-resumable-create\n"), stderr: Buffer.alloc(0) };
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = normalize(command);
  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  if (cmd.includes("policy get") && cmd.includes("--output json")) {
    return JSON.stringify({
      scope: "sandbox",
      sandbox: "my-assistant",
      status: "effective",
      policy_source: "sandbox",
      hash: "fixture-policy",
      active_version: 1,
      policy: {},
    });
  }
  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, {
    sandboxName: "my-assistant",
    sandboxId: "sbx-resumable-create",
  });
  if (createdIdentity !== null) return createdIdentity;
  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) {
    return sandboxCreated ? ["my-assistant", "Id: sbx-resumable-create"].join(String.fromCharCode(10)) : "";
  }
  if (cmd.includes("sandbox list")) return sandboxCreated ? "my-assistant Ready" : "";
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  const mocked = fixtureMocks.mockOnboardRunCapture(command, { defaultCurlOutput: "ok" });
  return mocked === null ? "" : mocked;
};

const realProcessKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && createChild) {
    process.nextTick(() => createChild.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  }
  return realProcessKill(pid, signal);
};
childProcess.spawn = (...args) => {
  const command = normalize([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  if (command.includes("sandbox create")) fs.appendFileSync(createCountPath, "create\n");
  sandboxCreated = true;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.unref = () => {};
  child.kill = (signal) => {
    process.nextTick(() => child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  };
  child.pid = 4248;
  createChild = child;
  process.nextTick(() => child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n")));
  return child;
};

const { createSandbox } = require(${onboardPath});
const transaction = onboardSession.loadSession()?.checkpoint?.sandboxRecreate;
if (!transaction) throw new Error("verified-create recovery has no lifecycle journal");
const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
  [null, null, null, null, "my-assistant", null, null, null, null, null, null, null, []],
  createFixture,
);
createArgs[15] = {
  deferSandboxEffectsUntilPolicyVerification: true,
  recreate: false,
  toolDisclosure: "progressive",
  observabilityEnabled: false,
  recreateTransaction: {
    id: transaction.id,
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
  },
};
createArgs[16] = async () => {
  fs.appendFileSync(effectCountPath, mode + "\n");
  if (mode === "seed") throw new Error("injected deferred effect failure");
};

(async () => {
  let sandboxName = null;
  let error = null;
  try {
    sandboxName = await createSandbox(...createArgs);
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  }
  if (mode === "seed" && !error) throw new Error("expected the injected effect failure");
  if (mode === "resume" && scenario === "same-session" && error) throw new Error(error);
  if (mode === "resume" && scenario !== "same-session" && !error) {
    throw new Error("expected changed recovery authority to be refused");
  }
  clearInterval(keepAlive);
  console.log(JSON.stringify({
    sandboxName,
    error,
    registryEntry: registry.getSandbox("my-assistant"),
    journal: onboardSession.loadSession()?.checkpoint?.sandboxRecreate || null,
  }));
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);
      const env = workspaceEnv(workspace, {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
        NEMOCLAW_SANDBOX_PREBUILD: "1",
      });

      const first = runOnboardProcess([scriptPath, "seed", scenario], {
        env,
        timeoutMs: 40_000,
      });
      assert.equal(first.status, 0, first.stderr || first.error?.message);
      const retained = trailingJsonPayload<{
        error: string;
        registryEntry: {
          pendingRouteReservation?: boolean;
          pendingPolicyVerification?: unknown;
          lifecycleLiveIdentityFingerprint?: string;
        };
        journal: { phase: string; targetLiveIdentityFingerprint?: string };
      }>(first.stdout);
      assert.match(retained.error, /automatic sandbox cleanup was not safe/u);
      assert.equal(retained.registryEntry.pendingRouteReservation, true);
      assert.ok(retained.registryEntry.pendingPolicyVerification);
      assert.match(
        retained.registryEntry.lifecycleLiveIdentityFingerprint ?? "",
        /^[0-9a-f]{64}$/u,
      );
      assert.equal(retained.journal.phase, "created");
      assert.equal(
        retained.journal.targetLiveIdentityFingerprint,
        retained.registryEntry.lifecycleLiveIdentityFingerprint,
      );

      const second = runOnboardProcess([scriptPath, "resume", scenario], {
        env,
        timeoutMs: 40_000,
      });
      assert.equal(second.status, 0, second.stderr || second.error?.message);
      const recovered = trailingJsonPayload<{
        sandboxName: string | null;
        error: string | null;
        registryEntry: {
          pendingRouteReservation?: boolean;
          pendingPolicyVerification?: unknown;
          policyAuthority?: string;
        };
      }>(second.stdout);
      const createEvents = fs
        .readFileSync(createCountPath, "utf8")
        .trim()
        .split(/\n/u)
        .filter(Boolean);
      const effectEvents = fs
        .readFileSync(effectCountPath, "utf8")
        .trim()
        .split(/\n/u)
        .filter(Boolean);
      assert.equal(createEvents.length, 1, "recovery must never create a second sandbox");
      assert.match(
        recovered.error ?? "completed",
        resumes ? /^completed$/u : /changed|journal|reservation|checkpoint|authority/u,
      );
      assert.equal(recovered.sandboxName, resumes ? "my-assistant" : null);
      assert.equal(recovered.registryEntry.pendingRouteReservation, resumes ? undefined : true);
      assert.equal(Boolean(recovered.registryEntry.pendingPolicyVerification), !resumes);
      assert.equal(
        recovered.registryEntry.policyAuthority,
        resumes ? "nemoclaw-managed" : undefined,
      );
      assert.deepEqual(effectEvents, resumes ? ["seed", "resume"] : ["seed"]);
    },
  );
});
