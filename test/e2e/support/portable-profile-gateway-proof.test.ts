// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import * as observedChild from "../fixtures/observed-child-process.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  recordPortableSandboxDiagnostics,
  verifyPinnedPodmanGatewayStarts,
} from "../live/portable-profile-gateway-proof.ts";

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: vi.fn(),
}));

const id = "a".repeat(64);
const socketPath = "/run/user/1002/podman/podman.sock";
const logsArgs = ["--url", `unix://${socketPath}`, "logs", id];
const callbackFailure = new Error("sandbox entered Error");

test("does not inspect containers after sandbox creation succeeds (#12603)", () => {
  recordPortableSandboxDiagnostics(socketPath, "hermes-portable-e2e", 0);
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
});

test.each([
  { status: 0, remainingCalls: [logsArgs], output: /sandbox startup failure/u },
  { status: 1, remainingCalls: [], output: /Sandbox diagnostic inventory \(status 1\)/u },
])(
  "captures only selected fixture logs after inventory status $status (#12603)",
  ({ status, remainingCalls, output }) => {
    const secret = `nvapi-${"fixture".repeat(4)}`;
    const capture = vi
      .mocked(childProcess.spawnSync)
      .mockReturnValueOnce({
        status,
        stdout: `${id}\nnot-an-id\n`,
        stderr: "",
        pid: 1,
        signal: null,
        output: [],
      })
      .mockReturnValue({
        status: 1,
        stdout: "sandbox startup failure",
        stderr: `Bearer ${secret}`,
        pid: 1,
        signal: null,
        output: [],
      });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordPortableSandboxDiagnostics(socketPath, "hermes-portable-e2e", 1);
    expect(capture).toHaveBeenCalledTimes(remainingCalls.length + 1);
    expect(capture.mock.calls[0]?.[1]).toEqual([
      "--url",
      "unix:///run/user/1002/podman/podman.sock",
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/sandbox-name=hermes-portable-e2e",
      "--format",
      "{{.ID}}",
    ]);
    expect(capture.mock.calls.slice(1).map((call) => call[1])).toEqual(remainingCalls);
    expect(diagnostic.mock.calls.flat().join("\n")).toMatch(output);
    expect(diagnostic.mock.calls.flat().join("\n")).not.toContain(secret);
  },
);

test.each([
  { fails: false, callback: async () => undefined },
  {
    fails: true,
    callback: async () => {
      throw callbackFailure;
    },
  },
])(
  "retains callback failure diagnostics without changing gateway cleanup (failure=$fails) (#12603)",
  async ({ fails, callback }) => {
    vi.useFakeTimers();
    const progress = startTestProgress("gateway diagnostic", ["run gateway", "check result"], {
      logLine: () => undefined,
    });
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.spyOn(observedChild, "spawnObservedChild").mockReturnValue(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = `nvapi-${"fixture".repeat(4)}`;
    try {
      const result = verifyPinnedPodmanGatewayStarts(
        "openshell-gateway",
        {},
        progress,
        async () => {
          child.stderr?.emit("data", `compute rejected; authorization: Bearer ${secret}\n`);
          await callback();
        },
      );
      const checked = fails
        ? expect(result).rejects.toBe(callbackFailure)
        : expect(result).resolves.toBeUndefined();
      child.stdout.emit("data", "Using compute driver driver=podman\n");
      await vi.advanceTimersByTimeAsync(2200);
      await checked;
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("compute rejected"),
      );
      expect(diagnostic.mock.calls.flat().join("\n")).not.toContain(secret);
    } finally {
      progress.stop();
      child.stdout.destroy();
      child.stderr.destroy();
      vi.useRealTimers();
    }
  },
);
