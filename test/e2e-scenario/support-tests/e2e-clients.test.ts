// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ProviderClient, trustedProviderEndpoint } from "../fixtures/clients/provider.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

function shellResult(command: TrustedShellCommand): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [command.command, ...command.args],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "204",
    timedOut: false,
  };
}

function providerClientWithCalls(
  calls: Array<{ command: TrustedShellCommand; options?: ShellProbeRunOptions }>,
) {
  return new ProviderClient({
    run: async (command, options) => {
      calls.push({ command, options });
      return shellResult(command);
    },
  });
}

describe("E2E provider client boundaries", () => {
  it("builds reachability probes from a trusted endpoint capability", async () => {
    const calls: Array<{ command: TrustedShellCommand; options?: ShellProbeRunOptions }> = [];
    const provider = providerClientWithCalls(calls);

    const result = await provider.probeReachability(
      trustedProviderEndpoint("https://inference-api.nvidia.com/v1", {
        allowedHosts: ["inference-api.nvidia.com"],
      }),
      { artifactName: "probe" },
    );

    expect(result.stdout).toBe("204");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command.command).toBe("curl");
    expect(calls[0]?.command.args).toEqual([
      "-sS",
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "https://inference-api.nvidia.com/v1",
    ]);
  });

  it("rejects link-local metadata endpoints before reachability probes can be built", () => {
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /private or link-local|blocked/,
    );
  });

  it("rejects blocked metadata hostnames before reachability probes can be built", () => {
    expect(() =>
      trustedProviderEndpoint("https://metadata.google.internal/computeMetadata/v1"),
    ).toThrow(/blocked/);
  });
});
