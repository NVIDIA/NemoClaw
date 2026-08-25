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
  readonly markerStatus?: number;
}): ManagedImageDirectDiagnosticCommand {
  const results = new Map([
    ["inspect", { status: 0, stdout: `${options.containerState}\n`, stderr: "" }],
    [
      "exec",
      {
        status: options.markerStatus ?? 0,
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
  it.each([
    {
      name: "container-not-running",
      input: {
        completion: "absent" as const,
        forwardedCommand: "absent" as const,
        containerState: "exited",
      },
      expected: {
        completionMarker: "unavailable",
        forwardedCommandMarker: "unavailable",
        containerState: "exited",
        managedStartupStage: "container-not-running",
      },
    },
    {
      name: "diagnostic-unavailable",
      input: {
        completion: "present" as const,
        forwardedCommand: "present" as const,
        containerState: "running",
        markerStatus: 1,
      },
      expected: {
        completionMarker: "unavailable",
        forwardedCommandMarker: "unavailable",
        containerState: "running",
        managedStartupStage: "diagnostic-unavailable",
      },
    },
    {
      name: "marker-order-invalid",
      input: {
        completion: "absent" as const,
        forwardedCommand: "present" as const,
        containerState: "running",
      },
      expected: {
        completionMarker: "absent",
        forwardedCommandMarker: "present",
        containerState: "running",
        managedStartupStage: "marker-order-invalid",
      },
    },
    {
      name: "waiting-for-startup-completion",
      input: {
        completion: "absent" as const,
        forwardedCommand: "absent" as const,
        containerState: "running",
      },
      expected: {
        completionMarker: "absent",
        forwardedCommandMarker: "absent",
        containerState: "running",
        managedStartupStage: "waiting-for-startup-completion",
      },
    },
    {
      name: "waiting-for-forwarded-command",
      input: {
        completion: "present" as const,
        forwardedCommand: "absent" as const,
        containerState: "running",
      },
      expected: {
        completionMarker: "present",
        forwardedCommandMarker: "absent",
        containerState: "running",
        managedStartupStage: "waiting-for-forwarded-command",
      },
    },
    {
      name: "markers-complete",
      input: {
        completion: "present" as const,
        forwardedCommand: "present" as const,
        containerState: "running",
      },
      expected: {
        completionMarker: "present",
        forwardedCommandMarker: "present",
        containerState: "running",
        managedStartupStage: "markers-complete",
      },
    },
  ])("reports $name", ({ input, expected }) => {
    expect(
      collectManagedImageDirectTimeoutDiagnostic(CONTAINER_ID, diagnosticCommand(input)),
    ).toEqual(expected);
  });

  it("excludes unrecognized marker output from the diagnostic", () => {
    const secret = "not-for-diagnostics";
    const command: ManagedImageDirectDiagnosticCommand = (args) =>
      args[0] === "inspect"
        ? { status: 0, stdout: "running\n", stderr: "" }
        : { status: 0, stdout: `present\n${secret}\n`, stderr: secret };

    const diagnostic = collectManagedImageDirectTimeoutDiagnostic(CONTAINER_ID, command);

    expect(diagnostic).toEqual({
      completionMarker: "unavailable",
      forwardedCommandMarker: "unavailable",
      containerState: "running",
      managedStartupStage: "diagnostic-unavailable",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });
});
