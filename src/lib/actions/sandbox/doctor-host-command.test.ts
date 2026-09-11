// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { captureHostCommand, captureOpenShellHostCommand } from "./doctor-host-command";

describe("captureHostCommand", () => {
  it("treats signal-terminated processes as failed", () => {
    const result = captureHostCommand(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);

    expect(result.status).not.toBe(0);
  });
});

describe("captureOpenShellHostCommand", () => {
  it("resolves the admitted executable and forwards the lifecycle environment", () => {
    const environment = {
      ...process.env,
      NEMOCLAW_OPENSHELL_BIN: process.execPath,
      NEMOCLAW_LIFECYCLE_CAPTURE_PROBE: "captured",
    };

    expect(
      captureOpenShellHostCommand(
        ["-e", "process.stdout.write(process.env.NEMOCLAW_LIFECYCLE_CAPTURE_PROBE ?? '')"],
        environment,
        5_000,
      ),
    ).toMatchObject({ status: 0, output: "captured" });
  });

  it("fails closed when no absolute executable can be resolved", () => {
    expect(
      captureOpenShellHostCommand([], {}, 5_000, { resolveExecutable: () => null }),
    ).toMatchObject({ status: 1, output: "OpenShell is unavailable" });
  });
});
