// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  acpMessageContainsPong,
  createHermesAcpPromptEvidenceTracker,
  hermesAcpExchangeEvidencePassed,
  hermesAcpLiveHostEnv,
  hermesAcpScenarioTimeoutMs,
  isAcpResponse,
  isProcessAbsent,
  runHermesAcpLiveScenario,
} from "../fixtures/hermes-acp-live.ts";

describe("Hermes ACP live evidence boundary", () => {
  it.each(["installed", "checkout"] as const)(
    "initializes through the %s adapter",
    async (installation) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-launch-"));
      const adapterEntrypoint = path.join(artifactDir, "nemoclaw-acp");
      fs.writeFileSync(
        adapterEntrypoint,
        `#!${process.execPath}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
});
`,
        { mode: 0o700 },
      );
      const progress = startTestProgress(
        "ACP adapter launch",
        ["launch adapter", "verify result"],
        {
          logLine: () => undefined,
        },
      );
      onTestFinished(() => {
        progress.stop();
        fs.rmSync(artifactDir, { force: true, recursive: true });
      });
      const sandbox = new SandboxClient({
        run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" }),
      });

      await expect(
        runHermesAcpLiveScenario({
          adapterEntrypoint: installation === "checkout" ? adapterEntrypoint : undefined,
          artifacts: new ArtifactSink(artifactDir),
          env: { PATH: installation === "installed" ? artifactDir : "" },
          progress,
          sandbox,
          sandboxName: "e2e-hermes",
          scenario: "initialize",
        }),
      ).resolves.toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(artifactDir, "hermes-acp-initialize.json"), "utf8")),
      ).toMatchObject({
        passed: true,
        initialized: true,
        exitCode: 0,
        adapterProcessAbsent: true,
        remoteProcessAbsent: true,
        timedOut: false,
      });
    },
    2_000,
  );

  it("records a failed scenario when the adapter executable is missing", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-missing-"));
    const progress = startTestProgress("missing ACP adapter", ["launch adapter", "verify result"], {
      logLine: () => undefined,
    });
    onTestFinished(() => {
      progress.stop();
      fs.rmSync(artifactDir, { force: true, recursive: true });
    });
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    const sandbox = new SandboxClient({ run });

    await expect(
      runHermesAcpLiveScenario({
        artifacts: new ArtifactSink(artifactDir),
        env: { PATH: artifactDir },
        progress,
        sandbox,
        sandboxName: "e2e-hermes",
        scenario: "initialize",
      }),
    ).resolves.toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDir, "hermes-acp-initialize.json"), "utf8")),
    ).toMatchObject({
      passed: false,
      initialized: false,
      adapterProcessAbsent: true,
      remoteProcessAbsent: true,
      timedOut: false,
    });
    expect(run).toHaveBeenCalledOnce();
  }, 2_000);

  it("passes only host runtime settings to the adapter process", () => {
    expect(
      hermesAcpLiveHostEnv({
        HOME: "/tmp/home",
        NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-openshell",
        PATH: "/usr/bin",
        OPENSHELL_GATEWAY: "nemoclaw",
        NVIDIA_INFERENCE_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        OPENSHELL_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-openshell",
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
  });

  it("recognizes only the requested JSON-RPC response", () => {
    expect(isAcpResponse({ jsonrpc: "2.0", id: 3, result: {} }, 3)).toBe(true);
    expect(isAcpResponse({ jsonrpc: "2.0", id: 4, result: {} }, 3)).toBe(false);
    expect(isAcpResponse(["2.0", 3], 3)).toBe(false);
  });

  it("finds the bounded PONG assertion in nested ACP messages", () => {
    expect(acpMessageContainsPong({ params: { update: [{ text: "PONG" }] } })).toBe(true);
    expect(acpMessageContainsPong({ params: { update: [{ text: "SPONGE" }] } })).toBe(false);
  });

  it("counts PONG only after the prompt and only for the selected session (#10947)", () => {
    const evidence = createHermesAcpPromptEvidenceTracker();
    evidence.observe({ jsonrpc: "2.0", id: 1, result: { note: "PONG" } });
    evidence.markPromptWritten("session-a");
    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-b",
        update: { text: "PONG" },
      },
    });
    evidence.observe({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { text: "PONG" } },
    });

    expect(evidence.pongObserved).toBe(false);
    expect(
      hermesAcpExchangeEvidencePassed({
        sessionCreated: true,
        promptCompleted: true,
        pongObserved: evidence.pongObserved,
      }),
    ).toBe(false);

    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-a",
        update: { text: "PONG" },
      },
    });
    expect(evidence.pongObserved).toBe(true);
    expect(
      hermesAcpExchangeEvidencePassed({
        sessionCreated: true,
        promptCompleted: true,
        pongObserved: evidence.pongObserved,
      }),
    ).toBe(true);
  });

  it.each(["cancel", "initialize"] as const)(
    "does not start the later %s scenario after the shared ACP deadline expires (#10947)",
    async (scenario) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-deadline-"));
      try {
        const artifacts = new ArtifactSink(artifactDir);
        const forbidden = new Proxy(
          {},
          {
            get() {
              throw new Error("an expired ACP scenario must not reach process or sandbox helpers");
            },
          },
        );

        expect(hermesAcpScenarioTimeoutMs(1_000_000, 0)).toBe(180_000);
        expect(hermesAcpScenarioTimeoutMs(100_000, 0)).toBe(100_000);
        expect(hermesAcpScenarioTimeoutMs(1_000, 1_001)).toBeNull();
        await expect(
          runHermesAcpLiveScenario({
            artifacts,
            deadlineAtMs: 1_000,
            env: {},
            now: () => 1_001,
            progress: forbidden as never,
            sandbox: forbidden as never,
            sandboxName: "e2e-hermes",
            scenario,
          }),
        ).resolves.toBe(false);
        const receipt = JSON.parse(
          fs.readFileSync(path.join(artifactDir, `hermes-acp-${scenario}.json`), "utf8"),
        ) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          deadlineExpired: true,
          passed: false,
          scenario,
          scenarioStarted: false,
        });
      } finally {
        fs.rmSync(artifactDir, { force: true, recursive: true });
      }
    },
  );

  it("classifies the live adapter process state", () => {
    expect(isProcessAbsent(undefined)).toBe(true);
    expect(isProcessAbsent(process.pid)).toBe(false);
  });
});
