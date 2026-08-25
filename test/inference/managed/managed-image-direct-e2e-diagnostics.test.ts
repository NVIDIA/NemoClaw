// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  collectManagedImageDirectTimeoutDiagnostic,
  type ManagedImageDirectDiagnosticCommand,
} from "../../../scripts/checks/run-managed-image-direct-e2e";

const CONTAINER_ID = "a".repeat(64);

function diagnosticCommand(options: {
  readonly completion: "absent" | "empty" | "present";
  readonly forwardedCommand: "absent" | "empty" | "present";
  readonly containerState: string;
}): ManagedImageDirectDiagnosticCommand {
  const results = new Map([
    ["inspect", { status: 0, stdout: `${options.containerState}\n`, stderr: "" }],
    [
      "exec",
      {
        status: 0,
        stdout: `${options.completion}\n${options.forwardedCommand}\n`,
        stderr: "",
      },
    ],
  ]);
  return (args) => results.get(args[0] ?? "") ?? unexpectedDiagnosticCommand(args);
}

function unexpectedDiagnosticCommand(args: readonly string[]): never {
  throw new Error(`unexpected diagnostic command: ${args.join(" ")}`);
}

describe("managed-image direct E2E timeout diagnostics", () => {
  it("reports a completed startup before the forwarded command marker", () => {
    expect(
      collectManagedImageDirectTimeoutDiagnostic(
        CONTAINER_ID,
        diagnosticCommand({
          completion: "present",
          forwardedCommand: "absent",
          containerState: "running",
        }),
      ),
    ).toEqual({
      completionMarker: "present",
      forwardedCommandMarker: "absent",
      containerState: "running",
      managedStartupStage: "waiting-for-forwarded-command",
    });
  });

  it("excludes unrecognized command output from the diagnostic", () => {
    const secret = "not-for-diagnostics";
    const command: ManagedImageDirectDiagnosticCommand = () => ({
      status: 0,
      stdout: `running-${secret}\n`,
      stderr: secret,
    });

    const diagnostic = collectManagedImageDirectTimeoutDiagnostic(CONTAINER_ID, command);

    expect(diagnostic).toEqual({
      completionMarker: "unavailable",
      forwardedCommandMarker: "unavailable",
      containerState: "unavailable",
      managedStartupStage: "diagnostic-unavailable",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });
});
