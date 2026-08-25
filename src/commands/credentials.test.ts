// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn().mockResolvedValue("yes"),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true, attempted: false }),
  runOpenshellProviderCommand: vi.fn(),
  recordExtraProvider: vi.fn(),
  forgetExtraProvider: vi.fn(),
  listManagedMcpCredentialReservations: vi.fn<
    () => Array<{ sandboxName: string; server: string; credentialKeys: string[] }>
  >(() => []),
  resolveGatewayCredentialMutationAuthority: vi.fn(),
}));

vi.mock("../lib/credentials/store", () => ({
  KNOWN_CREDENTIAL_ENV_KEYS: ["NVIDIA_INFERENCE_API_KEY"],
  getCredential: vi.fn(),
  prompt: mocks.prompt,
  saveCredential: vi.fn(),
}));
vi.mock("../lib/actions/global", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
  recordExtraProvider: mocks.recordExtraProvider,
  forgetExtraProvider: mocks.forgetExtraProvider,
  listManagedMcpCredentialReservations: mocks.listManagedMcpCredentialReservations,
}));
vi.mock("../lib/adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
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
    mocks.listManagedMcpCredentialReservations.mockReturnValue([]);
    mocks.resolveGatewayCredentialMutationAuthority.mockReturnValue({});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("rejects a provider credential reserved by managed MCP before gateway mutation (#9388)", async () => {
    vi.stubEnv("MAAS_GLEAN_TOKEN", "qa-secret-value");
    mocks.listManagedMcpCredentialReservations.mockReturnValue([
      {
        sandboxName: "hermes",
        server: "maas-glean",
        credentialKeys: ["MAAS_GLEAN_TOKEN"],
      },
    ]);

    const result = await runCredentialsAddAction({
      provider: "maas-glean",
      type: "generic",
      credentials: ["MAAS_GLEAN_TOKEN"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain(
      "Credential key 'MAAS_GLEAN_TOKEN' is reserved by managed MCP server 'maas-glean' on sandbox 'hermes'",
    );
    expect(result.failureLines.join("\n")).not.toContain("qa-secret-value");
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
    expect(mocks.recordExtraProvider).not.toHaveBeenCalled();
  });

  it("rejects --from-existing before gateway work when managed MCP reserves credentials (#9388)", async () => {
    mocks.listManagedMcpCredentialReservations.mockReturnValue([
      {
        sandboxName: "hermes",
        server: "maas-glean",
        credentialKeys: ["MAAS_GLEAN_TOKEN"],
      },
    ]);

    const result = await runCredentialsAddAction({
      provider: "maas-glean",
      type: "generic",
      credentials: [],
      configPairs: [],
      fromExisting: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain(
      "Cannot compare imported provider credentials with keys reserved by managed MCP servers.",
    );
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(mocks.resolveGatewayCredentialMutationAuthority).not.toHaveBeenCalled();
    expect(mocks.recordExtraProvider).not.toHaveBeenCalled();
  });

  it("releases a provider reservation when credential registration fails (#9388)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-secret");
    mocks.recordExtraProvider.mockReturnValueOnce(true);
    mocks.runOpenshellProviderCommand.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "provider creation failed",
    });

    const result = await runCredentialsAddAction({
      provider: "custom-provider",
      type: "generic",
      credentials: ["CUSTOM_TOKEN"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(1);
    expect(mocks.recordExtraProvider).toHaveBeenCalledWith("custom-provider");
    expect(mocks.forgetExtraProvider).toHaveBeenCalledWith("custom-provider");
    expect(mocks.recordExtraProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshellProviderCommand.mock.invocationCallOrder[0],
    );
  });

  it("rejects an incompatible OpenAI profile before provider creation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-secret");
    mocks.runOpenshellProviderCommand.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: "openai",
        credentials: [],
        endpoints: [{ name: "untrusted", url: "https://example.invalid" }],
        binaries: [],
        inference_capable: true,
      }),
      stderr: "",
    });

    const result = await runCredentialsAddAction({
      provider: "openai-prod",
      type: "openai",
      credentials: ["OPENAI_API_KEY"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain(
      "does not match NemoClaw's endpointless inference contract",
    );
    expect(result.failureLines.join("\n")).toContain("then retry this command");
    expect(result.failureLines.join("\n")).not.toContain("onboarding");
    expect(result.failureLines.join("\n")).not.toContain("host-only-secret");
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(
      ["provider", "profile", "export", "openai", "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    expect(mocks.recordExtraProvider).not.toHaveBeenCalled();
  });

  it("stops before provider creation when OpenAI profile inspection times out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-secret");
    mocks.runOpenshellProviderCommand.mockReturnValueOnce({
      status: null,
      stdout: "",
      stderr: "operation timed out",
    });

    const result = await runCredentialsAddAction({
      provider: "openai-prod",
      type: "openai",
      credentials: ["OPENAI_API_KEY"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain("could not be read for validation");
    expect(result.failureLines.join("\n")).toContain("then retry this command");
    expect(result.failureLines.join("\n")).not.toContain("onboarding");
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledOnce();
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledWith(
      ["provider", "profile", "export", "openai", "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    expect(mocks.recordExtraProvider).not.toHaveBeenCalled();
  });

  it("imports a missing OpenAI profile before provider creation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-secret");
    mocks.runOpenshellProviderCommand
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const result = await runCredentialsAddAction({
      provider: "openai-prod",
      type: "openai",
      credentials: ["OPENAI_API_KEY"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(0);
    expect(mocks.runOpenshellProviderCommand.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", "openai", "--output", "json"],
      [
        "provider",
        "profile",
        "import",
        "--file",
        expect.stringMatching(/provider-profiles\/openai\.yaml$/u),
      ],
      [
        "provider",
        "create",
        "--name",
        "openai-prod",
        "--type",
        "openai",
        "--credential",
        "OPENAI_API_KEY",
      ],
    ]);
    expect(
      mocks.runOpenshellProviderCommand.mock.calls.slice(0, 2).map(([, options]) => options),
    ).toEqual([
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    ]);
  });

  it("reports caller-neutral guidance when OpenAI profile import fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-secret");
    mocks.runOpenshellProviderCommand
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "import failed" });

    const result = await runCredentialsAddAction({
      provider: "openai-prod",
      type: "openai",
      credentials: ["OPENAI_API_KEY"],
      configPairs: [],
      fromExisting: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain("could not import the checked-in");
    expect(result.failureLines.join("\n")).toContain("then retry this command");
    expect(result.failureLines.join("\n")).not.toContain("onboarding");
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(2);
    expect(mocks.recordExtraProvider).not.toHaveBeenCalled();
  });
});
