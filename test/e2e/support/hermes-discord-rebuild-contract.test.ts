// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  CLI,
  runHermesNvidiaDiscordRebuild,
  SANDBOX_NAME,
} from "../live/hermes-inference-switch-helpers.ts";

function result(exitCode: number, stdout: string): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "fixture failure",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

async function runPhase(
  options: {
    publicKey?: string | null;
    failedCommand?: string;
    lostDiscord?: boolean;
    statusHealth?: { ok: boolean; probed: boolean } | null;
    statusProvider?: string;
  } = {},
) {
  const command = vi.fn<HostCliClient["command"]>(async (_binary, args = []) =>
    result(
      args.includes(options.failedCommand ?? "never") ? 1 : 0,
      args.includes("status")
        ? JSON.stringify({
            agent: "hermes",
            provider: options.statusProvider ?? "nvidia-prod",
            inferenceHealth:
              options.statusHealth === undefined
                ? { ok: true, probed: true }
                : options.statusHealth,
          })
        : "",
    ),
  );
  const exec = vi.fn<SandboxClient["exec"]>(async (_name, args) => {
    switch (args.includes("-z")) {
      case true:
        return result(0, "PROBE_OK");
    }
    return result(
      0,
      JSON.stringify({
        enabled: !options.lostDiscord,
        requireMention: true,
        guildIds: "1491590992753590594",
        allowedUsers: "1005536447329222676",
      }),
    );
  });
  await runHermesNvidiaDiscordRebuild({
    publicApiKey: options.publicKey === undefined ? "synthetic-public-key" : options.publicKey,
    redactionValues: [],
    progress: { phase() {} },
    host: { command },
    sandbox: { exec },
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
    expect(command.mock.calls[0]![2]!.env!.NVIDIA_INFERENCE_API_KEY).toBe("synthetic-public-key");
    expect(command.mock.calls[1]![2]!.env!).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(command.mock.calls[1]![2]!.env!).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[2]![1]).toEqual([CLI, SANDBOX_NAME, "status", "--json"]);
    expect(command.mock.calls[2]![2]!.env!).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
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

  it("rejects healthy post-rebuild status from another provider", async () => {
    await expect(runPhase({ statusProvider: "compatible-endpoint" })).rejects.toThrow();
  });

  it("leaves the Anthropic variant outside the native NVIDIA phase", async () => {
    const { command, exec } = await runPhase({ publicKey: null });
    expect(command).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
