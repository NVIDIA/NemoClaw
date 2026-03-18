// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";
import type { PluginCommandContext, OpenClawPluginApi } from "../index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
}));

const { loadState } = await import("../blueprint/state.js");
const { loadOnboardConfig } = await import("../onboard/config.js");
const { handleSlashCommand } = await import("./slash.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function populatedState(): NemoClawState {
  return {
    lastRunId: "run-a1b2c3d4",
    lastAction: "migrate",
    blueprintVersion: "0.1.0",
    sandboxName: "openclaw",
    migrationSnapshot: "/root/.nemoclaw/snapshots/pre-migrate.tar.gz",
    hostBackupPath: "/root/.nemoclaw/backups/host-backup",
    createdAt: "2026-03-15T10:30:00.000Z",
    updatedAt: "2026-03-15T10:32:45.000Z",
  };
}

function makeContext(args?: string): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    args,
    commandBody: `/nemoclaw ${args ?? ""}`,
    config: {},
  };
}

const stubApi = {} as OpenClawPluginApi;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadState).mockReturnValue(blankState());
  vi.mocked(loadOnboardConfig).mockReturnValue(null);
});

describe("handleSlashCommand", () => {
  // =========================================================================
  // Help (default)
  // =========================================================================
  describe("help — default subcommand", () => {
    it("shows help when no args", () => {
      const result = handleSlashCommand(makeContext(), stubApi);

      expect(result.text).toContain("**NemoClaw**");
      expect(result.text).toContain("`status`");
      expect(result.text).toContain("`eject`");
      expect(result.text).toContain("`onboard`");
    });

    it("shows help for unrecognized subcommand", () => {
      const result = handleSlashCommand(makeContext("unknown"), stubApi);

      expect(result.text).toContain("**NemoClaw**");
    });
  });

  // =========================================================================
  // Status
  // =========================================================================
  describe("status subcommand", () => {
    it("shows 'no operations' when state is blank", () => {
      const result = handleSlashCommand(makeContext("status"), stubApi);

      expect(result.text).toContain("No operations performed yet");
      expect(result.text).toContain("openclaw nemoclaw launch");
    });

    it("shows state details when operations have been performed", () => {
      vi.mocked(loadState).mockReturnValue(populatedState());

      const result = handleSlashCommand(makeContext("status"), stubApi);

      expect(result.text).toContain("**NemoClaw Status**");
      expect(result.text).toContain("Last action: migrate");
      expect(result.text).toContain("Blueprint: 0.1.0");
      expect(result.text).toContain("Run ID: run-a1b2c3d4");
      expect(result.text).toContain("Sandbox: openclaw");
    });

    it("includes rollback snapshot when present", () => {
      vi.mocked(loadState).mockReturnValue(populatedState());

      const result = handleSlashCommand(makeContext("status"), stubApi);

      expect(result.text).toContain("Rollback snapshot:");
      expect(result.text).toContain("/root/.nemoclaw/snapshots/pre-migrate.tar.gz");
    });

    it("omits rollback section when no snapshot", () => {
      vi.mocked(loadState).mockReturnValue({
        ...populatedState(),
        migrationSnapshot: null,
      });

      const result = handleSlashCommand(makeContext("status"), stubApi);

      expect(result.text).not.toContain("Rollback snapshot:");
    });
  });

  // =========================================================================
  // Eject
  // =========================================================================
  describe("eject subcommand", () => {
    it("shows 'nothing to eject' when no deployment", () => {
      const result = handleSlashCommand(makeContext("eject"), stubApi);

      expect(result.text).toContain("No NemoClaw deployment found");
    });

    it("shows 'manual rollback required' when no snapshot", () => {
      vi.mocked(loadState).mockReturnValue({
        ...populatedState(),
        migrationSnapshot: null,
        hostBackupPath: null,
      });

      const result = handleSlashCommand(makeContext("eject"), stubApi);

      expect(result.text).toContain("No migration snapshot found");
      expect(result.text).toContain("Manual rollback required");
    });

    it("shows eject instructions with snapshot path", () => {
      vi.mocked(loadState).mockReturnValue(populatedState());

      const result = handleSlashCommand(makeContext("eject"), stubApi);

      expect(result.text).toContain("**Eject from NemoClaw**");
      expect(result.text).toContain("openclaw nemoclaw eject --confirm");
      expect(result.text).toContain("/root/.nemoclaw/snapshots/pre-migrate.tar.gz");
    });

    it("falls back to hostBackupPath when no migrationSnapshot", () => {
      vi.mocked(loadState).mockReturnValue({
        ...populatedState(),
        migrationSnapshot: null,
      });

      const result = handleSlashCommand(makeContext("eject"), stubApi);

      expect(result.text).toContain("/root/.nemoclaw/backups/host-backup");
    });
  });

  // =========================================================================
  // Onboard
  // =========================================================================
  describe("onboard subcommand", () => {
    it("shows setup instructions when no config", () => {
      const result = handleSlashCommand(makeContext("onboard"), stubApi);

      expect(result.text).toContain("**NemoClaw Onboarding**");
      expect(result.text).toContain("No configuration found");
      expect(result.text).toContain("openclaw nemoclaw onboard");
    });

    it("shows current onboard config when configured", () => {
      vi.mocked(loadOnboardConfig).mockReturnValue({
        endpointType: "build",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        ncpPartner: null,
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-15T10:00:00.000Z",
      });

      const result = handleSlashCommand(makeContext("onboard"), stubApi);

      expect(result.text).toContain("**NemoClaw Onboard Status**");
      expect(result.text).toContain("Endpoint: build");
      expect(result.text).toContain("Model: nvidia/nemotron-3-super-120b-a12b");
      expect(result.text).toContain("$NVIDIA_API_KEY");
    });

    it("includes NCP partner when present", () => {
      vi.mocked(loadOnboardConfig).mockReturnValue({
        endpointType: "ncp",
        endpointUrl: "https://partner.api.nvidia.com/v1",
        ncpPartner: "acme-corp",
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "ncp",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-15T10:00:00.000Z",
      });

      const result = handleSlashCommand(makeContext("onboard"), stubApi);

      expect(result.text).toContain("NCP Partner: acme-corp");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe("edge cases", () => {
    it("trims whitespace from args", () => {
      const result = handleSlashCommand(makeContext("  status  "), stubApi);

      expect(result.text).toContain("No operations performed yet");
    });

    it("uses first word only as subcommand", () => {
      const result = handleSlashCommand(makeContext("status extra args"), stubApi);

      expect(result.text).toContain("No operations performed yet");
    });
  });
});
