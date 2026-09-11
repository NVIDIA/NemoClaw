// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import * as observedChild from "../fixtures/observed-child-process.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  acpMessageContainsPong,
  createHermesAcpPromptEvidenceTracker,
  hermesAcpExchangeEvidencePassed,
  hermesAcpLiveHostEnv,
  hermesAcpScenarioTimeoutMs,
  isAcpResponse,
  isProcessAbsent,
  runHermesAcpLiveScenario,
  writeRequest,
} from "../fixtures/hermes-acp-live.ts";

describe("Hermes ACP live evidence boundary", () => {
  it("passes only host runtime settings to the adapter process", () => {
    expect(
      hermesAcpLiveHostEnv({
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        OPENSHELL_GATEWAY: "nemoclaw",
        NVIDIA_INFERENCE_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        OPENSHELL_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      }),
    ).toEqual({
      HOME: "/tmp/home",
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

  it("rejects requests after the adapter input has closed", async () => {
    const input = new PassThrough();
    input.destroy();
    await once(input, "close");
    let submitted = false;
    expect(
      await writeRequest(input, { id: 1 }, () => {
        submitted = true;
      }),
    ).toBe(false);
    expect(submitted).toBe(false);
  });

  it.each([
    ["close", undefined],
    ["error", new Error("input failed")],
  ] as const)("settles a blocked request after adapter input %s", async (_event, error) => {
    const input = new PassThrough({ highWaterMark: 1 });
    const pending = writeRequest(input, { id: 1 });
    input.destroy(error);
    await expect(pending).resolves.toBe(false);
  });

  it("marks a request once and completes after backpressure drains", async () => {
    let release!: () => void;
    const input = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        release = done;
      },
    });
    let submissions = 0;
    const pending = writeRequest(input, { id: 1 }, () => {
      submissions += 1;
    });
    expect(submissions).toBe(1);
    release();
    await expect(pending).resolves.toBe(true);
    input.destroy();
  });

  it("checks the UTF-8 request limit before writing to the adapter", async () => {
    let writes = 0;
    const input = new Writable({
      write(_chunk, _encoding, done) {
        writes += 1;
        done();
      },
    });
    expect(await writeRequest(input, { text: "😀".repeat(4096) })).toBe(false);
    expect(writes).toBe(0);
    input.destroy();
  });

  it("launches the compiled ACP entrypoint with the current Node runtime", async () => {
    const launch = vi.spyOn(observedChild, "spawnObservedChild").mockImplementation(() => {
      throw new Error("captured launch");
    });
    try {
      await expect(
        runHermesAcpLiveScenario({
          artifacts: {} as never,
          deadlineAtMs: 180_000,
          env: { PATH: "" },
          now: () => 0,
          progress: {} as never,
          sandbox: {} as never,
          sandboxName: "e2e-hermes",
          scenario: "initialize",
        }),
      ).rejects.toThrow("captured launch");
      expect(launch.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(launch.mock.calls[0]?.[1]?.[0]).toBe(
        path.join(REPO_ROOT, "dist", "lib", "acp", "main.js"),
      );
    } finally {
      launch.mockRestore();
    }
  });
});
