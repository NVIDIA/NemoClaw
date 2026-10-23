// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import vm from "node:vm";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import { env } from "../live/hermes-inference-switch-helpers.ts";

// Execute the live phase itself so host-key overrides and omitted state probes
// cannot pass through a separate copy of its command sequence.
const live = readFileSync(
  new URL("../live/hermes-inference-switch.test.ts", import.meta.url),
  "utf8",
);
const phase = live.slice(
  live.indexOf("    switch (publicApiKey) {"),
  live.indexOf('    progress.phase("prove split provider/model credential resolution");'),
);
const script = ts.transpileModule(`(async () => { ${phase} })()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function runPhase(
  options: {
    publicKey?: string | null;
    failedCommand?: string;
    lostDiscord?: boolean;
    statusHealth?: { ok: boolean; probed: boolean } | null;
  } = {},
) {
  const command = vi.fn(
    async (_binary: string, args: string[], _input: { env: NodeJS.ProcessEnv }) => {
      return {
        exitCode: args.includes(options.failedCommand ?? "never") ? 1 : 0,
        stdout: args.includes("status")
          ? JSON.stringify({
              agent: "hermes",
              provider: "nvidia-prod",
              inferenceHealth:
                options.statusHealth === undefined
                  ? { ok: true, probed: true }
                  : options.statusHealth,
            })
          : "",
        stderr: "fixture failure",
      };
    },
  );
  const exec = vi.fn(async (_name: string, args: string[]) => {
    switch (args.includes("-z")) {
      case true:
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        enabled: !options.lostDiscord,
        requireMention: true,
        guildIds: "1491590992753590594",
        allowedUsers: "1005536447329222676",
      }),
      stderr: "",
    };
  });
  await vm.runInNewContext(script, {
    publicApiKey: options.publicKey === undefined ? "synthetic-public-key" : options.publicKey,
    CLI: "bin/nemoclaw.js",
    SANDBOX_NAME: "fixture-hermes",
    redactionValues: [],
    progress: { phase() {} },
    env,
    host: { command },
    sandbox: { exec },
    expect,
    resultText: (result: { stdout: string; stderr: string }) => result.stdout + result.stderr,
    expectExitZero: (result: { exitCode: number }, label: string) =>
      expect(result.exitCode, label).toBe(0),
  });
  return { command, exec };
}

describe("Hermes Discord rebuild evidence", () => {
  it("keeps Discord security on internal inference and native rebuild on public inference", () => {
    const discord = catalogueTarget("hermes-discord");
    const native = catalogueTarget("hermes-inference-switch");
    expect(discord.profile).toBe("nvidia-inference");
    expect(discord.environment.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBe("1");
    expect(native.profile).toBe("nvidia-api");
    expect(native.environment.NEMOCLAW_SWITCH_PROVIDER).toBe("nvidia-prod");
  });

  it("rebuilds from stored credentials and verifies Discord state before inference", async () => {
    const { command, exec } = await runPhase();
    expect(command.mock.calls[0]![2].env.NVIDIA_INFERENCE_API_KEY).toBe("synthetic-public-key");
    expect(command.mock.calls[1]![2].env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(command.mock.calls[1]![2].env).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[2]![1]).toEqual([
      "bin/nemoclaw.js",
      "fixture-hermes",
      "status",
      "--json",
    ]);
    expect(command.mock.calls[2]![2].env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]![1]).not.toContain("-z");
    expect(exec.mock.calls[1]![1]).toContain("-z");
  });

  it.each(["discord", "rebuild", "status"])("stops when %s fails", async (failedCommand) => {
    await expect(runPhase({ failedCommand })).rejects.toThrow();
  });

  it("rejects a rebuild that loses Discord configuration", async () => {
    await expect(runPhase({ lostDiscord: true })).rejects.toThrow();
  });

  it.each([null, { ok: false, probed: false }, { ok: true, probed: false }])(
    "rejects unavailable or unhealthy post-rebuild status [%#]",
    async (statusHealth) => {
      await expect(runPhase({ statusHealth })).rejects.toThrow();
    },
  );

  it("leaves the Anthropic variant outside the native NVIDIA phase", async () => {
    const { command, exec } = await runPhase({ publicKey: null });
    expect(command).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
