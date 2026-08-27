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
      title:
        "registers providerless APF only after identity, policy, and checkpoint verification (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "providerless-apf" as const,
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
      title: "rejects staged messaging intent before any onboarding side effect (#9833)",
      apfInterceptorRequested: true,
      provider: null,
      model: null,
      agent: null,
      expectedOutcome: "staged-messaging-refusal" as const,
    },
    {
      title: "preserves a newly created sandbox when non-TTY policy selection is cancelled (#9833)",
      apfInterceptorRequested: false,
      provider: "nvidia-prod",
      model: "gpt-5.4",
      agent: null,
      expectedOutcome: "cancel-after-create" as const,
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
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
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
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
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
let sandboxListCalls = 0;
let dockerPsCalls = 0;
let sandboxCreated = false;
let registeredSandbox = null;
let effectivePolicy = {};
let credentialReadCalls = 0;
let routeReservationCalls = 0;
const keepAlive = setInterval(() => {}, 1000);
const apfInterceptorRequested = ${JSON.stringify(apfInterceptorRequested)};
const agent = ${JSON.stringify(agent)};
const model = ${JSON.stringify(model)};
const provider = ${JSON.stringify(provider)};
const cancelAfterCreate = ${JSON.stringify(expectedOutcome === "cancel-after-create")};
const stagedMessagingRefusal = ${JSON.stringify(expectedOutcome === "staged-messaging-refusal")};
const postCreateAuthorityRefusal = ${JSON.stringify(
        expectedOutcome === "post-create-authority-refusal",
      )};
let cancelPrompt = false;
const originalGetCredential = credentials.getCredential;
if (stagedMessagingRefusal) {
  credentials.getCredential = (...args) => {
    credentialReadCalls += 1;
    if (typeof args[0] !== "string") return null;
    return originalGetCredential(...args);
  };
}
const originalReserveSandboxInferenceRoute = registry.reserveSandboxInferenceRoute;
if (stagedMessagingRefusal) {
  registry.reserveSandboxInferenceRoute = (...args) => {
    routeReservationCalls += 1;
    return originalReserveSandboxInferenceRoute(...args);
  };
}
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  _deleted = _deleted || cmd.includes("sandbox delete");
  commands.push({ command: cmd, env: opts.env || null });
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
  return cmd.includes("sandbox get") && cmd.includes("my-assistant") && sandboxCreated
    ? { status: 0, stdout: Buffer.from("my-assistant\nId: sbx-fresh-create\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: effectivePolicy });
	  if (cmd.includes("sandbox get") || cmd.includes("sandbox list")) {
	    lifecycleObservationCommands.push(cmd);
	  }
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, {
	    sandboxName: "my-assistant",
	    sandboxId: "sbx-fresh-create",
	  });
	  if (createdIdentity !== null) return createdIdentity;
  if (cmd.startsWith("docker ps -a --no-trunc ")) {
    dockerPsCalls += 1;
    if (dockerPsCalls === 1) return "a".repeat(64);
  }
  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) {
    return sandboxCreated ? ["my-assistant", "Id: sbx-fresh-create"].join(String.fromCharCode(10)) : "";
  }
  if (cmd.includes("sandbox list")) {
    sandboxListCalls += 1;
    return sandboxListCalls >= 2 ? "my-assistant Ready" : "my-assistant Pending";
  }
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider,
	  model,
	  apfInterceptorRequested,
	  onVerifyCreatedPolicy: (input) => {
	    if (postCreateAuthorityRefusal) {
	      throw new Error("external policy authority changed");
	    }
	    effectivePolicy = require(${policyMergePath}).parseOpenShellPolicy(
	      fs.readFileSync(input.policySourcePath, "utf8"),
	    ).policy;
	  },
	  registerSandbox: (entry) => { registeredSandbox = entry; },
	});
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
  sandboxCreated = true;
  _deleted = false;
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
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null, child });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.stderr.emit("data", Buffer.from("Setting up NemoClaw...\n"));
  });
  return child;
};

const onboardModule = require(${onboardPath});
const { createSandbox } = onboardModule;
if (cancelAfterCreate) {
  const session = onboardModule.onboardSession.createSession({
    mode: "interactive",
    sandboxName: "my-assistant",
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  });
  onboardModule.onboardSession.saveSession(session);
}

const writePayload = (sandboxName, creationError, exitCode = 0) => {
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    creationError,
    exitCode,
    deleted: _deleted,
    sandboxCreated,
    sandboxListCalls,
    killCalls: createCommand?.child?.killCalls ?? [],
    groupKillCalls,
    unrefCalls: createCommand?.child?.unrefCalls ?? 0,
    stdoutDestroyCalls: createCommand?.child?.stdout.destroyCalls ?? 0,
    stderrDestroyCalls: createCommand?.child?.stderr.destroyCalls ?? 0,
    lifecycleObservationCommands,
    registeredSandbox,
    credentialReadCalls,
    routeReservationCalls,
    currentRegistryEntry: cancelAfterCreate ? registry.getSandbox("my-assistant") : null,
    savedSession: cancelAfterCreate ? onboardModule.onboardSession.loadSession() : null,
    createCommand: createCommand?.command ?? null,
    commandNames: commands.map((entry) => entry.command),
  }));
};

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
	  const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, model, provider, null, null, null, null, null, agent, null, null, null, []],
	    createFixture,
	  );
	  if (apfInterceptorRequested) {
	    createArgs[15] = {
	      apfInterceptorRequested: true,
	      deferSandboxEffectsUntilPolicyVerification: true,
	      recreate: false,
	      toolDisclosure: "progressive",
	      observabilityEnabled: false,
	    };
	  }
	  try {
	    const sandboxName = await createSandbox(...createArgs);
	    if (cancelAfterCreate) {
	      process.on("exit", (code) => writePayload(sandboxName, null, code));
	      cancelPrompt = true;
	      await onboardModule.selectPolicyTier();
	      throw new Error("expected policy selection cancellation");
	    }
	    writePayload(sandboxName, null);
	  } catch (error) {
	    if (cancelAfterCreate) throw error;
	    if (!apfInterceptorRequested) throw error;
    writePayload(null, error instanceof Error ? error.message : String(error));
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
        NEMOCLAW_NON_INTERACTIVE: expectedOutcome === "cancel-after-create" ? "" : "1",
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

      assert.equal(result.status, expectedOutcome === "cancel-after-create" ? 1 : 0, result.stderr);
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
      const assertProviderBackedApfRefusal = () => {
        assert.match(
          payload.creationError,
          /Cannot create sandbox 'my-assistant' with deferred providers .* No sandbox was created/u,
        );
        assert.equal(payload.sandboxName, null);
        assert.equal(payload.sandboxCreated, false);
        assert.equal(payload.createCommand, null);
        assert.equal(payload.registeredSandbox, null);
        assert.deepEqual(providerEffectCommands, []);
        assert.equal(
          payload.commandNames.some((command: string) => command.includes("sandbox create")),
          false,
        );
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
        assert.equal(payload.registeredSandbox.workload.kind, "managed-image");
        assert.match(payload.registeredSandbox.lifecycleGeneration, /^[0-9a-f-]{36}$/u);
        assert.equal(
          payload.registeredSandbox.lifecycleLiveIdentityFingerprint,
          createHash("sha256").update("sbx-fresh-create").digest("hex"),
        );
        assert.match(
          payload.createCommand,
          /--label ai\.nvidia\.nemoclaw\.create-attempt=[0-9a-f]{62}/u,
        );
        const ownerScopedObservations = payload.lifecycleObservationCommands.filter(
          (command: string) => command.includes("-g nemoclaw"),
        );
        assert.ok(
          ownerScopedObservations.length >= 6,
          "expected owner-scoped sandbox identity observations",
        );
        assert.ok(
          ownerScopedObservations.every(
            (command: string) =>
              command.includes("sandbox get -g nemoclaw my-assistant") ||
              command.includes("sandbox list -g nemoclaw"),
          ),
          `fresh identity observations must remain scoped to the owning gateway: ${JSON.stringify(ownerScopedObservations)}`,
        );
      };
      const assertManagedProviderCreation = () => {
        assertSuccessfulCreation();
        assert.deepEqual(payload.groupKillCalls, [{ pid: -4242, signal: "SIGTERM" }]);
        assert.deepEqual(payload.killCalls, []);
        assert.equal(payload.unrefCalls, 1);
        assert.equal(payload.stdoutDestroyCalls, 1);
        assert.equal(payload.stderrDestroyCalls, 1);
        assert.equal(payload.registeredSandbox.policyAuthority, "nemoclaw-managed");
        assert.ok(payload.registeredSandbox.policyCreationReceipt);
        assert.match(payload.createCommand, /--policy \S+/u);
        assert.match(payload.createCommand, /--provider nvidia-prod/u);
      };
      const assertProviderlessApfCreation = () => {
        assertSuccessfulCreation();
        assert.equal(payload.registeredSandbox.policyAuthority, "externally-managed");
        assert.equal(payload.registeredSandbox.policyCreationReceipt, undefined);
        assert.doesNotMatch(payload.createCommand, /(?:^|\s)--policy(?:\s|$)/u);
        assert.doesNotMatch(payload.createCommand, /(?:^|\s)--provider(?:\s|$)/u);
        assert.deepEqual(providerExposureCommands, []);
      };
      const assertPostCreateAuthorityRefusal = () => {
        const identityFingerprint = createHash("sha256").update("sbx-fresh-create").digest("hex");
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
      };
      const assertCancellationRecovery = () => {
        const identityFingerprint = createHash("sha256").update("sbx-fresh-create").digest("hex");
        assert.equal(payload.exitCode, 1);
        assert.equal(payload.sandboxName, "my-assistant");
        assert.equal(payload.deleted, false);
        assert.equal(payload.registeredSandbox.name, "my-assistant");
        assert.equal(
          payload.currentRegistryEntry.lifecycleLiveIdentityFingerprint,
          identityFingerprint,
        );
        assert.equal(payload.currentRegistryEntry.name, "my-assistant");
        assert.equal(payload.savedSession.status, "in_progress");
        assert.equal(payload.savedSession.sandboxName, "my-assistant");
        assert.equal(
          payload.commandNames.some((command: string) => command.includes("sandbox delete")),
          false,
        );
        assert.match(result.stderr, /preserved incomplete sandbox 'my-assistant'/u);
        assert.match(result.stderr, new RegExp(identityFingerprint, "u"));
        assert.match(result.stderr, /Do not delete the sandbox by mutable sandbox name/u);
      };
      const assertions = {
        "managed-provider": assertManagedProviderCreation,
        "provider-refusal": assertProviderBackedApfRefusal,
        "providerless-apf": assertProviderlessApfCreation,
        "post-create-authority-refusal": assertPostCreateAuthorityRefusal,
        "staged-messaging-refusal": assertStagedMessagingRefusal,
        "cancel-after-create": assertCancellationRecovery,
      };
      assertions[expectedOutcome]();
    },
  );
});
