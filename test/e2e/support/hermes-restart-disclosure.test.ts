// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { qualifyAgent } from "../live/managed-image-activation-e2e-helpers.ts";

const ok = {
  command: ["fixture"],
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "PONG",
  stderr: "",
  artifacts: { stdout: "", stderr: "", result: "" },
};

function refusal(forbiddenOutputDetected?: boolean) {
  return {
    ...ok,
    exitCode: 1,
    stdout: "secret-boundary refusal [REDACTED]",
    forbiddenOutputDetected,
  };
}

describe("Hermes restart disclosure evidence", () => {
  it.each([
    {
      scenario: "detected raw disclosure",
      restart: async () => refusal(true),
      expectedError: "expected false to be true",
      stopExpected: false,
    },
    {
      scenario: "missing raw-output evidence",
      restart: async () => refusal(),
      expectedError: "expected false to be true",
      stopExpected: false,
    },
    {
      scenario: "confirmed absence",
      restart: async () => refusal(false),
      expectedError: "reached public stop",
      stopExpected: true,
    },
    {
      scenario: "restart spawn failure",
      restart: async () => {
        throw new Error("restart spawn failed");
      },
      expectedError: "restart spawn failed",
      stopExpected: false,
    },
  ])("restores state and checks $scenario", async ({ restart, expectedError, stopExpected }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-boundary-"));
    const events: string[] = [];
    const execShell = vi.fn(
      async (_name: string, _script: string, options: { artifactName: string }) => {
        events.push(options.artifactName);
        return ok;
      },
    );
    const nemoclaw = vi
      .fn<HostCliClient["nemoclaw"]>()
      .mockResolvedValueOnce(ok)
      .mockImplementationOnce(restart)
      .mockRejectedValue(new Error("reached public stop"));
    try {
      await expect(
        qualifyAgent(
          {
            artifacts: new ArtifactSink(directory),
            cleanup: { trackDisposable: vi.fn(), trackSandbox: vi.fn() },
            host: {
              command: vi.fn(async () => ok),
              nemoclaw,
              bestEffortCleanupSandbox: vi.fn(),
              cleanupGatewayRegistration: vi.fn(),
            },
            lifecycle: { stopGatewayRuntime: vi.fn() },
            progress: { phase: vi.fn() },
            sandbox: { cleanupSandbox: vi.fn(), exec: vi.fn(async () => ok), execShell },
          } as never,
          { env: {} } as never,
          "/unused-catalog.json",
          "http://inference.invalid/v1",
          "hermes",
          {} as never,
        ),
      ).rejects.toThrow(expectedError);
      expect(events.slice(0, 2)).toEqual([
        "hermes-poison-env-before-native-restart",
        "hermes-restore-env-after-native-restart-refusal",
      ]);
      expect(nemoclaw).toHaveBeenNthCalledWith(
        2,
        ["mi-act-hermes", "gateway", "restart", "--quiet"],
        expect.objectContaining({ forbiddenOutputValues: ["SENTINEL_MANAGED_RESTART_RAW_SECRET"] }),
      );
      expect(nemoclaw.mock.calls.some(([args]) => args?.[1] === "stop")).toBe(stopExpected);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
