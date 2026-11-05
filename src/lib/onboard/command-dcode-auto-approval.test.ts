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
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import { serializeCheckpoint } from "../state/onboard-checkpoint";
import { resolveOnboardResumeIntent } from "./session-bootstrap";

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
    { agent: "openclaw", env: {} },
    { agent: "hermes", env: {} },
    { agent: "nemohermes", env: {} },
    { agent: "openclaw", env: { NEMOCLAW_AGENT: "langchain-deepagents-code" } },
    { agent: undefined, env: { NEMOCLAW_AGENT: "openclaw" } },
    { agent: undefined, env: { NEMOCLAW_AGENT: "hermes" } },
    { agent: undefined, env: { NEMOCLAW_AGENT: "nemohermes" } },
  ])(
    "rejects thread opt-in before onboarding for $agent and $env (#13537)",
    async ({ agent, env }) => {
      const error = vi.fn();
      const runOnboard = vi.fn();
      const exit = vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      });
      await expect(
        runOnboardCommand({
          flags: { agent, "dcode-auto-approval": "thread-opt-in" } as OnboardFlags,
          env,
          listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
          error,
          exit,
          runOnboard,
        }),
      ).rejects.toThrow("exit 1");
      expect(runOnboard).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("supported only with the managed"),
      );
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it.each(["from", "from-image"] as const)(
    "rejects thread opt-in with --%s before onboarding (#13537)",
    async (imageFlag) => {
      const dockerfile = path.join(stateDir, "Dockerfile");
      fs.writeFileSync(dockerfile, "FROM scratch\n");
      const images = {
        from: dockerfile,
        "from-image": `ghcr.io/example/agent@sha256:${"a".repeat(64)}`,
      };
      const error = vi.fn();
      const runOnboard = vi.fn();
      const exit = vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      });
      await expect(
        runOnboardCommand({
          flags: {
            agent: "langchain-deepagents-code",
            "dcode-auto-approval": "thread-opt-in",
            [imageFlag]: images[imageFlag],
          } as OnboardFlags,
          env: {},
          listAgents: () => ["langchain-deepagents-code"],
          error,
          exit,
          runOnboard,
        }),
      ).rejects.toThrow("exit 1");
      expect(runOnboard).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("supported only with the managed"),
      );
    },
  );

  it.each([
    { name: "OpenClaw", agent: null, fromDockerfile: null, fromImage: null },
    { name: "Hermes", agent: "hermes", fromDockerfile: null, fromImage: null },
    {
      name: "custom Dockerfile",
      agent: "langchain-deepagents-code",
      fromDockerfile: "/tmp/custom/Dockerfile",
      fromImage: null,
    },
    {
      name: "custom image",
      agent: "langchain-deepagents-code",
      fromDockerfile: null,
      fromImage: `ghcr.io/example/agent@sha256:${"a".repeat(64)}`,
    },
  ])(
    "rejects thread opt-in before onboarding for a resumed $name session (#13537)",
    async (saved) => {
      const session = createSession({
        agent: saved.agent,
        metadata: {
          gatewayName: "nemoclaw",
          fromDockerfile: saved.fromDockerfile,
          fromImage: saved.fromImage,
        },
      });
      session.checkpoint = deriveCheckpointFromSession(session);
      const sessionFile = path.join(stateDir, "resume-session.json");
      const before = `${JSON.stringify({
        ...session,
        checkpoint: serializeCheckpoint(session.checkpoint),
      })}\n`;
      fs.writeFileSync(sessionFile, before, { mode: 0o600 });
      const error = vi.fn();
      const runOnboard = vi.fn();
      const exit = vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      });

      await expect(
        runOnboardCommand({
          flags: { resume: true, "dcode-auto-approval": "thread-opt-in" } as OnboardFlags,
          env: { NEMOCLAW_AGENT: "" },
          listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
          resolveResumeIntent: (input) => resolveOnboardResumeIntent({ ...input, sessionFile }),
          error,
          exit,
          runOnboard,
        }),
      ).rejects.toThrow("exit 1");
      expect(runOnboard).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("supported only with the managed"),
      );
      expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
    },
  );

  it("allows thread opt-in for a resumed managed Deep Agents Code session (#13537)", async () => {
    const session = createSession({ agent: "langchain-deepagents-code" });
    session.checkpoint = deriveCheckpointFromSession(session);
    const sessionFile = path.join(stateDir, "resume-session.json");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ ...session, checkpoint: serializeCheckpoint(session.checkpoint) }),
      { mode: 0o600 },
    );
    const runOnboard = vi.fn();
    await runOnboardCommand({
      flags: { resume: true, "dcode-auto-approval": "thread-opt-in" } as OnboardFlags,
      env: {},
      listAgents: () => ["openclaw", "langchain-deepagents-code"],
      resolveResumeIntent: (input) => resolveOnboardResumeIntent({ ...input, sessionFile }),
      runOnboard,
    });
    expect(runOnboard).toHaveBeenCalledOnce();
  });

  it.each([
    { agent: "dcode", env: { NEMOCLAW_AGENT: "openclaw" }, mode: "thread-opt-in" },
    { agent: undefined, env: { NEMOCLAW_AGENT: "dcode" }, mode: "thread-opt-in" },
    { agent: "openclaw", env: {}, mode: "disabled" },
    { agent: undefined, env: {}, mode: "thread-opt-in" },
  ] as const)(
    "preserves valid or unselected $agent input with $mode (#13537)",
    async ({ agent, env, mode }) => {
      const runOnboard = vi.fn();
      await runOnboardCommand({
        flags: { agent, "dcode-auto-approval": mode } as OnboardFlags,
        env,
        listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
        runOnboard,
      });
      expect(runOnboard).toHaveBeenCalledOnce();
      expect(runOnboard).toHaveBeenCalledWith(
        expect.objectContaining({ dcodeAutoApprovalMode: mode }),
      );
    },
  );

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
