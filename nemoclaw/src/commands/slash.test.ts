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
      expect(result.text).toContain("eject");
      expect(result.text).toContain("onboard");
    });

    it("returns help text for unknown subcommand", () => {
      const result = handleSlashCommand(makeCtx("unknown"), makeApi());
      expect(result.text).toContain("Subcommands:");
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("reports no operations when state is blank", () => {
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("No operations performed yet");
    });

    it("reports state when last action exists", () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-123",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "test-sandbox",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Last action: deploy");
      expect(result.text).toContain("Blueprint: 1.0.0");
      expect(result.text).toContain("Run ID: run-123");
      expect(result.text).toContain("Sandbox: test-sandbox");
    });

    it("includes rollback snapshot when present", () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-456",
        lastAction: "migrate",
        blueprintVersion: "2.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
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
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Manual rollback required");
    });

    it("shows eject instructions when migration snapshot exists", () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-1",
        lastAction: "migrate",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        hostBackupPath: null,
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
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
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
