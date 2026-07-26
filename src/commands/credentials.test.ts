// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn().mockResolvedValue("yes"),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true, attempted: false }),
  runOpenshellProviderCommand: vi.fn(),
  recordExtraProvider: vi.fn(),
  forgetExtraProvider: vi.fn(),
  resolveGatewayCredentialMutationAuthority: vi.fn(),
}));

vi.mock("../lib/credentials/store", () => ({
  KNOWN_CREDENTIAL_ENV_KEYS: ["NVIDIA_INFERENCE_API_KEY"],
  prompt: mocks.prompt,
}));
vi.mock("../lib/actions/global", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
  recordExtraProvider: mocks.recordExtraProvider,
  forgetExtraProvider: mocks.forgetExtraProvider,
}));
vi.mock("../lib/onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: mocks.resolveGatewayCredentialMutationAuthority,
}));

import { runCredentialsAddAction } from "../lib/actions/credentials-add";
import CredentialsCommand from "./credentials";
import CredentialsListCommand from "./credentials/list";
import CredentialsResetCommand from "./credentials/reset";

const rootDir = process.cwd();

describe("credentials oclif adapter source coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true, attempted: false });
    mocks.runOpenshellProviderCommand.mockReturnValue({ status: 0, stdout: "nvidia-prod\n" });
    mocks.resolveGatewayCredentialMutationAuthority.mockReturnValue({});
    process.exitCode = undefined;
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
    expect(mocks.resolveGatewayCredentialMutationAuthority).not.toHaveBeenCalled();
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(
      ["provider", "list", "--names"],
      {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
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
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(
      ["provider", "delete", "nvidia-prod"],
      {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    log.mockRestore();
    expect(output).toContain("Removed provider 'nvidia-prod'");
  });

  it("rejects add and reset before provider mutation when the gateway is healthy but authority changed since onboarding (#6576)", async () => {
    mocks.resolveGatewayCredentialMutationAuthority.mockImplementation(() => {
      throw new Error(
        "Gateway lifecycle authority changed since onboarding; provider credential mutation will not perform gateway effects.",
      );
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const add = await runCredentialsAddAction({
      provider: "custom-provider",
      type: "custom",
      credentials: [],
      configPairs: [],
      fromExisting: true,
    });
    await CredentialsResetCommand.run(["nvidia-prod", "--yes"], rootDir);

    expect(add.exitCode).toBe(1);
    expect(add.failureLines.join("\n")).toContain(
      "gateway lifecycle authority could not be revalidated",
    );
    expect(mocks.resolveGatewayCredentialMutationAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).toContain(
      "gateway lifecycle authority could not be revalidated",
    );
  });
});
