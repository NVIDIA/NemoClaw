// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";

const repoRoot = path.join(import.meta.dirname, "..");
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
  ] as const)("$name (#6562)", { timeout: 60_000 }, async ({
    reservationSessionId,
    expectedRemoval,
  }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reservation-survives-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reservation-survives.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const onboardSessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const onboardSession = require(${onboardSessionPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
let sandboxDeleted = false;
runner.run = (command) => {
  const cmd = _n(command);
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  return { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("sandbox get my-assistant")) return "my-assistant";
  if (cmd.includes("sandbox list")) {
    return sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
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

onboardSession.loadSession = () => ({ sessionId: "session-owner" });

const reservationSessionId = ${JSON.stringify(reservationSessionId)};
registry.getSandbox = () => ({
  name: "my-assistant",
  gpuEnabled: false,
  pendingRouteReservation: true,
  ...(reservationSessionId === null ? {} : { reservationSessionId }),
});
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = (name) => {
  events.push({ kind: "removeSandbox", name });
  return true;
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
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
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
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
    assert.equal(payload.sandboxName, "my-assistant");

    const events = payload.events as Array<{ kind: string; cmd?: string; name?: string }>;
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
  });
});
