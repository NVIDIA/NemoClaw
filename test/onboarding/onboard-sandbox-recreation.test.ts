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

describe("onboard helpers", () => {
  it(
    "non-interactive exits with error when existing sandbox is not ready",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-noninteractive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "noninteractive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
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
const childProcess = require("node:child_process");

runner.run = (command) => {
  _deleted = _deleted || _n(command).includes("sandbox delete");
  if (_n(command).includes("sandbox delete")) {
    throw new Error("unexpected sandbox delete");
  }
  if (_n(command).includes("sandbox list")) return { status: 0, stdout: "No sandboxes found." };
  return { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  // Existing sandbox that is NOT ready
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: sbx-4f2a91c0d7"].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant NotReady";
	  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
	  return "";
	};
	registry.getSandbox = () => fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  toolDisclosure: "progressive",
	}, { sandboxId: "sbx-4f2a91c0d7" });
childProcess.spawn = () => {
  throw new Error("unexpected sandbox create");
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.notEqual(result.status, 0, "expected non-zero exit for not-ready sandbox");
      assert.ok(
        !result.stdout.includes("ERROR_DID_NOT_EXIT"),
        "should have exited before reaching sandbox create",
      );
      const output = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        output.includes("--recreate-sandbox") || output.includes("NEMOCLAW_RECREATE_SANDBOX"),
        "should hint about --recreate-sandbox flag",
      );
    },
  );

  it.each(["balanced", "restricted"])(
    "recreate-sandbox records the %s policy tier and late replacement identity",
    {
      timeout: 60_000,
    },
    async (policyTier) => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-flag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-flag.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = []; let registeredSandbox = null;
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	  openshellDriver: "docker",
  imageTag: "openshell/sandbox-from:source",
  workload: {
    schemaVersion: 1,
    kind: "legacy-dockerfile",
    reference: "openshell/sandbox-from:source",
    shared: false,
  },
	}, { sandboxId: "sbx-4f2a91c0d7" });
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
	  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
	const getSandbox = () => registeredSandbox || sourceSandbox;
	registry.getSandbox = getSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox,
	  registerSandbox: (entry) => { registeredSandbox = entry; },
	});

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  _deleted = false;
  _sandboxId = "sbx-8e6b10fd33";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
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
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, commands, registeredSandbox }));
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
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_POLICY_TIER: policyTier,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete existing sandbox when --recreate-sandbox is set",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")) &&
          payload.registeredSandbox?.policyTier === policyTier,
        "should create a sandbox and persist its tier before policy finalization",
      );
      assert.ok(
        !payload.commands.some((entry: CommandEntry) =>
          entry.command.includes("docker rmi openshell/sandbox-from:source"),
        ),
        "must defer source image retirement until replacement registration is proven",
      );
      const sourceFingerprint = createHash("sha256").update("sbx-4f2a91c0d7").digest("hex");
      const replacementFingerprint = createHash("sha256").update("sbx-8e6b10fd33").digest("hex");
      assert.match(payload.registeredSandbox?.lifecycleGeneration ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(
        payload.registeredSandbox?.lifecycleLiveIdentityFingerprint,
        replacementFingerprint,
        "replacement registration must read the live identity after creation",
      );
      assert.notEqual(
        payload.registeredSandbox?.lifecycleLiveIdentityFingerprint,
        sourceFingerprint,
      );
    },
  );
  it(
    "recreate-sandbox flag backs up and restores workspace state",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-backup-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-backup.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
runner.run = (command) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  return {
    success: true,
    backedUpDirs: ["workspace", "skills"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/fake-backup-path", timestamp: "2026-05-25T00:00:00Z" },
  };
};
sandboxState.restoreRecreatedSandboxState = (name, backupPath, options) => {
  events.push({ kind: "restore", name, backupPath, options });
  return {
    success: true,
    restoredDirs: ["workspace", "skills"],
    failedDirs: [],
    restoredFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
  };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd34";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4243;
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
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, events }));
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
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const events = payload.events as Array<{
        kind: string;
        cmd?: string;
        name?: string;
        backupPath?: string;
        options?: { targetAgentType?: string; freshOpenClawImagePluginInstalls?: unknown[] };
      }>;
      const backupIndex = events.findIndex((e) => e.kind === "backup");
      const deleteIndex = events.findIndex(
        (e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete"),
      );
      const restoreIndex = events.findIndex((e) => e.kind === "restore");

      assert.ok(backupIndex >= 0, "should call backupSandboxState before delete");
      assert.ok(deleteIndex > backupIndex, "backup must happen before sandbox delete");
      assert.ok(restoreIndex > deleteIndex, "restore must happen after sandbox recreate");
      const backupEvent = events[backupIndex];
      assert.equal(backupEvent?.name, "my-assistant", "backup target must match sandbox name");
      const restoreEvent = events[restoreIndex];
      assert.equal(
        restoreEvent?.backupPath,
        "/tmp/fake-backup-path",
        "restore must use backup path",
      );
      assert.equal(restoreEvent?.options?.targetAgentType, "openclaw");
      assert.equal(restoreEvent?.options?.freshOpenClawImagePluginInstalls, undefined);
    },
  );

  it(
    "recreate-sandbox with NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 skips backup",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-recreate-skip-backup-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-skip-backup.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
runner.run = (command) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

sandboxState.backupSandboxState = () => {
  events.push({ kind: "backup" });
  return { success: true, backedUpDirs: [], failedDirs: [], backedUpFiles: [], failedFiles: [] };
};
sandboxState.restoreRecreatedSandboxState = () => {
  events.push({ kind: "restore" });
  return { success: true, restoredDirs: [], failedDirs: [], restoredFiles: [], failedFiles: [] };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd35";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4244;
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
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, events }));
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
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      const events = payload.events as Array<{ kind: string }>;
      assert.ok(
        !events.some((e) => e.kind === "backup"),
        "should not call backupSandboxState when NEMOCLAW_RECREATE_WITHOUT_BACKUP=1",
      );
      assert.ok(
        !events.some((e) => e.kind === "restore"),
        "should not call restoreRecreatedSandboxState when no backup occurred",
      );
    },
  );

  it(
    "recreate-sandbox flag backs up and restores when existing sandbox is not ready",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-notready-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
let sandboxDeleted = false;
runner.run = (command) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox list")) return { status: 0, stdout: "No sandboxes found." };
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
  if (cmd.includes("sandbox list")) {
    return _deleted ? "" : sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
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
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  return {
    success: true,
    backedUpDirs: ["workspace"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/fake-backup-notready", timestamp: "2026-05-25T00:00:00Z" },
  };
};
sandboxState.restoreRecreatedSandboxState = (name, backupPath) => {
  events.push({ kind: "restore", name, backupPath });
  return {
    success: true,
    restoredDirs: ["workspace"],
    failedDirs: [],
    restoredFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
  };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd36";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4245;
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
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, events }));
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
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const events = payload.events as Array<{
        kind: string;
        cmd?: string;
        name?: string;
        backupPath?: string;
      }>;
      const backupIndex = events.findIndex((e) => e.kind === "backup");
      const deleteIndex = events.findIndex(
        (e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete"),
      );
      const restoreIndex = events.findIndex((e) => e.kind === "restore");

      assert.ok(backupIndex >= 0, "should call backupSandboxState for not-ready sandbox");
      assert.ok(deleteIndex > backupIndex, "backup must happen before sandbox delete");
      assert.ok(restoreIndex > deleteIndex, "restore must happen after sandbox recreate");
    },
  );

  it(
    "recreating a sandbox preserves the user's policy preset selections",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-preserves-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-preserves.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sessionModulePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const onboardSession = require(${sessionModulePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
	  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};

// Existing sandbox has a custom preset selection: only "npm" (not the
// full "balanced" tier). Recreating the sandbox must preserve this
// customisation rather than reverting to the tier defaults.
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	  policies: ["npm"],
	  policyTier: "balanced",
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd37";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
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
	  await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  const session = onboardSession.loadSession();
  console.log(JSON.stringify({ policyPresets: session && session.policyPresets }));
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
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.deepEqual(
        payload.policyPresets,
        ["npm"],
        "createSandbox should write the previous sandbox's policy presets to the onboard session before destroying it so they can be reapplied after recreation",
      );
    },
  );

  it(
    "interactive mode prompts before reusing an existing ready sandbox",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-interactive-reuse-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-reuse.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
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
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "nvidia-prod", model: "gpt-5.4" }),
      );
    }
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
    ? { status: 0, stdout: Buffer.from("my-assistant\nId: sbx-4f2a91c0d7\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: sbx-4f2a91c0d7"].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
	  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
	  return "";
	};
	registry.getSandbox = () => fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  toolDisclosure: "progressive",
	}, { sandboxId: "sbx-4f2a91c0d7" });

// Mock prompt to return "y" (reuse)
credentials.prompt = async () => "y";

childProcess.spawn = (...args) => {
  _deleted = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse when user answers y");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when user chooses to reuse",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when user chooses to reuse",
      );
      assert.ok(
        result.stdout.includes("already exists"),
        "should show 'already exists' message in interactive mode",
      );
    },
  );

  it(
    "interactive mode deletes and recreates sandbox when user confirms drift recreate",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-decline-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-decline.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "openai-prod", model: "gpt-4o" }),
      );
    }
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) return _deleted ? "" : "my-assistant Ready";
	  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  toolDisclosure: "progressive",
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// Mock prompt to return "y" (confirm recreate)
credentials.prompt = async () => "y";

	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd38";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*delete/.test(String(entry.command)),
        ),
        "should delete existing sandbox when user confirms recreate",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*create/.test(String(entry.command)),
        ),
        "should create a new sandbox when user confirms recreate",
      );
      assert.ok(
        result.stdout.includes("requested inference selection changed"),
        "should show drift warning before prompting",
      );
    },
  );

  it(
    "interactive mode auto-recreates when existing sandbox is not ready",
    {
      timeout: 60_000,
    },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	let _deleted = false; let _sandboxId = "sbx-4f2a91c0d7";
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
let sandboxDeleted = false;
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  _deleted = _deleted || cmd.includes("sandbox delete");
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("sandbox list")) return { status: 0, stdout: "No sandboxes found." };
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
	  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
	    ? { status: 0, stdout: Buffer.from("my-assistant\nId: " + _sandboxId + "\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
	runner.runCapture = (command) => {
	  // Existing sandbox that is NOT ready initially, becomes Ready after recreation
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant", sandboxId: _sandboxId });
	  if (createdIdentity !== null) return createdIdentity;
	  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return _deleted ? "" : ["my-assistant", "Id: " + _sandboxId].join(String.fromCharCode(10));
	  if (cmd.includes("sandbox list")) {
	    return _deleted ? "" : sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
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
	const sourceSandbox = fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  toolDisclosure: "progressive",
	}, { sandboxId: "sbx-4f2a91c0d7" });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
	});

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// User confirms recreation when prompted
credentials.prompt = async () => "y";

const fakeSpawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};
	childProcess.spawn = (...args) => {
	  _deleted = false;
	  _sandboxId = "sbx-8e6b10fd39";
	  return fakeSpawn(...args);
	};

// Also patch spawn inside the compiled sandbox-create-stream module.
// It imports spawn at load time from "node:child_process", so patching the
// childProcess object above does not reach it. Patch the cached module
// directly so streamSandboxCreate (called by createSandbox) doesn't spawn
// a real bash process that tries to hit a live gateway.
const sandboxCreateStreamMod = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "sandbox", "create-stream.ts"))});
const _origStreamCreate = sandboxCreateStreamMod.streamSandboxCreate;
sandboxCreateStreamMod.streamSandboxCreate = (command, env, options = {}) => {
  return _origStreamCreate(command, env, { ...options, spawnImpl: fakeSpawn });
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
	  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
	    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
	    createFixture,
	  ));
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete not-ready sandbox after user confirms",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")),
        "should recreate sandbox when existing one is not ready",
      );
      assert.ok(result.stdout.includes("not ready"), "should mention sandbox is not ready");
    },
  );
});
