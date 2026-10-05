// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createBlueprintOpenShellCli,
  type BlueprintOpenShellCommandOptions,
} from "./openshell-cli.js";

const success = { exitCode: 0, stdout: "", stderr: "" };

describe("blueprint OpenShell CLI boundary", () => {
  it("keeps bounded gateway and global-policy inspections on the selected gateway", async () => {
    const calls: Array<{ args: string[]; options?: BlueprintOpenShellCommandOptions }> = [];
    const client = createBlueprintOpenShellCli({
      capture: async (args, options) => {
        calls.push({ args, options });
        return success;
      },
    });
    const inspection = { maxBuffer: 1_048_576, timeout: 30_000 };

    await client.inspectGateway("reviewed-gateway", inspection);
    await client.inspectGlobalPolicyHistory("reviewed-gateway", inspection);
    await client.readActiveGlobalPolicy("reviewed-gateway", inspection);

    expect(calls).toEqual([
      {
        args: ["openshell", "gateway", "info", "-g", "reviewed-gateway"],
        options: { gateway: "reviewed-gateway", ...inspection, reject: false },
      },
      {
        args: ["openshell", "policy", "list", "-g", "reviewed-gateway", "--global", "--limit", "1"],
        options: { gateway: "reviewed-gateway", ...inspection, reject: false },
      },
      {
        args: [
          "openshell",
          "policy",
          "get",
          "-g",
          "reviewed-gateway",
          "--global",
          "--full",
          "--output",
          "json",
        ],
        options: { gateway: "reviewed-gateway", ...inspection, reject: false },
      },
    ]);
  });

  it("preserves sandbox and inference arguments without exposing provider credentials", async () => {
    const calls: Array<{ args: string[]; options?: BlueprintOpenShellCommandOptions }> = [];
    const client = createBlueprintOpenShellCli({
      capture: async (args, options) => {
        calls.push({ args, options });
        return success;
      },
    });

    await client.createSandbox({
      gatewayName: "reviewed-gateway",
      image: "reviewed-image",
      name: "reviewed-sandbox",
      policyPath: "/tmp/reviewed-policy.yaml",
      forwardPorts: [18789, 8080],
    });
    await client.createInferenceProvider({
      gatewayName: "reviewed-gateway",
      name: "reviewed-provider",
      type: "openai",
      credential: "provider-secret",
      endpoint: "https://inference.example.com/v1",
    });
    await client.setInferenceRoute({
      gatewayName: "reviewed-gateway",
      provider: "reviewed-provider",
      model: "reviewed-model",
      timeoutSeconds: 120,
    });

    expect(calls[0]).toEqual({
      args: [
        "openshell",
        "sandbox",
        "create",
        "-g",
        "reviewed-gateway",
        "--from",
        "reviewed-image",
        "--name",
        "reviewed-sandbox",
        "--policy",
        "/tmp/reviewed-policy.yaml",
        "--forward",
        "18789",
        "--forward",
        "8080",
      ],
      options: {
        gateway: "reviewed-gateway",
        omitSandboxPolicy: true,
        reject: false,
      },
    });
    expect(calls[1]).toEqual({
      args: [
        "openshell",
        "provider",
        "create",
        "--name",
        "reviewed-provider",
        "--type",
        "openai",
        "--credential",
        "OPENAI_API_KEY",
        "--config",
        "OPENAI_BASE_URL=https://inference.example.com/v1",
      ],
      options: {
        gateway: "reviewed-gateway",
        env: { OPENAI_API_KEY: "provider-secret" },
        reject: false,
      },
    });
    expect(calls[1]?.args).not.toContain("provider-secret");
    expect(calls[2]?.args).toEqual([
      "openshell",
      "inference",
      "set",
      "--provider",
      "reviewed-provider",
      "--model",
      "reviewed-model",
      "--timeout",
      "120",
    ]);
  });

  it("passes runtime refresh secrets only through the scoped command environment", async () => {
    const calls: Array<{ args: string[]; options?: BlueprintOpenShellCommandOptions }> = [];
    const client = createBlueprintOpenShellCli({
      capture: async (args, options) => {
        calls.push({ args, options });
        return success;
      },
    });

    await client.configureProviderRefresh({
      gatewayName: "reviewed-gateway",
      providerName: "runtime-provider",
      credentialKey: "ACCESS_TOKEN",
      clientId: "public-client-id",
      refreshTokenEnvironmentName: "REFRESH_TOKEN",
      refreshToken: "refresh-secret",
      clientSecretEnvironmentName: "CLIENT_SECRET",
      clientSecret: "client-secret",
    });

    const { args, options } = calls[0]!;
    expect(args).toEqual([
      "openshell",
      "provider",
      "refresh",
      "configure",
      "runtime-provider",
      "--credential-key",
      "ACCESS_TOKEN",
      "--strategy",
      "oauth2-refresh-token",
      "--material",
      "client_id=public-client-id",
      "--secret-material-env",
      "refresh_token=REFRESH_TOKEN",
      "--secret-material-env",
      "client_secret=CLIENT_SECRET",
    ]);
    expect(args).not.toContain("refresh-secret");
    expect(args).not.toContain("client-secret");
    expect(options?.env).toEqual({
      REFRESH_TOKEN: "refresh-secret",
      CLIENT_SECRET: "client-secret",
    });
  });
});
