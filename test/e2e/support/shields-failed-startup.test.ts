// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  failedStartupProcessControlCommands,
  resumeSupervisorIfPaused,
} from "../fixtures/shields-failed-startup.ts";

describe("Shields failed-startup process control", () => {
  it("builds host-side PID 1 signals and an in-sandbox child termination signal", () => {
    expect(failedStartupProcessControlCommands("abc123def456", 44)).toEqual({
      pauseSupervisor: ["kill", "--signal", "SIGSTOP", "abc123def456"],
      resumeSupervisor: ["kill", "--signal", "SIGCONT", "abc123def456"],
      terminateStartupChild: ["exec", "--user", "0", "abc123def456", "kill", "-TERM", "44"],
    });
  });

  it("runs the resume callback only when the supervisor was paused", async () => {
    const events: string[] = [];
    const resume = async () => {
      events.push("resume");
    };

    await resumeSupervisorIfPaused(false, resume);
    await resumeSupervisorIfPaused(true, resume);

    expect(events).toEqual(["resume"]);
  });

  it.each([
    0,
    1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects unsafe startup child pid %s", (pid) => {
    expect(() => failedStartupProcessControlCommands("abc123def456", pid)).toThrow(
      "startup child pid must be a safe integer greater than 1",
    );
  });

  it.each([
    "",
    "-latest",
    "container id",
    "container/id",
  ])("rejects unsafe Docker container id %s", (containerId) => {
    expect(() => failedStartupProcessControlCommands(containerId, 44)).toThrow(
      "container id must be a safe Docker identifier",
    );
  });
});
