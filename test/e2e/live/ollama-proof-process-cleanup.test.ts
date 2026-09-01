// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  createOllamaProofProcessFixture,
  disposeOllamaProofProcessFixture,
  fixtureProcessIdentityMatches,
  runOllamaProofProcessFixture,
  waitForOllamaProofProcessExit,
} from "./ollama-proof-process-cleanup-helpers.ts";

const LIVE_TIMEOUT_MS = 30_000;

test.runIf(process.platform === "linux" && process.getuid !== undefined)(
  "systemd stops every descendant after the Ollama execution proof reaches its runtime limit",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the systemd transient-service boundary",
        "run a proof with a persistent descendant",
        "verify timeout classification and descendant cleanup",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress }) => {
    await artifacts.target.declare({
      id: "ollama-proof-process-cleanup",
      boundary: "real sudo + systemd transient service + test-owned process tree",
      contracts: [
        "the systemd runtime limit ends the proof before the outer runner timeout",
        "the proof returns execution-timeout",
        "the proof descendant is absent when the caller regains control",
      ],
    });

    const numericUserId = process.getuid?.() ?? -1;
    progress.phase("confirm the systemd transient-service boundary");
    const prerequisite = await host.command(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/systemd-run", "--version"],
      {
        artifactName: "phase-1-systemd-run-version",
        timeoutMs: 10_000,
      },
    );
    expect(prerequisite.exitCode, resultText(prerequisite)).toBe(0);

    const fixture = createOllamaProofProcessFixture();
    cleanup.trackDisposable("stop the proof fixture and remove its files", () => {
      disposeOllamaProofProcessFixture(fixture);
    });

    progress.phase("run a proof with a persistent descendant");
    const serviceUser = String(numericUserId);
    const { durationMs, proof, systemdResult } = runOllamaProofProcessFixture(fixture, serviceUser);

    progress.phase("verify timeout classification and descendant cleanup");
    expect(proof).toMatchObject({ classification: "execution-timeout", ok: false });
    expect(systemdResult).toMatchObject({ timedOut: false });
    expect(systemdResult?.exitCode).not.toBe(0);
    expect(systemdResult?.stderr).toMatch(/^\s*Finished with result: timeout\s*$/mu);
    expect(durationMs).toBeLessThan(17_000);
    expect(fs.existsSync(fixture.pidPath)).toBe(true);
    fixture.childPid = Number.parseInt(fs.readFileSync(fixture.pidPath, "utf8").trim(), 10);
    expect(Number.isSafeInteger(fixture.childPid) && fixture.childPid > 1).toBe(true);
    await waitForOllamaProofProcessExit(fixture);
    expect(fixtureProcessIdentityMatches(fixture)).toBe(false);
    await artifacts.writeJson("ollama-proof-process-cleanup.json", {
      childPid: fixture.childPid,
      durationMs,
      result: proof.ok ? "unexpected-success" : proof.classification,
      systemdExitCode: systemdResult?.exitCode,
      systemdRunnerTimedOut: systemdResult?.timedOut,
    });
    await artifacts.target.complete({ id: "ollama-proof-process-cleanup", status: "passed" });
  },
);
