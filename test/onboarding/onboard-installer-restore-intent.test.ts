// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

const repoRoot = path.join(import.meta.dirname, "../..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);
const createdTmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

describe("createSandbox installer restore intent", () => {
  afterEach(() => {
    for (const dir of createdTmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "non-interactive not-ready sandbox with installer restore intent skips the fresh backup, restores the pre-upgrade backup, and stays exec-usable for a workspace marker (#6114)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = makeTmpDir("nemoclaw-onboard-installer-restore-");
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "installer-restore.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );
      const execActionPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "actions", "sandbox", "exec.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin, { readySandboxGet: true });

      const script = String.raw`
const runner = require(${runnerPath});
const fixtureMocks = require(${onboardScriptMocksPath});
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const PRE_UPGRADE_BACKUP = "/tmp/fake-pre-upgrade-backup";
const events = [];
let sandboxDeleted = false;
let sandboxRecreated = false;
runner.run = (command) => {
  const cmd = _n(command);
  events.push({ kind: "run", cmd });
  const profileResult = fixtureMocks.mockManagedEndpointlessProviderProfileRun(command);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox list")) return { status: 0, stdout: "No sandboxes found." };
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  if (cmd.includes("sandbox list")) {
    return { status: 0, stdout: Buffer.from("No sandboxes found.\n"), stderr: Buffer.alloc(0) };
  }
  return cmd.includes("sandbox get") && cmd.includes("my-assistant")
    ? { status: 0, stdout: Buffer.from("my-assistant\nId: sbx-4f2a91c0d7\n"), stderr: Buffer.alloc(0) }
    : { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
  if (sandboxRecreated) {
    const createdIdentity = fixtureMocks.mockCreatedSandboxIdentityList(command, { sandboxName: "my-assistant" });
    if (createdIdentity !== null) return createdIdentity;
  }
  if (cmd.includes("sandbox get") && cmd.includes("my-assistant")) return sandboxDeleted && !sandboxRecreated ? "" : ["my-assistant", "Id: sbx-4f2a91c0d7"].join(String.fromCharCode(10));
  if (cmd.includes("sandbox list")) {
    return sandboxRecreated ? "my-assistant Ready" : sandboxDeleted ? "" : "my-assistant NotReady";
  }
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const mockedCapture = fixtureMocks.mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
fixtureMocks.mockDockerSandboxLifecycleReleaseFromRunner();
const sourceEntry = fixtureMocks.managedSandboxPolicyReceiptFixture({
  name: "my-assistant",
  gpuEnabled: false,
  toolDisclosure: "progressive",
});
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  getSandbox: () => sourceEntry,
});

sandboxState.getLatestBackup = (name) => {
  events.push({ kind: "getLatestBackup", name });
  return { backupPath: PRE_UPGRADE_BACKUP, timestamp: "2026-05-25T00:00:00Z" };
};
sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  return {
    success: true,
    backedUpDirs: ["workspace"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/fake-fresh-backup", timestamp: "2026-05-25T00:00:00Z" },
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
  sandboxRecreated = true;
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
const { runSandboxExecCommand } = require(${execActionPath});

const MARKER_PATH = "/sandbox/workspace/marker.txt";
const MARKER_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  delete process.env.NEMOCLAW_RECREATE_SANDBOX;
  process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
    createFixture,
  ));

  // Prove the recreated + restored sandbox is reachable through the real
  // "nemoclaw <name> exec" boundary and can read a preserved workspace marker.
  const completion = await runSandboxExecCommand(
    "openshell",
    sandboxName,
    ["sha256sum", MARKER_PATH],
    {},
    async (binary, args) => {
      const joined = _n([binary, ...args]);
      const reads =
        joined.includes("sandbox exec") &&
        joined.includes("--name " + sandboxName) &&
        joined.includes("sha256sum " + MARKER_PATH);
      events.push({ kind: "exec", cmd: joined, marker: reads ? MARKER_SHA : null });
      return { status: reads ? 0 : 1 };
    },
    {
      getSandbox: () => ({ agent: "openclaw" }),
      inspectMutableConfigPerms: () => ({ applies: true, ok: true }),
      repairMutableConfigPerms: () => ({ applied: false }),
    },
  );
  console.log(JSON.stringify({ sandboxName, events, execCode: completion.code }));
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
        NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
        NEMOCLAW_SANDBOX_PREBUILD: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
        timeout: 30_000,
      });

      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(
        payload.sandboxName,
        "my-assistant",
        "should recreate and return the sandbox name",
      );

      const events = payload.events as Array<{
        kind: string;
        cmd?: string;
        name?: string;
        backupPath?: string;
        marker?: string | null;
      }>;
      const getLatestIndex = events.findIndex((e) => e.kind === "getLatestBackup");
      const deleteIndex = events.findIndex(
        (e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete"),
      );
      const restoreIndex = events.findIndex((e) => e.kind === "restore");

      assert.ok(getLatestIndex >= 0, "should consult the latest pre-upgrade backup");
      assert.ok(
        !events.some((e) => e.kind === "backup"),
        "should skip the fresh pre-recreate backup when a pre-upgrade backup is being restored",
      );
      assert.ok(deleteIndex >= 0, "should delete the not-ready sandbox before recreating");
      assert.ok(restoreIndex > deleteIndex, "restore must happen after sandbox recreate");
      assert.equal(
        events[restoreIndex]?.backupPath,
        "/tmp/fake-pre-upgrade-backup",
        "should restore from the selected pre-upgrade backup rather than a fresh backup",
      );

      const execIndex = events.findIndex((e) => e.kind === "exec");
      assert.ok(execIndex > restoreIndex, "exec marker read must happen after restore");
      assert.equal(
        events[execIndex]?.marker,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "nemoclaw exec should read the preserved workspace marker after restore",
      );
      assert.equal(payload.execCode, 0, "nemoclaw exec of the workspace marker should succeed");
    },
  );

  it.each([
    { change: "changes", race: "changed", error: /source registry row changed/u },
    { change: "is removed", race: "removed", error: /source registry row is absent/u },
  ])(
    "rejects installer restore when the source registry row $change after journal capture (#7736)",
    async ({ race, error }) => {
      const tmpDir = makeTmpDir("nemoclaw-onboard-registry-race-");
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "registry-race.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );
      const onboardSessionPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
require(${onboardScriptMocksPath}).mockStandaloneGatewayTeardownAuthority();
const normalize = (command) =>
  (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const onboardSession = require(${onboardSessionPath});
const childProcess = require("node:child_process");

const mutations = [];
const sourceEntry = {
  name: "my-assistant",
  agent: "openclaw",
  gpuEnabled: false, policyAuthority: "nemoclaw-managed",
  imageTag: "nemoclaw/my-assistant:1",
  toolDisclosure: "progressive",
};
const racedEntry =
  process.env.NEMOCLAW_TEST_REGISTRY_RACE === "removed"
    ? null
    : { ...sourceEntry, imageTag: "nemoclaw/my-assistant:2" };
const journalExists = () =>
  onboardSession.loadSession()?.checkpoint?.sandboxRecreate !== undefined;
const recordMutation = (kind) => {
  mutations.push(kind);
  return true;
};

runner.run = (command) => {
  mutations.push("run " + normalize(command));
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = normalize(command);
  if (normalized.includes("sandbox get") && normalized.includes("my-assistant")) return "";
  if (normalized.includes("sandbox list")) return "";
  if (normalized.includes("forward list")) {
    return "my-assistant 127.0.0.1 18789 12345 running";
  }
  const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
    defaultCurlOutput: "ok",
  });
  return mockedCapture ?? "";
};
registry.getSandbox = () => (journalExists() ? racedEntry : sourceEntry);
registry.registerSandbox = () => recordMutation("registry register");
registry.updateSandbox = () => recordMutation("registry update");
registry.setDefault = () => recordMutation("registry default");
registry.removeSandbox = () => recordMutation("registry remove");
sandboxState.getLatestBackup = () => {
  mutations.push("backup lookup");
  return { backupPath: "/tmp/pre-upgrade-backup", timestamp: "2026-08-04T00:00:00Z" };
};
sandboxState.backupSandboxState = () => recordMutation("sandbox backup");
sandboxState.restoreRecreatedSandboxState = () => recordMutation("sandbox restore");
childProcess.spawn = () => recordMutation("sandbox create");

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
  try {
    await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
    console.log(JSON.stringify({ error: null, mutations }));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.log(JSON.stringify({ error: message, mutations }));
  }
})();
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
          NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
          NEMOCLAW_TEST_REGISTRY_RACE: race,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, "expected the registry-race fixture to report its result");
      const payload = JSON.parse(payloadLine) as { error: string | null; mutations: string[] };
      assert.match(payload.error ?? "", error);
      assert.deepEqual(
        payload.mutations,
        [],
        "registry drift must stop before backup lookup or an external mutation",
      );
    },
  );

  it(
    "non-interactive not-ready sandbox without installer restore intent exits before any sandbox delete (#6114)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = makeTmpDir("nemoclaw-onboard-no-restore-intent-");
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "no-restore-intent.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin, { readySandboxGet: true });

      const script = String.raw`
const runner = require(${runnerPath});
const fixtureMocks = require(${onboardScriptMocksPath});
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");

runner.run = (command) => {
  if (_n(command).includes("sandbox delete")) {
    throw new Error("unexpected sandbox delete");
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  if (normalized.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  if (normalized.includes("policy get") && normalized.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
  if (normalized.includes("sandbox get") && normalized.includes("my-assistant")) return ["my-assistant", "Id: sbx-4f2a91c0d7"].join(String.fromCharCode(10));
  if (normalized.includes("sandbox list")) return "my-assistant NotReady";
  // Keep dashboard allocation inside this restore-intent fixture; host port
  // occupancy is unrelated to the not-ready decision under test.
  if (normalized.includes("forward list")) {
    return "my-assistant 127.0.0.1 18789 12345 running";
  }
  return "";
};
registry.getSandbox = () => fixtureMocks.managedSandboxPolicyReceiptFixture({
  name: "my-assistant",
  gpuEnabled: false,
  toolDisclosure: "progressive",
});
sandboxState.getLatestBackup = () => {
  throw new Error("unexpected getLatestBackup without installer restore intent");
};
childProcess.spawn = () => {
  throw new Error("unexpected sandbox create");
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  delete process.env.NEMOCLAW_RECREATE_SANDBOX;
  delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
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
        NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      delete env["NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.notEqual(
        result.status,
        0,
        "expected non-zero exit when installer restore intent is unset",
      );
      assert.ok(
        !result.stdout.includes("ERROR_DID_NOT_EXIT"),
        "should have exited before reaching sandbox create",
      );
      const output = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        !output.includes("unexpected sandbox delete"),
        "should exit before attempting sandbox delete",
      );
      assert.ok(
        !output.includes("unexpected getLatestBackup"),
        "should not consult a pre-upgrade backup without installer restore intent",
      );
      assert.ok(
        output.includes("--recreate-sandbox") || output.includes("NEMOCLAW_RECREATE_SANDBOX"),
        `should hint about --recreate-sandbox flag; output:\n${output}`,
      );
    },
  );
});
