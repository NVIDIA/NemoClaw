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
const keepAlive = setInterval(() => {}, 1000);
const apfInterceptorRequested = ${JSON.stringify(apfInterceptorRequested)};
const agent = ${JSON.stringify(agent)};
const model = ${JSON.stringify(model)};
const provider = ${JSON.stringify(provider)};
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
	    effectivePolicy = require(${policyMergePath}).parseOpenShellPolicy(
	      fs.readFileSync(input.policySourcePath, "utf8"),
	    ).policy;
	  },
	  registerSandbox: (entry) => { registeredSandbox = entry; },
	});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

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

const { createSandbox } = require(${onboardPath});

const writePayload = (sandboxName, creationError) => {
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    creationError,
    sandboxCreated,
    sandboxListCalls,
    killCalls: createCommand?.child?.killCalls ?? [],
    groupKillCalls,
    unrefCalls: createCommand?.child?.unrefCalls ?? 0,
    stdoutDestroyCalls: createCommand?.child?.stdout.destroyCalls ?? 0,
    stderrDestroyCalls: createCommand?.child?.stderr.destroyCalls ?? 0,
    lifecycleObservationCommands,
    registeredSandbox,
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
	    writePayload(sandboxName, null);
	  } catch (error) {
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

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          OPENSHELL_DRIVERS: "docker",
        },
        timeout: 30000,
      });

      assert.equal(result.status, 0, result.stderr);
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
      const assertSuccessfulCreation = () => {
        assert.equal(payload.creationError, null);
        assert.equal(payload.sandboxName, "my-assistant");
        assert.ok(payload.sandboxListCalls >= 2);
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
      const assertions = {
        "managed-provider": assertManagedProviderCreation,
        "provider-refusal": assertProviderBackedApfRefusal,
        "providerless-apf": assertProviderlessApfCreation,
      };
      assertions[expectedOutcome]();
    },
  );
});
