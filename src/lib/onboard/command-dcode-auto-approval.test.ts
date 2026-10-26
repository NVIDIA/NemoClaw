// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Parser } from "@oclif/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOnboardCommand } from "./command";
import { buildOnboardFlags, type OnboardFlags } from "./command-support";
import { applyOnboardRuntimeControlRequests } from "./runtime-control-flow";
import { handleSandboxState } from "./machine/handlers/sandbox";
import { baseOptions, createDeps } from "./machine/handlers/sandbox-test-fixtures";
import { createSession } from "../state/onboard-session";

vi.mock("./messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-onboard-"));
  vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("onboard DCode auto-approval input", () => {
  it.each([
    ["thread-opt-in", false],
    ["disabled", false],
    [undefined, false],
    ["thread-opt-in", true],
    ["disabled", true],
    [undefined, true],
  ])("forwards mode %s with resume=%s to canonical onboarding", async (mode, resume) => {
    const { flags } = await Parser.parse(
      [
        "--agent",
        "langchain-deepagents-code",
        ...(mode ? ["--dcode-auto-approval", mode] : []),
        ...(resume ? ["--resume"] : []),
      ],
      { flags: buildOnboardFlags() },
    );
    const runOnboard = vi.fn();
    await runOnboardCommand({
      flags: flags as OnboardFlags,
      env: {},
      listAgents: () => ["langchain-deepagents-code"],
      runOnboard,
    });
    expect(runOnboard).toHaveBeenCalledWith(
      expect.objectContaining({ dcodeAutoApprovalMode: mode ?? null, resume }),
    );
  });

  it.each(["always", "THREAD-OPT-IN", ""])("rejects invalid capability %j", async (mode) => {
    await expect(
      Parser.parse(["--dcode-auto-approval", mode], { flags: buildOnboardFlags() }),
    ).rejects.toThrow();
  });

  it.each([
    [undefined, undefined, "thread-opt-in", "thread-opt-in"],
    [undefined, undefined, "disabled", "thread-opt-in", false],
    [undefined, undefined, "disabled", "disabled"],
    [undefined, "disabled", "disabled", "thread-opt-in"],
    ["disabled", undefined, "disabled", "thread-opt-in"],
    [undefined, undefined, "disabled"],
    ["disabled", undefined, "disabled"],
    ["thread-opt-in", undefined, "thread-opt-in"],
    [undefined, "disabled", "disabled"],
    [undefined, "thread-opt-in", "thread-opt-in"],
    ["disabled", "thread-opt-in", "disabled"],
  ] as const)(
    "creates with requested %s and recorded %s as %s",
    async (
      requested,
      recorded,
      expected,
      pending: "disabled" | "thread-opt-in" | undefined = undefined,
      reservation: boolean = true,
    ) => {
      const session = createSession({
        sandboxName: "saved",
        dcodeAutoApprovalMode: pending,
        dcodeAutoApprovalRequestedExplicitly: pending !== undefined,
      });
      const { deps, calls } = createDeps(
        {
          getSandboxRegistryEntry: () => ({
            name: "saved",
            agent: "langchain-deepagents-code",
            nemoclawVersion: "0.1.0",
            dcodeAutoApprovalMode: recorded,
            provider: "provider",
            model: "model",
            pendingRouteReservation: reservation ? true : undefined,
            reservationSessionId: session.sessionId,
          }),
          error: (message) => {
            throw new Error(message);
          },
        },
        session,
      );
      const { flags } = await Parser.parse(requested ? ["--dcode-auto-approval", requested] : [], {
        flags: buildOnboardFlags(),
      });
      await runOnboardCommand({
        flags: flags as OnboardFlags,
        env: {},
        runOnboard: async (options) => {
          await handleSandboxState({
            ...baseOptions(deps, session),
            ...applyOnboardRuntimeControlRequests(options),
            agent: { name: "langchain-deepagents-code" },
            sandboxName: "saved",
            resume: recorded !== undefined || pending !== undefined,
          });
        },
      });
      expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({
        dcodeAutoApprovalMode: expected,
      });
    },
  );

  it.each([
    ["hermes", null],
    ["langchain-deepagents-code", "/tmp/custom/Dockerfile"],
  ])("rejects thread opt-in for agent %s with Dockerfile %s", async (agent, fromDockerfile) => {
    const { deps, calls } = createDeps();
    await expect(
      handleSandboxState({
        ...baseOptions(deps),
        agent: { name: agent! },
        fromDockerfile,
        requestedDcodeAutoApprovalMode: "thread-opt-in",
      }),
    ).rejects.toThrow("exit 1");
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("supported only with the managed"),
    );
  });
});
