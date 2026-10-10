// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HostCliClient, type CommandRunner } from "../fixtures/clients/index.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { buildProviderRoutedEnv } from "../live/model-router-provider-routed-inference-helpers.ts";

describe("Model Router provider-routed live support", () => {
  it("builds the routed onboard environment with both NVIDIA credential names", () => {
    expect(buildProviderRoutedEnv("nvapi-public-test-key", "e2e-router", {})).toMatchObject({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER_KEY: "nvapi-public-test-key",
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PROVIDER: "routed",
      NEMOCLAW_SANDBOX_NAME: "e2e-router",
    });
  });

  it("bounds and redacts container discovery only after routed onboarding fails", async () => {
    const calls: { command: string; args: string[]; options?: ShellProbeRunOptions }[] = [];
    const runner: CommandRunner = {
      async run(command, options) {
        calls.push({ command: command.command, args: [...command.args], options });
        return {
          command: [command.command, ...command.args],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          artifacts: { stdout: "", stderr: "", result: "" },
        };
      },
    };
    const host = new HostCliClient(runner);

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-model-router", 0);
    await host.recordSandboxContainerDiscoveryOnFailure("../foreign", 1);
    expect(calls).toEqual([]);

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-model-router", 1, ["private-key"]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining(
        [
          ["label", "label=openshell.ai/sandbox-name=e2e-model-router"],
          ["name", "name=e2e-model-router"],
        ].map(([kind, filter]) => ({
          command: "docker",
          args: [
            "ps",
            "--all",
            "--no-trunc",
            "--filter",
            filter,
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Status}}",
          ],
          options: {
            artifactName: `sandbox-container-discovery-${kind}`,
            captureLimitBytes: 8_192,
            redactionValues: ["private-key"],
            timeoutMs: 5_000,
          },
        })),
      ),
    );
  });
});
