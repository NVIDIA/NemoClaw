// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { it } from "vitest";
import {
  createOnboardProcessWorkspace,
  runOnboardProcessAsync,
  trailingJsonPayload,
  workspaceEnv,
} from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

it(
  "keeps a ready sandbox published when its pre-delete backup fails (#13018)",
  { timeout: 60_000 },
  async (context) => {
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
runner.run = (command) => {
  const cmd = commandText(command);
  events.push({ kind: "run", cmd });
  const profile = mocks.mockProviderPreparationRun(command, "nemoclaw", "nemoclaw-mcp-v1", false);
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
        NEMOCLAW_DASHBOARD_PORT: String(
          20_000 + (createHash("sha256").update(scriptPath).digest().readUInt16BE(0) % 10_000),
        ),
      }),
      timeoutMs: 45_000,
      context,
    });
    assert.equal(result.status, 1, result.stderr);
    const payload = trailingJsonPayload<{
      events: Array<{ kind: string; cmd?: string }>;
      before: unknown;
      after: unknown;
      sourceId: string;
      liveId: string;
      journal: unknown;
    }>(result.stdout);
    assert.ok(
      payload.events.some((event) => event.kind === "backup"),
      result.stderr,
    );
    assert.ok(payload.events.every((event) => event.kind !== "reserve"));
    assert.ok(
      payload.events.every((event) => !event.cmd?.includes("sandbox delete")),
      "backup failure must stop before delete",
    );
    assert.deepEqual(payload.after, payload.before);
    assert.equal(payload.liveId, payload.sourceId);
    assert.equal(payload.journal, null);
  },
);
