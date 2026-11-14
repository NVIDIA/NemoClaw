// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { it, type TestContext } from "vitest";
import {
  createOnboardProcessWorkspace,
  runOnboardProcessAsync,
  trailingJsonPayload,
  workspaceEnv,
} from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

async function assertSourcePublishedAfterPreDeleteFailure(
  failure: "backup" | "policy preflight",
  expectedError: RegExp,
  context: TestContext,
): Promise<{ journal: unknown }> {
  const workspace = createOnboardProcessWorkspace("nemoclaw-failed-recreate-backup-");
  context.onTestFinished(() => workspace.remove());
  writeOkOpenshell(workspace.binDir);
  const repoRoot = path.join(import.meta.dirname, "../..");
  const scriptPath = workspace.path("failed-recreate-backup.js");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src/lib/onboard.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src/lib/runner.ts"));
  const registryPath = JSON.stringify(path.join(repoRoot, "src/lib/state/registry.ts"));
  const sandboxStatePath = JSON.stringify(path.join(repoRoot, "src/lib/state/sandbox.ts"));
  const sessionPath = JSON.stringify(path.join(repoRoot, "src/lib/state/onboard-session.ts"));
  const mocksPath = JSON.stringify(path.join(repoRoot, "test/helpers/onboard-script-mocks.cjs"));
  const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const sessions = require(${sessionPath});
const mocks = require(${mocksPath});
const childProcess = require("node:child_process");
const commandText = (command) => (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
const events = [];
const providerConfig = { credential: "old-test-key" };
const failPolicyPreflight = ${JSON.stringify(failure === "policy preflight")};
mocks.mockStandaloneGatewayTeardownAuthority();
mocks.mockManagedStateVolumeOnboardLifecycle();
const live = mocks.createCreatedSandboxFixture({ lifecycleState: "created" });
const sourceId = live.state.sandboxId;
const source = mocks.sandboxLifecycleFixture({
  name: "my-assistant",
  agent: "openclaw",
  provider: "nvidia-prod",
  model: "old-model",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  gpuEnabled: false,
}, { sandboxId: sourceId });
registry.save({ defaultSandbox: "my-assistant", sandboxes: { "my-assistant": source } });
const before = registry.load();
runner.run = (command, options = {}) => {
  const cmd = commandText(command);
  events.push({ kind: "run", cmd });
  if (cmd.includes("provider update") && cmd.includes("nvidia-prod")) {
    providerConfig.credential = options.env?.NVIDIA_INFERENCE_API_KEY ?? "";
  }
  const profile = mocks.mockProviderPreparationRun(command, "nemoclaw", "nemoclaw-messaging-v1", false);
  if (profile !== null) return profile;
  if (cmd.includes("sandbox delete")) throw new Error("unexpected sandbox delete");
  return live.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = commandText(command);
  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  if (cmd.includes("policy get") && cmd.includes("--output json"))
    return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
  const capture = live.capture(command);
  if (capture !== null) return capture;
  if (cmd.includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return mocks.mockOnboardRunCapture(command, { defaultCurlOutput: "ok" }) ?? "";
};
const fixture = mocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "new-model",
  getSandbox: registry.getSandbox,
  sourceSandboxId: sourceId,
});
sandboxState.backupSandboxState = () => {
  events.push({ kind: "backup" });
  if (failPolicyPreflight) return {
    success: true, backedUpDirs: [], failedDirs: [], backedUpFiles: [], failedFiles: [],
    manifest: { backupPath: "/tmp/fixture-pre-delete-backup" },
  };
  return {
    success: false, backedUpDirs: [], failedDirs: [], backedUpFiles: [], failedFiles: [],
    error: "native state archive rejected",
  };
};
childProcess.spawn = () => { throw new Error("unexpected sandbox create"); };
require(${JSON.stringify(path.join(repoRoot, "src/lib/onboard/preflight.ts"))}).checkPortAvailable =
  async () => ({ ok: true });
process.on("exit", () => {
  console.log(JSON.stringify({
    events,
    before,
    after: registry.load(),
    sourceId,
    liveId: live.state.sandboxId,
    providerConfig,
    journal: sessions.loadSession()?.checkpoint?.sandboxRecreate ?? null,
  }));
});
const { createSandbox } = require(${onboardPath});
(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  const args = mocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "new-model", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
    fixture,
  );
  args[15] = {
    ...args[15],
    ...(failPolicyPreflight ? { rebuildPolicySourcePath: "/nonexistent/nemoclaw-pre-delete-policy" } : {}),
    reservePublishedRouteAfterBackup: () => events.push({ kind: "reserve" }),
  };
  await createSandbox(...args);
  throw new Error("failed backup unexpectedly completed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script);
  const result = await runOnboardProcessAsync([scriptPath], {
    cwd: repoRoot,
    env: workspaceEnv(workspace, {
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
      NEMOCLAW_SANDBOX_PREBUILD: "1",
      NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE: "1",
      NVIDIA_INFERENCE_API_KEY: "new-test-key",
      NEMOCLAW_DASHBOARD_PORT: String(
        20_000 + (createHash("sha256").update(scriptPath).digest().readUInt16BE(0) % 10_000),
      ),
    }),
    timeoutMs: 45_000,
    context,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, expectedError);
  const payload = trailingJsonPayload<{
    events: Array<{ kind: string; cmd?: string }>;
    before: unknown;
    after: unknown;
    sourceId: string;
    liveId: string;
    providerConfig: { credential: string };
    journal: unknown;
  }>(result.stdout);
  assert.ok(
    payload.events.some((event) => event.kind === "backup"),
    result.stderr,
  );
  assert.ok(payload.events.every((event) => event.kind !== "reserve"));
  assert.ok(
    payload.events.every((event) => !event.cmd?.includes("sandbox delete")),
    "pre-delete failure must stop before delete",
  );
  assert.deepEqual(payload.after, payload.before);
  assert.equal(payload.liveId, payload.sourceId);
  assert.equal(payload.providerConfig.credential, "old-test-key");
  return payload;
}

it(
  "keeps a ready sandbox published when its pre-delete backup fails (#13018)",
  { timeout: 60_000 },
  async (context) => {
    const payload = await assertSourcePublishedAfterPreDeleteFailure(
      "backup",
      /nemoclaw my-assistant connect/,
      context,
    );
    assert.equal(payload.journal, null);
  },
);

it(
  "keeps a ready sandbox published when policy preflight fails after backup (#13018)",
  { timeout: 60_000 },
  async (context) => {
    await assertSourcePublishedAfterPreDeleteFailure(
      "policy preflight",
      /nemoclaw-pre-delete-policy/,
      context,
    );
  },
);

it(
  "reserves a published route before creating a missing same-name sandbox (#13018)",
  { timeout: 60_000 },
  async (context) => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-missing-recreate-route-");
    context.onTestFinished(() => workspace.remove());
    writeOkOpenshell(workspace.binDir);
    const repoRoot = path.join(import.meta.dirname, "../..");
    const scriptPath = workspace.path("missing-recreate-route.js");
    const modulePath = (module: string) => JSON.stringify(path.join(repoRoot, module));
    const script = String.raw`
const runner = require(${modulePath("src/lib/runner.ts")});
const registry = require(${modulePath("src/lib/state/registry.ts")});
const sandboxState = require(${modulePath("src/lib/state/sandbox.ts")});
const mocks = require(${modulePath("test/helpers/onboard-script-mocks.cjs")});
const childProcess = require("node:child_process");
const commandText = (command) => (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
const events = [];
mocks.mockStandaloneGatewayTeardownAuthority();
mocks.mockManagedStateVolumeOnboardLifecycle();
const live = mocks.createCreatedSandboxFixture({ lifecycleState: "created" });
const sourceId = live.state.sandboxId;
live.delete();
const source = mocks.sandboxLifecycleFixture({
  name: "my-assistant", agent: "openclaw", provider: "nvidia-prod", model: "old-model",
  gatewayName: "nemoclaw", gatewayPort: 8080, gpuEnabled: false,
}, { sandboxId: sourceId });
registry.save({ defaultSandbox: "my-assistant", sandboxes: { "my-assistant": source } });
runner.run = (command) => {
  const cmd = commandText(command);
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox delete")) throw new Error("unexpected sandbox delete");
  const profile = mocks.mockProviderPreparationRun(command, "nemoclaw", "nemoclaw-messaging-v1", false);
  if (profile !== null) return profile;
  return live.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = commandText(command);
  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  const capture = live.capture(command);
  if (capture !== null) return capture;
  if (cmd.includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return mocks.mockOnboardRunCapture(command, { defaultCurlOutput: "ok" }) ?? "";
};
const fixture = mocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant", provider: "nvidia-prod", model: "new-model",
  getSandbox: registry.getSandbox, sourceSandboxId: sourceId,
});
sandboxState.backupSandboxState = () => { throw new Error("unexpected backup of missing sandbox"); };
childProcess.spawn = (command, args) => {
  const cmd = commandText([command, ...(Array.isArray(args) ? args : [])]);
  if (!cmd.includes("sandbox create")) throw new Error("unexpected child process");
  events.push({ kind: "create" });
  console.log(JSON.stringify({
    reachedCreate: true, events, reservation: registry.load().sandboxes["my-assistant"],
  }));
  process.exit(0);
};
require(${modulePath("src/lib/onboard/preflight.ts")}).checkPortAvailable = async () => ({ ok: true });
const { createSandbox } = require(${modulePath("src/lib/onboard.ts")});
(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  const args = mocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "new-model", "nvidia-prod", null, "my-assistant", null, null, null, null, null, null, null, []],
    fixture,
  );
  args[15] = {
    ...args[15],
    reservePublishedRouteAfterBackup: () => {
      registry.reserveSandboxInferenceRoute("my-assistant", {
        provider: "nvidia-prod", model: "new-model", gatewayName: "nemoclaw",
        reservationSessionId: args[14].sessionId,
      });
      events.push({
        kind: "reserve",
        pending: registry.load().sandboxes["my-assistant"]?.pendingRouteReservation === true,
      });
    },
  };
  await createSandbox(...args);
})().catch((error) => {
  console.log(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    events,
    reservation: registry.getSandbox("my-assistant"),
  }));
  process.exitCode = 1;
});
`;
    fs.writeFileSync(scriptPath, script);
    const result = await runOnboardProcessAsync([scriptPath], {
      cwd: repoRoot,
      env: workspaceEnv(workspace, {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
        NEMOCLAW_SANDBOX_PREBUILD: "1",
        NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE: "1",
      }),
      timeoutMs: 45_000,
      context,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = trailingJsonPayload<{
      reachedCreate: boolean;
      events: Array<{ kind: string; cmd?: string; pending?: boolean }>;
      reservation: { pendingRouteReservation?: boolean; model?: string } | null;
    }>(result.stdout);
    assert.equal(payload.reachedCreate, true);
    assert.equal(payload.events.filter((event) => event.kind === "reserve").length, 1);
    assert.equal(payload.events.find((event) => event.kind === "reserve")?.pending, true);
    assert.ok(payload.events.some((event) => event.kind === "create"));
    assert.ok(
      payload.events.findIndex((event) => event.kind === "reserve") <
        payload.events.findIndex((event) => event.kind === "create"),
    );
    assert.ok(payload.events.every((event) => !event.cmd?.includes("sandbox delete")));
    assert.equal(payload.reservation?.model, "new-model");
  },
);
