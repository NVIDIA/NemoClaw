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
    },
    {
      name: "removes a foreign-session pending route reservation before a not-ready recreate",
      reservationSessionId: "session-other",
      expectedRemoval: true,
    },
    {
      name: "removes an unstamped pending route reservation before a not-ready recreate",
      reservationSessionId: null,
      expectedRemoval: true,
    },
  ] as const)(
    "$name (#6562)",
    { timeout: 60_000 },
    async ({ reservationSessionId, expectedRemoval }) => {
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
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName: "my-assistant",
  lifecycleState: "created",
  phase: "NotReady",
});
runner.run = (command) => {
  const cmd = _n(command);
  events.push({ kind: "run", cmd });
  const profileResult = require(${onboardScriptMocksPath}).mockManagedEndpointlessProviderProfileRun(command);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox delete")) {
    createdSandbox.delete();
    return { status: 0 };
  }
  const sandboxResult = createdSandbox.run(command);
  return sandboxResult ?? { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
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

onboardSession.loadSession = () => ({ sessionId: "session-owner" });

const reservationSessionId = ${JSON.stringify(reservationSessionId)};
let sourceEntry = {
  name: "my-assistant",
  gpuEnabled: false,
  pendingRouteReservation: true,
  ...(reservationSessionId === null ? {} : { reservationSessionId }),
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
  getSandbox: registry.getSandbox,
  removeSandbox,
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
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  if (command.includes("sandbox create")) {
    createdSandbox.recreate(args.flat());
    createdSandbox.setPhase("Ready");
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4246;
  events.push({ kind: "spawn", cmd: command });
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
  console.log(JSON.stringify({ sandboxName, events }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
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

      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const payload = trailingJsonPayload<{
        sandboxName: string;
        events: Array<{ kind: string; cmd?: string; name?: string }>;
      }>(result.stdout);
      assert.equal(payload.sandboxName, "my-assistant");

      const events = payload.events;
      const removedReservation = events.some(
        (e) => e.kind === "removeSandbox" && e.name === "my-assistant",
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
    },
  );
});
