// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { registerHermesSlackCleanup } from "../live/hermes-slack-e2e-helpers.ts";

type CleanupAction = { name: string; run: () => Promise<void> | void };

function cleanupFixtures(result = { exitCode: 0, stderr: "", stdout: "" }) {
  const actions: CleanupAction[] = [];
  const cleanup = {
    trackDisposable: vi.fn((name: string, run: CleanupAction["run"]) => {
      actions.push({ name, run });
    }),
    trackGateway: vi.fn(),
    trackSandbox: vi.fn(),
  };
  const host = {
    command: vi.fn(async () => result),
    isCommandAvailable: vi.fn(async () => true),
    openshellCommandPath: "openshell",
  };
  return {
    actions,
    cleanup,
    fixtures: {
      cleanup: cleanup as unknown as E2ETargetFixtures["cleanup"],
      host: host as unknown as E2ETargetFixtures["host"],
      sandbox: {} as E2ETargetFixtures["sandbox"],
    },
    host,
  };
}

describe("Hermes Slack retained-resource cleanup", () => {
  it("does not register destructive cleanup when sandbox retention is requested", () => {
    const { cleanup, fixtures } = cleanupFixtures();

    registerHermesSlackCleanup(fixtures, {
      apiKey: "test-api-key",
      env: {},
      keepSandbox: true,
      redactionValues: ["test-api-key"],
      sandboxName: "e2e-hermes-slack",
    });

    expect(cleanup.trackGateway).not.toHaveBeenCalled();
    expect(cleanup.trackDisposable).not.toHaveBeenCalled();
    expect(cleanup.trackSandbox).not.toHaveBeenCalled();
  });

  it("registers gateway, provider, and sandbox cleanup by default", () => {
    const { cleanup, fixtures } = cleanupFixtures();

    registerHermesSlackCleanup(fixtures, {
      apiKey: "test-api-key",
      env: {},
      keepSandbox: false,
      redactionValues: ["test-api-key"],
      sandboxName: "e2e-hermes-slack",
    });

    expect(cleanup.trackGateway).toHaveBeenCalledTimes(1);
    expect(cleanup.trackDisposable).toHaveBeenCalledTimes(3);
    expect(cleanup.trackSandbox).toHaveBeenCalledTimes(1);
  });

  it("accepts a confirmed absent provider during idempotent cleanup", async () => {
    const { actions, fixtures, host } = cleanupFixtures({
      exitCode: 1,
      stderr: "No provider named e2e-hermes-slack-slack-app",
      stdout: "",
    });
    registerHermesSlackCleanup(fixtures, {
      apiKey: "test-api-key",
      env: {},
      keepSandbox: false,
      redactionValues: ["test-api-key"],
      sandboxName: "e2e-hermes-slack",
    });

    await actions[0]?.run();
    expect(host.command).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "e2e-hermes-slack-slack-app"],
      expect.objectContaining({
        artifactName: "cleanup-hermes-slack-openshell-provider-delete-e2e-hermes-slack-slack-app",
      }),
    );
  });

  it("rejects an unexpected provider deletion failure", async () => {
    const { actions, fixtures } = cleanupFixtures({
      exitCode: 1,
      stderr: "gateway unavailable",
      stdout: "",
    });
    registerHermesSlackCleanup(fixtures, {
      apiKey: "test-api-key",
      env: {},
      keepSandbox: false,
      redactionValues: ["test-api-key"],
      sandboxName: "e2e-hermes-slack",
    });

    await expect(actions[0]?.run()).rejects.toThrow(
      /cleanup OpenShell provider e2e-hermes-slack-slack-app failed/,
    );
  });

  it("rejects a non-E2E sandbox name before registering destructive cleanup", () => {
    const { cleanup, fixtures } = cleanupFixtures();

    expect(() =>
      registerHermesSlackCleanup(fixtures, {
        apiKey: "test-api-key",
        env: {},
        keepSandbox: false,
        redactionValues: ["test-api-key"],
        sandboxName: "shared-hermes-sandbox",
      }),
    ).toThrow(
      "Hermes Slack live test is destructive and only accepts sandbox name e2e-hermes-slack; got shared-hermes-sandbox",
    );

    expect(cleanup.trackGateway).not.toHaveBeenCalled();
    expect(cleanup.trackDisposable).not.toHaveBeenCalled();
    expect(cleanup.trackSandbox).not.toHaveBeenCalled();
  });
});
