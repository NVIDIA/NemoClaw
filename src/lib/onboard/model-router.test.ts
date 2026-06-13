// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  doesModelRouterProcessOwnPort,
  isModelRouterCommandLineForPort,
  readModelRouterProcessCommandLine,
  stopTrackedModelRouterForAgentChange,
} from "../../../dist/lib/onboard/model-router-process";

describe("model-router process ownership checks", () => {
  it("recognizes model-router proxy command lines for the expected port", () => {
    expect(
      isModelRouterCommandLineForPort(
        ["/tmp/router/bin/model-router", "proxy", "--host", "0.0.0.0", "--port", "44123"],
        44123,
      ),
    ).toBe(true);
    expect(
      isModelRouterCommandLineForPort(
        ["/tmp/router/bin/model-router", "proxy", "--host", "0.0.0.0", "--port=44123"],
        44123,
      ),
    ).toBe(true);
  });

  it("recognizes Python-interpreted model-router venv command lines (#5169)", () => {
    expect(
      isModelRouterCommandLineForPort(
        [
          "/home/user/.nemoclaw/model-router-venv/bin/python",
          "/home/user/.nemoclaw/model-router-venv/bin/model-router",
          "proxy",
          "--port",
          "4000",
        ],
        4000,
      ),
    ).toBe(true);
  });

  it("falls back to ps-style command lines when /proc is unavailable", () => {
    expect(
      readModelRouterProcessCommandLine(1234, {
        readProcCommandLine: () => null,
        readPsCommandLine: () => ["/tmp/router/bin/model-router", "proxy", "--port", "44123"],
      }),
    ).toEqual(["/tmp/router/bin/model-router", "proxy", "--port", "44123"]);
  });

  it("skips agent-change stop when the recorded PID is not an owned model-router", async () => {
    let stopped = false;
    await stopTrackedModelRouterForAgentChange({ routerPid: 1234 }, 44123, {
      isRunning: () => true,
      readCommandLine: () => ["/usr/bin/sleep", "999"],
      stopProcess: async () => {
        stopped = true;
      },
    });
    expect(stopped).toBe(false);
  });

  it("stops the recorded router on agent change only after ownership is established", async () => {
    const stopped: Array<[number, number]> = [];
    await stopTrackedModelRouterForAgentChange({ routerPid: 1234 }, 44123, {
      isRunning: () => true,
      readCommandLine: () => ["/tmp/router/bin/model-router", "proxy", "--port", "44123"],
      stopProcess: async (pid, port) => {
        stopped.push([pid, port]);
      },
    });
    expect(stopped).toEqual([[1234, 44123]]);
  });

  it("rejects reused PIDs that do not look like the expected model-router proxy", () => {
    expect(
      doesModelRouterProcessOwnPort(1234, 44123, {
        isRunning: () => true,
        readCommandLine: () => ["/usr/bin/sleep", "999"],
      }),
    ).toBe(false);
    expect(
      doesModelRouterProcessOwnPort(1234, 44123, {
        isRunning: () => true,
        readCommandLine: () => ["/tmp/router/bin/model-router", "proxy", "--port", "44124"],
      }),
    ).toBe(false);
  });
});
