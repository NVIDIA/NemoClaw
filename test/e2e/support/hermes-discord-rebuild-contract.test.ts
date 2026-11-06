// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import { testTimeout } from "../../helpers/timeouts.ts";
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
    failedDiscordRead?: "healthy" | "damaged";
    statusHealth?: { ok: boolean; probed: boolean } | null;
    statusProvider?: string;
    damageFailure?: "seed" | "readback" | "partial" | "route drift" | "user state" | "inference";
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
  const discordState = result(
    0,
    JSON.stringify({
      enabled: !options.lostDiscord,
      requireMention: true,
      guildIds: "1491590992753590594",
      allowedUsers: "1005536447329222676",
    }),
  );
  const seeded = result(
    options.damageFailure === "seed" ? 1 : 0,
    JSON.stringify({ configFingerprint: "a".repeat(64) }),
  );
  // The actual Python fixture refuses partial references and missing user state
  // with a nonzero exit; its filesystem tests own those validation details.
  const recovered = result(
    ["readback", "partial", "user state"].includes(options.damageFailure ?? "") ? 1 : 0,
    JSON.stringify({
      configFingerprint: (options.damageFailure === "route drift" ? "b" : "a").repeat(64),
    }),
  );
  const exec = vi
    .fn<SandboxClient["exec"]>()
    .mockResolvedValueOnce({
      ...discordState,
      exitCode: options.failedDiscordRead === "healthy" ? 1 : 0,
    })
    .mockResolvedValueOnce(result(0, "PROBE_OK"))
    .mockResolvedValueOnce(seeded)
    .mockResolvedValueOnce({
      ...discordState,
      exitCode: options.failedDiscordRead === "damaged" ? 1 : 0,
    })
    .mockResolvedValueOnce(recovered)
    .mockResolvedValueOnce(
      result(0, options.damageFailure === "inference" ? "no response" : "PROBE_OK"),
    );
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
    const enrollmentEnv = command.mock.calls[0]![2]!.env!;
    const rebuildEnv = command.mock.calls[1]![2]!.env!;
    const preload = new URL("../fixtures/discord-enrollment-preload.mts", import.meta.url).href;
    expect(enrollmentEnv.NEMOCLAW_E2E_DISCORD_TOKEN).toBe(enrollmentEnv.DISCORD_BOT_TOKEN);
    expect(enrollmentEnv.NODE_OPTIONS).toContain(`--import=${preload}`);
    expect(rebuildEnv.NEMOCLAW_E2E_DISCORD_TOKEN).toBe(enrollmentEnv.DISCORD_BOT_TOKEN);
    expect(rebuildEnv.NODE_OPTIONS).toContain(`--import=${preload}`);
    expect(command.mock.calls[0]![2]!.env!.NVIDIA_INFERENCE_API_KEY).toBe("synthetic-public-key");
    expect(command.mock.calls[1]![2]!.env!).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(command.mock.calls[1]![2]!.env!).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(command).toHaveBeenCalledTimes(5);
    expect(command.mock.calls[3]![1]).toEqual([CLI, SANDBOX_NAME, "rebuild", "--yes"]);
    expect(command.mock.calls[3]![2]!.env!).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(command.mock.calls[3]![2]!.env!).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(exec.mock.invocationCallOrder[2]).toBeLessThan(command.mock.invocationCallOrder[3]!);
    expect(exec.mock.calls[2]![1]).toContain("seed");
    expect(exec.mock.calls[4]![1]).toContain("verify");
    expect(command.mock.calls[2]![1]).toEqual([CLI, SANDBOX_NAME, "status", "--json"]);
    expect(command.mock.calls[2]![2]!.env!).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(exec).toHaveBeenCalledTimes(6);
    expect(exec.mock.calls[0]![1]).toEqual([
      "/opt/hermes/.venv/bin/python3",
      "-c",
      expect.any(String),
    ]);
    expect(exec.mock.calls[1]![1]).toContain("-z");
  });

  it("reserves the damaged rebuild budget and workflow cleanup time", async () => {
    const { command, exec } = await runPhase();
    const target = catalogueTarget("hermes-inference-switch");
    vi.stubEnv("NEMOCLAW_TEST_TIMEOUT", target.environment.NEMOCLAW_TEST_TIMEOUT ?? "");
    const timeout = testTimeout(45 * 60_000);
    const damagedCommands = [...command.mock.calls.slice(3), ...exec.mock.calls.slice(2)];
    const damagedTimeout = damagedCommands.reduce((total, call) => total + call[2]!.timeoutMs!, 0);
    expect(timeout).toBeGreaterThanOrEqual(45 * 60_000 + damagedTimeout);
    expect(target.timeoutMinutes * 60_000 - timeout).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it.each(["discord", "rebuild", "status"])("stops when %s fails", async (failedCommand) => {
    await expect(runPhase({ failedCommand })).rejects.toThrow();
  });

  it.each(["seed", "readback", "partial", "route drift", "user state", "inference"] as const)(
    "rejects damaged-state recovery with failed %s evidence (#14094)",
    async (damageFailure) => {
      await expect(runPhase({ damageFailure })).rejects.toThrow();
    },
  );

  it.each(["healthy", "damaged"] as const)(
    "rejects a failed Discord-state read with valid output after the %s rebuild",
    async (failedDiscordRead) => {
      await expect(runPhase({ failedDiscordRead })).rejects.toThrow(
        "read Discord settings after rebuild",
      );
    },
  );

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
