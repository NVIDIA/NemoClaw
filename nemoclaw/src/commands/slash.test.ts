// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";
import type { OpenClawPluginApi, PluginCommandContext } from "../index.js";
import type { NemoClawOnboardConfig } from "../onboard/config.js";

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
}));

vi.mock("./config-show.js", () => ({
  slashConfigShow: vi.fn(() => ({ text: "**NemoClaw Config**" })),
}));

import { loadState } from "../blueprint/state.js";
import { loadOnboardConfig } from "../onboard/config.js";
import { handleSlashCommand } from "./slash.js";
import { slashConfigShow } from "./config-show.js";

const mockedLoadState = vi.mocked(loadState);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);

function makeCtx(args?: string): PluginCommandContext {
  return {
    channel: "test-channel",
    isAuthorizedSender: true,
    args,
    commandBody: `/nemoclaw${args ? ` ${args}` : ""}`,
    config: {
      agents: { defaults: { model: "inference/native-model" } },
      models: {
        providers: { inference: { baseUrl: "https://native.example/v1", apiKey: "${NATIVE_KEY}" } },
      },
    },
  };
}

function makeApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
  };
}

describe("commands/slash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
    mockedLoadOnboardConfig.mockReturnValue(null);
  });

  // -------------------------------------------------------------------------
  // help (default)
  // -------------------------------------------------------------------------

  describe("help", () => {
    it("returns help text for empty args", () => {
      const result = handleSlashCommand(makeCtx(), makeApi());
      expect(result.text).toContain("NemoClaw");
      expect(result.text).toContain("Subcommands:");
      expect(result.text).toContain("status");
      expect(result.text).toContain("config");
      expect(result.text).toContain("eject");
      expect(result.text).toContain("onboard");
    });

    it("returns help text for unknown subcommand", () => {
      const result = handleSlashCommand(makeCtx("unknown"), makeApi());
      expect(result.text).toContain("Subcommands:");
    });
  });

  // -------------------------------------------------------------------------
  // config (routing)
  // -------------------------------------------------------------------------

  describe("config", () => {
    it("routes to config show handler", () => {
      const ctx = makeCtx("config");
      const result = handleSlashCommand(ctx, makeApi());
      expect(result.text).toContain("Config");
      expect(slashConfigShow).toHaveBeenCalledExactlyOnceWith(ctx.config);
    });
  });

  it.each(["status", "onboard"])(
    "reads native edits for each %s request without stale fallback",
    (command) => {
      const stale = {
        profile: "default",
        onboardedAt: "2026-09-23",
        model: "stale/model",
        provider: "stale",
        endpointUrl: "https://stale.example/v1",
        credentialEnv: "STALE_KEY",
      };
      mockedLoadOnboardConfig.mockReturnValue(stale);
      const api = makeApi();
      const ctx = makeCtx(command);
      ctx.config = {
        agents: { defaults: { model: "edited/new-model" } },
        models: {
          providers: { edited: { baseUrl: "https://edited.example/v1", apiKey: "${EDITED_KEY}" } },
        },
      };
      const current = handleSlashCommand(ctx, api).text;
      expect(current).toContain("Provider: edited");
      expect(current).toContain("Model: edited/new-model");
      expect(current).toContain("https://edited.example/v1");
      expect(current).not.toContain("stale");
      expect(current?.includes("EDITED_KEY")).toBe(command === "onboard");
      ctx.config = {};
      const missing = handleSlashCommand(ctx, api).text;
      expect(missing).toContain("Model: (not configured)");
      expect(missing).not.toContain("stale");
      expect(missing).not.toContain("native-model");
    },
  );

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    const onboardConfig: NemoClawOnboardConfig = {
      profile: "default",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    };

    it("reports native routing even without onboarding metadata", () => {
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Model: inference/native-model");
      expect(result.text).toContain("(not recorded)");
    });

    it("reports sandbox, endpoint, provider, and model when onboarded", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      const api = makeApi();
      api.pluginConfig = { sandboxName: "prachi-restricted" };
      const result = handleSlashCommand(makeCtx("status"), api);
      expect(result.text).toContain("NemoClaw Status");
      expect(result.text).toContain("Sandbox: prachi-restricted");
      expect(result.text).toContain("Endpoint: https://native.example/v1");
      expect(result.text).toContain("Provider: inference");
      expect(result.text).toContain("Model: inference/native-model");
      expect(result.text).toContain("Onboarded: 2026-03-01T00:00:00.000Z");
      expect(result.text).not.toContain("No operations performed yet");
    });

    it("falls back to default sandbox name when pluginConfig is empty", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Sandbox: openclaw");
    });

    it("includes rebuild info when present", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRebuildAt: "2026-04-15T10:00:00Z",
        lastRebuildBackupPath: "/backups/rebuild-001",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Last rebuild: 2026-04-15T10:00:00Z");
      expect(result.text).toContain("Rebuild backup: /backups/rebuild-001");
    });

    it("includes rollback snapshot when present", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      mockedLoadState.mockReturnValue({
        ...blankState(),
        migrationSnapshot: "/snapshots/snap-001",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Rollback snapshot: /snapshots/snap-001");
    });
  });

  // -------------------------------------------------------------------------
  // eject
  // -------------------------------------------------------------------------

  describe("eject", () => {
    it("reports nothing to eject when state is blank", () => {
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("No NemoClaw deployment found");
    });

    it("reports manual rollback required when no snapshot exists", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Manual rollback required");
    });

    it("shows eject instructions when migration snapshot exists", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "migrate",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Eject from NemoClaw");
      expect(result.text).toContain("nemoclaw <name> destroy");
      expect(result.text).toContain("Snapshot: /snapshots/snap-001");
    });

    it("uses hostBackupPath when migrationSnapshot is absent", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        hostBackupPath: "/backups/backup-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Snapshot: /backups/backup-001");
    });
  });

  // -------------------------------------------------------------------------
  // onboard
  // -------------------------------------------------------------------------

  describe("onboard", () => {
    it("shows setup instructions when no config exists", () => {
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("Profile: (not recorded)");
      expect(result.text).toContain("nemoclaw onboard");
    });

    it("shows onboard status when config exists", () => {
      const config = {
        profile: "default",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NemoClaw Onboard Status");
      expect(result.text).toContain("Provider: inference");
      expect(result.text).toContain("inference/native-model");
      expect(result.text).toContain("NATIVE_KEY");
    });

    it("does not invent missing native primary from onboarding metadata", () => {
      const config: NemoClawOnboardConfig = {
        profile: "default",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      const ctx = makeCtx("onboard");
      ctx.config = {};
      const result = handleSlashCommand(ctx, makeApi());
      expect(result.text).toContain("Model: (not configured)");
      expect(result.text).toContain("Credential: (not configured)");
    });
  });
});
