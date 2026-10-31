// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import {
  registerChannelsStopStartCleanup,
  registerChannelsStopStartProviderCleanup,
  waitForNativeChannelGateway,
} from "../live/channels-stop-start-helpers.ts";

type CleanupAction = { name: string; run: () => Promise<void> | void };

function cleanupFixtures(result = { exitCode: 0, stderr: "", stdout: "" }) {
  const actions: CleanupAction[] = [];
  const cleanup = {
    trackDisposable: vi.fn((name: string, run: CleanupAction["run"]) => {
      actions.push({ name, run });
    }),
  };
  const host = {
    command: vi.fn(async () => result),
    isCommandAvailable: vi.fn(async () => true),
    openshellCommandPath: "openshell",
  };
  return {
    actions,
    cleanup: cleanup as unknown as E2ETargetFixtures["cleanup"],
    host: host as unknown as E2ETargetFixtures["host"],
    hostMock: host,
    trackDisposable: cleanup.trackDisposable,
  };
}

describe("channels stop/start provider cleanup", () => {
  it("deletes the sandbox through OpenShell before providers during reverse-order cleanup", () => {
    const registrations: string[] = [];
    const cleanup = {
      trackDisposable: vi.fn((name: string) => registrations.push(name)),
      trackGateway: vi.fn((_host: unknown, name: string) =>
        registrations.push(`remove gateway ${name}`),
      ),
      trackSandbox: vi.fn((_host: unknown, name: string) =>
        registrations.push(`destroy sandbox ${name}`),
      ),
    } as unknown as E2ETargetFixtures["cleanup"];
    const host = {} as E2ETargetFixtures["host"];
    const sandbox = {} as E2ETargetFixtures["sandbox"];

    registerChannelsStopStartCleanup(cleanup, host, sandbox, {
      agent: "openclaw",
      env: {},
      redactions: [],
      sandboxName: "e2e-oc-ch-cycle",
    });

    expect([...registrations].reverse()).toEqual([
      "delete OpenShell sandbox e2e-oc-ch-cycle",
      "delete OpenShell provider e2e-oc-ch-cycle-googlechat-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-teams-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-slack-app",
      "delete OpenShell provider e2e-oc-ch-cycle-slack-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-wechat-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-discord-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-telegram-bridge",
      "remove gateway nemoclaw",
    ]);
  });

  it("registers every exact provider before the live lifecycle starts", () => {
    const fixtures = cleanupFixtures();

    registerChannelsStopStartProviderCleanup(fixtures.cleanup, fixtures.host, {
      agent: "openclaw",
      env: { NEMOCLAW_SANDBOX_NAME: "e2e-oc-ch-cycle" },
      redactions: ["test-api-key"],
      sandboxName: "e2e-oc-ch-cycle",
    });

    expect(fixtures.actions.map(({ name }) => name)).toEqual([
      "delete OpenShell provider e2e-oc-ch-cycle-telegram-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-discord-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-wechat-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-slack-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-slack-app",
      "delete OpenShell provider e2e-oc-ch-cycle-teams-bridge",
      "delete OpenShell provider e2e-oc-ch-cycle-googlechat-bridge",
    ]);
  });

  it("accepts a confirmed absent provider during idempotent cleanup", async () => {
    const fixtures = cleanupFixtures({
      exitCode: 1,
      stderr: "NotFound: provider does not exist",
      stdout: "",
    });
    registerChannelsStopStartProviderCleanup(fixtures.cleanup, fixtures.host, {
      agent: "hermes",
      env: {},
      redactions: [],
      sandboxName: "e2e-hm-ch-cycle",
    });

    await expect(fixtures.actions[0]?.run()).resolves.toBeUndefined();
    expect(fixtures.hostMock.command).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "e2e-hm-ch-cycle-telegram-bridge"],
      expect.objectContaining({
        artifactName:
          "cleanup-channels-stop-start-openshell-provider-delete-e2e-hm-ch-cycle-telegram-bridge",
      }),
    );
  });

  it("rejects an unexpected provider deletion failure", async () => {
    const fixtures = cleanupFixtures({
      exitCode: 1,
      stderr: "gateway unavailable",
      stdout: "",
    });
    registerChannelsStopStartProviderCleanup(fixtures.cleanup, fixtures.host, {
      agent: "openclaw",
      env: {},
      redactions: [],
      sandboxName: "e2e-oc-ch-cycle",
    });

    await expect(fixtures.actions[0]?.run()).rejects.toThrow(
      /cleanup OpenShell provider e2e-oc-ch-cycle-telegram-bridge failed/,
    );
  });

  it("rejects an unsafe sandbox before registering destructive cleanup", () => {
    const fixtures = cleanupFixtures();

    expect(() =>
      registerChannelsStopStartProviderCleanup(fixtures.cleanup, fixtures.host, {
        agent: "openclaw",
        env: {},
        redactions: [],
        sandboxName: "production-openclaw",
      }),
    ).toThrow(/only accepts openclaw sandbox names with prefix e2e-oc-ch-/);
    expect(fixtures.trackDisposable).not.toHaveBeenCalled();
  });
});

describe("channels stop/start readiness failure evidence", () => {
  const env = {
    HOME: "/tmp/channels-diagnostics-home",
    OPENSHELL_GATEWAY: "channels-test-gateway",
    NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/tmp/channels-diagnostics-state",
  };
  const redactions = ["test-channel-secret"];

  it("does not collect failure evidence for a ready gateway", async () => {
    const fixtures = cleanupFixtures();
    const execShell = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "native-ready",
      stderr: "",
    }));
    await expect(
      waitForNativeChannelGateway(
        fixtures.host,
        { execShell } as unknown as E2ETargetFixtures["sandbox"],
        env,
        redactions,
      ),
    ).resolves.toBeUndefined();
    expect(fixtures.hostMock.command).not.toHaveBeenCalled();
    expect(execShell).toHaveBeenCalledOnce();
    expect(execShell.mock.calls[0]).toEqual([
      expect.stringMatching(/^e2e-(oc|hm)-ch-/),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 180_000, redactionValues: redactions }),
    ]);
  });

  it.each([
    { exitCode: 1, timedOut: false },
    { exitCode: null, timedOut: true },
  ])("preserves readiness failure $exitCode/$timedOut after diagnostic errors", async (failure) => {
    const command = vi.fn(async () => {
      throw new Error("diagnostic unavailable");
    });
    const host = {
      command,
      openshellCommandPath: "openshell",
    } as unknown as E2ETargetFixtures["host"];
    const sandbox = {
      execShell: vi.fn(async () => ({ ...failure, stdout: "", stderr: "readiness failed" })),
    } as unknown as E2ETargetFixtures["sandbox"];

    await expect(waitForNativeChannelGateway(host, sandbox, env, redactions)).rejects.toThrow(
      /native gateway readiness/,
    );
    expect(command).toHaveBeenCalledWith(
      "openshell",
      [
        "logs",
        expect.stringMatching(/^e2e-(oc|hm)-ch-/),
        "-n",
        "200",
        "--source",
        "all",
        "--since",
        "2m",
      ],
      expect.objectContaining({
        artifactName: expect.stringMatching(/^channels-native-readiness-.*-supervisor-logs$/),
        env: expect.objectContaining(env),
        redactionValues: redactions,
        captureLimitBytes: 32_768,
        timeoutMs: 30_000,
      }),
    );
    expect(command).toHaveBeenCalledWith(
      "cat",
      [expect.any(String)],
      expect.objectContaining({
        artifactName: expect.stringMatching(/^channels-native-readiness-.*-gateway-log$/),
        env: expect.objectContaining(env),
        redactionValues: redactions,
        captureLimitBytes: 32_768,
        timeoutMs: 5_000,
      }),
    );
  });
});
