// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn().mockResolvedValue("yes"),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true }),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("../credentials", () => ({ prompt: mocks.prompt }));
vi.mock("../global-cli-actions", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

import CredentialsCommand from "./credentials";
import CredentialsListCommand from "./credentials/list";
import CredentialsResetCommand from "./credentials/reset";

const rootDir = process.cwd();

describe("credentials oclif adapter source coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true });
    mocks.runOpenshellProviderCommand.mockReturnValue({ status: 0, stdout: "nvidia-prod\n" });
  });

  it("prints top-level credentials usage", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await CredentialsCommand.run([], rootDir);

    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    log.mockRestore();
    expect(output).toContain("Usage: nemoclaw credentials <subcommand>");
    expect(output).toContain("reset <PROVIDER> [--yes]");
  });

  it("lists credential providers while hiding messaging bridge providers", async () => {
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 0,
      stdout: "alpha-telegram-bridge\nnvidia-prod\nopenai-prod\n",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await CredentialsListCommand.run([], rootDir);

    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith();
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(["provider", "list", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    log.mockRestore();
    expect(output).toContain("nvidia-prod");
    expect(output).toContain("openai-prod");
    expect(output).toContain("1 per-sandbox messaging bridge");
    expect(output).not.toContain("alpha-telegram-bridge\n");
  });

  it("deletes provider credentials with --yes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await CredentialsResetCommand.run(["nvidia-prod", "--yes"], rootDir);

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(["provider", "delete", "nvidia-prod"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    log.mockRestore();
    expect(output).toContain("Removed provider 'nvidia-prod'");
  });
});
