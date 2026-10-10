// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { HostCliClient } from "../fixtures/clients/host.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

function successfulResult(command: TrustedShellCommand): ShellProbeResult {
  return {
    command: [command.command, ...command.args],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

describe("failed-install Docker discovery", () => {
  it("limits discovery to the failed sandbox and passes redaction and resource bounds", async () => {
    const run = vi.fn(
      async (
        command: TrustedShellCommand,
        _options?: ShellProbeRunOptions,
      ): Promise<ShellProbeResult> => successfulResult(command),
    );
    const host = new HostCliClient({ run });

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-hermes-switch", 1, ["private-token"]);

    expect(
      run.mock.calls.map(([command, options]) => ({
        command: command.command,
        args: command.args,
        options,
      })),
    ).toEqual([
      {
        command: "docker",
        args: [
          "ps",
          "--all",
          "--no-trunc",
          "--filter",
          "label=openshell.ai/sandbox-name=e2e-hermes-switch",
          "--format",
          "{{.ID}}\t{{.Names}}\t{{.Status}}",
        ],
        options: {
          artifactName: "sandbox-container-discovery-label",
          captureLimitBytes: 8_192,
          redactionValues: ["private-token"],
          timeoutMs: 5_000,
        },
      },
      {
        command: "docker",
        args: [
          "ps",
          "--all",
          "--no-trunc",
          "--filter",
          "name=e2e-hermes-switch",
          "--format",
          "{{.ID}}\t{{.Names}}\t{{.Status}}",
        ],
        options: {
          artifactName: "sandbox-container-discovery-name",
          captureLimitBytes: 8_192,
          redactionValues: ["private-token"],
          timeoutMs: 5_000,
        },
      },
    ]);

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-hermes-switch", 0);
    await host.recordSandboxContainerDiscoveryOnFailure("bad/name", 1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not mask the install failure if Docker discovery fails", async () => {
    const run = vi
      .fn(async (command: TrustedShellCommand): Promise<ShellProbeResult> =>
        successfulResult(command),
      )
      .mockRejectedValueOnce(new Error("docker unavailable"));
    const host = new HostCliClient({ run });

    await expect(
      host.recordSandboxContainerDiscoveryOnFailure("e2e-hermes-switch", 1),
    ).resolves.toBe(undefined);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
