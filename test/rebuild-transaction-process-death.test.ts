// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RebuildTransactionStore } from "../src/lib/state/rebuild-transaction";

const roots: string[] = [];
const childTest = "test/fixtures/rebuild-transaction-process-child.test.ts";
const vitest = path.resolve("node_modules/vitest/vitest.mjs");

function runChild(
  env: NodeJS.ProcessEnv,
  waitForMarker: boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, "run", "--project", "integration", childTest], {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let killed = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      waitForMarker &&
        !killed &&
        output.includes("[e2e] Rebuild interruption point") &&
        (killed = process.kill(-child.pid!, "SIGKILL"));
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
    setTimeout(() => {
      child.exitCode === null &&
        child.signalCode === null &&
        (process.kill(-child.pid!, "SIGKILL"),
        reject(new Error(`Timed out waiting for rebuild child:\n${output}`)));
    }, 50_000).unref();
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rebuild process-death recovery", () => {
  for (const phase of ["prepared", "delete_unjournaled"] as const) {
    it(`recovers after SIGKILL at ${phase} without deleting twice`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-process-"));
      roots.push(root);
      const stateDir = path.join(root, "state");
      const eventsFile = path.join(root, "events.log");
      const replacementFile = path.join(root, "replacement.json");
      const fixtureEnv = {
        ...process.env,
        HOME: root,
        NEMOCLAW_REBUILD_PROCESS_FIXTURE: root,
        NEMOCLAW_REBUILD_PROCESS_PHASE: phase,
        NEMOCLAW_REBUILD_PROCESS_STATE_DIR: stateDir,
        NEMOCLAW_REBUILD_PROCESS_EVENTS: eventsFile,
        NEMOCLAW_REBUILD_PROCESS_REPLACEMENT: replacementFile,
      };
      const interrupted = await runChild(
        {
          ...fixtureEnv,
          NEMOCLAW_REBUILD_PROCESS_ROLE: "interrupt",
          NEMOCLAW_E2E_FAILURE_INJECTION: "1",
          NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: `rebuild_${phase}`,
        },
        true,
      );
      expect(interrupted.signal, interrupted.output).toBe("SIGKILL");

      const resumeEnv: NodeJS.ProcessEnv = {
        ...fixtureEnv,
        NEMOCLAW_REBUILD_PROCESS_ROLE: "resume",
      };
      delete resumeEnv.NEMOCLAW_E2E_FAILURE_INJECTION;
      delete resumeEnv.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP;
      const resumed = await runChild(resumeEnv, false);

      expect(resumed.code, resumed.output).toBe(0);
      const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
      expect(events.filter((event) => event === "delete")).toHaveLength(1);
      expect(events.filter((event) => event.startsWith("onboard:"))).toHaveLength(1);
      expect(new RebuildTransactionStore({ stateDir }).load("alpha")).toMatchObject({
        status: "completed",
        phase: "completed",
      });
    }, 120_000);
  }

  for (const phase of [
    "replacement_unjournaled",
    "replacement_created",
    "state_restored",
    "required_verified",
  ] as const) {
    it(`converges after SIGKILL at ${phase} without duplicate replacement creation (#6436)`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-process-"));
      roots.push(root);
      const stateDir = path.join(root, "state");
      const eventsFile = path.join(root, "events.log");
      const replacementFile = path.join(root, "replacement.json");
      const fixtureEnv = {
        ...process.env,
        HOME: root,
        NEMOCLAW_REBUILD_PROCESS_FIXTURE: root,
        NEMOCLAW_REBUILD_PROCESS_PHASE: phase,
        NEMOCLAW_REBUILD_PROCESS_STATE_DIR: stateDir,
        NEMOCLAW_REBUILD_PROCESS_EVENTS: eventsFile,
        NEMOCLAW_REBUILD_PROCESS_REPLACEMENT: replacementFile,
      };
      const interrupted = await runChild(
        {
          ...fixtureEnv,
          NEMOCLAW_REBUILD_PROCESS_ROLE: "interrupt",
          NEMOCLAW_E2E_FAILURE_INJECTION: "1",
          NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: `rebuild_${phase}`,
        },
        true,
      );
      expect(interrupted.signal, interrupted.output).toBe("SIGKILL");

      const resumeEnv: NodeJS.ProcessEnv = {
        ...fixtureEnv,
        NEMOCLAW_REBUILD_PROCESS_ROLE: "resume",
      };
      delete resumeEnv.NEMOCLAW_E2E_FAILURE_INJECTION;
      delete resumeEnv.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP;
      const resumed = await runChild(resumeEnv, false);

      expect(resumed.code, resumed.output).toBe(0);
      const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
      expect(events.filter((event) => event === "delete")).toHaveLength(1);
      expect(events.filter((event) => event.startsWith("onboard:"))).toHaveLength(1);
      expect(events.filter((event) => event === "restore")).toHaveLength(
        phase === "state_restored" || phase === "required_verified" ? 2 : 1,
      );
      expect(events).toContain("onboard:interrupt");
      expect(events).not.toContain("onboard:resume");
      expect(new RebuildTransactionStore({ stateDir }).load("alpha")).toMatchObject({
        status: "completed",
        phase: "completed",
      });
    }, 120_000);
  }
});
