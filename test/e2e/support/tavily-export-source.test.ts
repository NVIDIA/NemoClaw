// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { onboardTavilyExportSource } from "../fixtures/tavily-export-source.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { SecretStore } from "../fixtures/secrets.ts";

const inferenceKey = "fixture-inference-secret";
const tavilyKey = "fixture-tavily-secret";

function setup(
  secretValues: NodeJS.ProcessEnv = {
    NVIDIA_INFERENCE_API_KEY: inferenceKey,
    TAVILY_API_KEY: tavilyKey,
  },
) {
  const result = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: {},
    command: [],
  };
  const host = {
    command: vi.fn().mockResolvedValue(result),
    nemoclaw: vi.fn().mockResolvedValue(result),
  };
  const removals: Array<() => Promise<void> | void> = [];
  const cleanup = {
    trackDisposable: vi.fn((_label: string, remove: () => Promise<void> | void) =>
      removals.push(remove),
    ),
  };
  const secrets = new SecretStore(secretValues, (message) => {
    throw new Error(message);
  });
  return { host, cleanup, secrets, removals, result };
}

describe("Tavily export source onboarding", () => {
  it.each(["openclaw", "hermes"] as const)(
    "installs %s from local source with explicit Tavily intent and owned cleanup (#12138)",
    async (agent) => {
      const test = setup();
      const source = await onboardTavilyExportSource(agent, test.host, test.secrets, test.cleanup);
      expect(source.sandboxName).toMatch(/^tv-(?:oc|hm)-[a-f0-9]{8}$/u);
      expect(test.host.command).toHaveBeenCalledExactlyOnceWith(
        "bash",
        ["install.sh", "--fresh"],
        expect.objectContaining({
          cwd: REPO_ROOT,
          env: expect.objectContaining({
            NEMOCLAW_REPO_ROOT: REPO_ROOT,
            NEMOCLAW_AGENT: agent,
            NEMOCLAW_SANDBOX_NAME: source.sandboxName,
            NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
            NEMOCLAW_POLICY_TIER: "balanced",
            BRAVE_API_KEY: "",
            TAVILY_API_KEY: tavilyKey,
            COMPATIBLE_API_KEY: inferenceKey,
          }),
          redactionValues: [inferenceKey, tavilyKey],
        }),
      );
      expect(test.cleanup.trackDisposable.mock.invocationCallOrder[0]).toBeLessThan(
        test.host.command.mock.invocationCallOrder[0]!,
      );
      await test.removals[0]!();
      expect(test.host.nemoclaw).toHaveBeenCalledExactlyOnceWith(
        [source.sandboxName, "destroy", "--yes"],
        expect.objectContaining({ env: expect.objectContaining({ NEMOCLAW_AGENT: agent }) }),
      );
      const cleanupEnv = test.host.nemoclaw.mock.calls[0]![1].env;
      expect(cleanupEnv).not.toHaveProperty("TAVILY_API_KEY");
      expect(cleanupEnv).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
      expect(cleanupEnv).not.toHaveProperty("COMPATIBLE_API_KEY");
    },
  );

  it("refuses a missing Tavily credential before installing or registering cleanup (#12138)", async () => {
    const test = setup({ NVIDIA_INFERENCE_API_KEY: inferenceKey });
    await expect(
      onboardTavilyExportSource("hermes", test.host, test.secrets, test.cleanup),
    ).rejects.toThrow("TAVILY_API_KEY");
    expect(test.host.command).not.toHaveBeenCalled();
    expect(test.cleanup.trackDisposable).not.toHaveBeenCalled();
  });

  it("keeps cleanup registered when the real installer fails (#12138)", async () => {
    const test = setup();
    test.host.command.mockResolvedValue({
      ...test.result,
      exitCode: 1,
      stderr: "onboarding failed",
    });
    await expect(
      onboardTavilyExportSource("openclaw", test.host, test.secrets, test.cleanup),
    ).rejects.toThrow("onboarding failed");
    expect(test.removals).toHaveLength(1);
    await test.removals[0]!();
    const name = test.host.command.mock.calls[0]![2].env.NEMOCLAW_SANDBOX_NAME;
    expect(test.host.nemoclaw.mock.calls[0]![0]).toEqual([name, "destroy", "--yes"]);
  });

  it("reports cleanup failure instead of retaining a successful cleanup result (#12138)", async () => {
    const test = setup();
    await onboardTavilyExportSource("hermes", test.host, test.secrets, test.cleanup);
    test.host.nemoclaw.mockResolvedValue({ ...test.result, exitCode: 1, stderr: "cleanup failed" });
    await expect(test.removals[0]!()).rejects.toThrow("cleanup failed");
  });
});
