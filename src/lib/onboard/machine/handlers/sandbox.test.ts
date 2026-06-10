// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
} from "../../../../../test/helpers/sandbox-handler-fixtures";

describe("handleSandboxState", () => {
  it("creates a sandbox and records messaging/web search state", async () => {
    const mockPlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"]);
    const { deps, calls } = createDeps({
      configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
      readMessagingPlanFromEnv: () => mockPlan,
    });
    calls.setupMessaging.mockResolvedValue(["telegram"]);

    const result = await handleSandboxState(baseOptions(deps));

    expect(calls.startStep).toHaveBeenCalledWith("sandbox", {
      provider: "provider",
      model: "model",
    });
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, ["telegram"], "my-assistant");
    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true },
      ["telegram"],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
    );
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ model: "model", provider: "provider" }),
    );
    // Default-marking is deferred to finalization (#4614) — the sandbox step must not set it.
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ sandboxName: "my-assistant" }),
    );
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "openclaw",
      transitionKind: "branch",
      updates: undefined,
      metadata: { state: "sandbox", sandboxName: "my-assistant", agent: "openclaw" },
    });
  });

  it("reuses a completed ready sandbox on resume", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved");
    expect(calls.recordSkip).toHaveBeenCalledWith("sandbox", {
      reason: "resume",
      sandboxName: "saved",
    });
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
  });

  it("removes registry state when Telegram mention-mode drift forces sandbox recreation", async () => {
    const session = createSession({ telegramConfig: { requireMention: true } });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      computeTelegramRequireMention: () => false,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] TELEGRAM_REQUIRE_MENTION changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("repairs not-ready resumed sandboxes before recreation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "not_ready" });

    await handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" });

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairSandbox).toHaveBeenCalledWith("saved");
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("records failed sandbox repair events before propagating repair errors", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "not_ready",
      repairRecordedSandbox: vi.fn(() => {
        throw new Error("cleanup failed");
      }),
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
    ).rejects.toThrow("cleanup failed");

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.failed", {
      state: "sandbox",
      error: "cleanup failed",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairEvent).not.toHaveBeenCalledWith("state.repair.completed", expect.anything());
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("recreates when a saved web search sandbox is no longer supported", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      agentSupportsWebSearch: () => false,
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn(
        (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
      ),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  Web search is not yet supported by this sandbox image. Clearing stale config.",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("drops saved web search config when credential revalidation returns to provider selection", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });
    session.steps.sandbox.status = "complete";
    const backToSelection = Object.freeze({ kind: "NEMOCLAW_BACK_TO_SELECTION" });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "not_ready",
      ensureValidatedBraveSearchCredential: vi.fn(async () => backToSelection),
      isBackToSelection: vi.fn((value: unknown) => value === backToSelection),
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
    );
    expect(result.webSearchConfig).toBeNull();
  });
});
