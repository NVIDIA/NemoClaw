// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginCommandContext, OpenClawPluginApi } from "../index.js";
import type { NemoClawState } from "../blueprint/state.js";
import type { NemoClawOnboardConfig } from "../onboard/config.js";

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(),
  describeOnboardProvider: vi.fn(),
}));

vi.mock("./shields-status.js", () => ({
  slashShieldsStatus: vi.fn(() => ({ text: "**Shields: UP**" })),
}));

vi.mock("./config-show.js", () => ({
  slashConfigShow: vi.fn(() => ({ text: "**NemoClaw Config**" })),
}));

import { handleSlashCommand } from "./slash.js";
import { loadState } from "../blueprint/state.js";
import {
  loadOnboardConfig,
  describeOnboardEndpoint,
  describeOnboardProvider,
} from "../onboard/config.js";

const mockedLoadState = vi.mocked(loadState);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);
const mockedDescribeOnboardEndpoint = vi.mocked(describeOnboardEndpoint);
const mockedDescribeOnboardProvider = vi.mocked(describeOnboardProvider);

function makeCtx(args?: string): PluginCommandContext {
  return {
    channel: "test-channel",
    isAuthorizedSender: true,
    args,
    commandBody: `/nemoclaw${args ? ` ${args}` : ""}`,
    config: {},
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
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
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
      expect(result.text).toContain("shields");
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
  // shields (routing)
  // -------------------------------------------------------------------------

  describe("shields", () => {
    it("routes to shields status handler", () => {
      const result = handleSlashCommand(makeCtx("shields"), makeApi());
      expect(result.text).toContain("Shields");
    });
  });

  // -------------------------------------------------------------------------
  // config (routing)
  // -------------------------------------------------------------------------

  describe("config", () => {
    it("routes to config show handler", () => {
      const result = handleSlashCommand(makeCtx("config"), makeApi());
      expect(result.text).toContain("Config");
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    const onboardConfig: NemoClawOnboardConfig = {
      endpointType: "build",
      endpointUrl: "https://api.build.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    };

    it("reports the onboard hint when no onboard config exists", () => {
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("No onboard configuration found");
      expect(result.text).toContain("nemoclaw onboard");
    });

    it("reports sandbox, endpoint, provider, and model when onboarded", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (https://api.build.nvidia.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoints");
      const api = makeApi();
      api.pluginConfig = { sandboxName: "prachi-restricted" };
      const result = handleSlashCommand(makeCtx("status"), api);
      expect(result.text).toContain("NemoClaw Status");
      expect(result.text).toContain("Sandbox: prachi-restricted");
      expect(result.text).toContain("Endpoint: build (https://api.build.nvidia.com/v1)");
      expect(result.text).toContain("Provider: NVIDIA Endpoints");
      expect(result.text).toContain("Model: nvidia/nemotron-3-super-120b-a12b");
      expect(result.text).toContain("Onboarded: 2026-03-01T00:00:00.000Z");
      expect(result.text).not.toContain("No operations performed yet");
    });

    it("falls back to default sandbox name when pluginConfig is empty", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (...)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoints");
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Sandbox: openclaw");
    });

    it("includes rebuild info when present", () => {
      mockedLoadOnboardConfig.mockReturnValue(onboardConfig);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (...)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoints");
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
      mockedDescribeOnboardEndpoint.mockReturnValue("build (...)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoints");
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
      expect(result.text).toContain("No configuration found");
      expect(result.text).toContain("nemoclaw onboard");
    });

    it("shows onboard status when config exists", () => {
      const config = {
        endpointType: "build" as const,
        endpointUrl: "https://api.build.nvidia.com/v1",
        ncpPartner: null,
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (https://api.build.nvidia.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoint API");
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NemoClaw Onboard Status");
      expect(result.text).toContain("NVIDIA Endpoint API");
      expect(result.text).toContain("nvidia/nemotron-3-super-120b-a12b");
      expect(result.text).toContain("NVIDIA_API_KEY");
    });

    it("includes NCP partner when set", () => {
      const config: NemoClawOnboardConfig = {
        endpointType: "ncp",
        endpointUrl: "https://partner.example.com/v1",
        ncpPartner: "PartnerCo",
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("ncp (https://partner.example.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Cloud Partner");
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NCP Partner: PartnerCo");
    });
  });
});
