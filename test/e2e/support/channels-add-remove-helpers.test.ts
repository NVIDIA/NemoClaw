// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { captureSandboxFailureDiagnostics } from "../fixtures/sandbox-failure-diagnostics.ts";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  openClawHasConfiguredTelegram,
  telegramArtifactContainsCredential,
  type OpenClawTelegramState,
} from "../live/channels-add-remove-helpers.ts";

const UNCONFIGURED: OpenClawTelegramState = {
  accountPresent: false,
  accountEnabled: false,
  channelEnabled: false,
  channelPresent: true,
  credentialPresent: false,
  pluginEnabled: false,
  pluginPresent: true,
};

describe("channels-add-remove Telegram configuration predicate", () => {
  it("treats bundled disabled channel and plugin entries as unconfigured (#9361)", () => {
    expect(openClawHasConfiguredTelegram(UNCONFIGURED)).toBe(false);
  });

  it.each([
    ["enabled channel without plugin activation", { channelEnabled: true }],
    ["enabled plugin without channel activation", { pluginEnabled: true }],
    ["present account without enabled flags", { accountPresent: true }],
    ["enabled account without enabled flags", { accountEnabled: true }],
    ["credential reference without enabled flags", { credentialPresent: true }],
  ])("treats %s as configured residue (#9361)", (_case, overrides) => {
    expect(openClawHasConfiguredTelegram({ ...UNCONFIGURED, ...overrides })).toBe(true);
  });

  it("does not treat physical channel absence as proof when account residue remains (#9361)", () => {
    expect(
      openClawHasConfiguredTelegram({
        ...UNCONFIGURED,
        channelPresent: false,
        accountPresent: true,
      }),
    ).toBe(true);
  });
});

describe("Telegram artifact credential detection", () => {
  const token = "test-fake-telegram-token-add-remove-e2e";

  it("accepts retained probe code that contains a placeholder regex without a credential", () => {
    const artifacts = new ArtifactSink("/tmp/unused-telegram-artifact-test", [token]);
    const evidence = artifacts.redact(
      JSON.stringify({
        command: [
          "python3",
          "-c",
          "re.fullmatch(r'openshell:resolve:env:v[0-9]+_TELEGRAM_BOT_TOKEN', runtime_token)",
        ],
        stdout: '{"runtimeCredentialState":"revision-scoped"}',
      }),
    );
    expect(telegramArtifactContainsCredential(evidence, token)).toBe(false);
  });

  it.each([
    token,
    "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    "openshell:resolve:env:v4242_TELEGRAM_BOT_TOKEN",
    `openshell:resolve:env:s${"a".repeat(64)}_TELEGRAM_BOT_TOKEN`,
    "OPENSHELL-RESOLVE-ENV-v7_TELEGRAM_BOT_TOKEN",
  ])("detects credential material in retained artifacts [case %#]", (credential) => {
    expect(telegramArtifactContainsCredential(JSON.stringify({ stdout: credential }), token)).toBe(
      true,
    );
  });
});

describe("Telegram rebuild failure diagnostics", () => {
  it("preserves a failed backup when diagnostic transport is unavailable", async () => {
    const host = {
      openshellCommandPath: "/fixture/openshell",
      command: vi
        .fn<HostCliClient["command"]>()
        .mockRejectedValue(new Error("diagnostic transport unavailable")),
    };
    const result = {
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "backup failed before archive capture",
    };
    const token = "synthetic-telegram-diagnostic-secret";
    await captureSandboxFailureDiagnostics(host, result, {
      sandboxName: "alpha",
      artifactPrefix: "phase-3-rebuild-add-failure",
      redactionValues: [token],
      captureGatewayLog: true,
    });

    expect(host.command).toHaveBeenCalledWith(
      host.openshellCommandPath,
      ["logs", "alpha", "-n", "200", "--source", "all", "--since", "2m"],
      expect.objectContaining({
        redactionValues: [token],
        captureLimitBytes: 32_768,
        timeoutMs: 30_000,
      }),
    );
    expect(host.command).toHaveBeenCalledWith(
      "cat",
      expect.any(Array),
      expect.objectContaining({
        redactionValues: [token],
        captureLimitBytes: 32_768,
        timeoutMs: 5_000,
      }),
    );
    expect(() => assertExitZero(result, "rebuild after Telegram add")).toThrow(
      "backup failed before archive capture",
    );
  });

  it("does not run failure diagnostics after a successful rebuild", async () => {
    const host = {
      openshellCommandPath: "/fixture/openshell",
      command: vi.fn<HostCliClient["command"]>(),
    };
    await captureSandboxFailureDiagnostics(
      host,
      { exitCode: 0, timedOut: false },
      {
        sandboxName: "alpha",
        artifactPrefix: "phase-3-rebuild-add-failure",
        redactionValues: [],
        captureGatewayLog: true,
      },
    );
    expect(host.command).not.toHaveBeenCalled();
  });
});
