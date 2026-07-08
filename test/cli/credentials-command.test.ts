// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import CredentialsAddCommand from "../../src/commands/credentials/add";
import CredentialsListCommand from "../../src/commands/credentials/list";
import { runCredentialsAddAction } from "../../src/lib/actions/credentials-add";
import { run, runWithInput } from "./helpers";

vi.mock("../../src/lib/actions/global", () => ({
  forgetExtraProvider: vi.fn(),
  recordExtraProvider: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn().mockResolvedValue({ recovered: true }),
  runOpenshellProviderCommand: vi.fn(),
}));

function validateAdd(overrides: Partial<Parameters<typeof runCredentialsAddAction>[0]> = {}) {
  return runCredentialsAddAction({
    provider: "tavily-search",
    type: "tavily",
    credentials: [],
    configPairs: [],
    fromExisting: false,
    ...overrides,
  });
}

describe("credentials CLI dispatch", () => {
  it("credentials help exits 0 and shows credential subcommands", () => {
    const r = run("credentials --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("$ nemoclaw credentials <list|add|reset>");
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("credentials add");
    expect(r.out).toContain("credentials reset");
  });

  it("credentials list declares its help usage and description", () => {
    expect(CredentialsListCommand.usage).toContain("credentials list");
    expect(CredentialsListCommand.description).toContain("List provider credentials");
  });

  it("credentials add declares its help usage, description, and flags", () => {
    expect(CredentialsAddCommand.usage).toContain(
      "credentials add <PROVIDER> --type <TYPE> [--credential ENV_NAME] [--config K=V] [--from-existing]",
    );
    expect(CredentialsAddCommand.description).toContain("Register a provider credential");
    expect(Object.keys(CredentialsAddCommand.flags)).toEqual(
      expect.arrayContaining(["type", "credential", "from-existing"]),
    );
  });

  it("credentials add without provider uses oclif required-arg validation", () => {
    const r = run("credentials add --type tavily --credential TAVILY_API_KEY");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
  });

  it("credentials add requires the type flag in its parser metadata", () => {
    expect(CredentialsAddCommand.flags.type.required).toBe(true);
  });

  it("credentials add without --credential or --from-existing fails with explicit guidance", async () => {
    const result = await validateAdd();
    expect(result.exitCode).not.toBe(0);
    expect(result.failureLines.join("\n")).toContain(
      "At least one --credential KEY or --from-existing is required.",
    );
  });

  it("credentials add rejects --from-existing combined with --credential", async () => {
    const result = await validateAdd({
      provider: "foo",
      credentials: ["FOO_TOKEN"],
      fromExisting: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.failureLines.join("\n")).toContain(
      "--from-existing cannot be combined with --credential.",
    );
  });

  it("credentials add rejects inline KEY=VALUE credentials without echoing the value", () => {
    const r = run(
      "credentials add tavily-search --type tavily --credential TAVILY_API_KEY=tvly-secret-12345",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--credential expects an env variable name, not 'KEY=VALUE'");
    expect(r.out).not.toContain("tvly-secret-12345");
  });

  it("credentials add rejects --credential values that are not uppercase env names", async () => {
    const result = await validateAdd({
      credentials: ["tavily-api-key"],
    });
    const output = result.failureLines.join("\n");
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("--credential must be a valid env variable name");
    expect(output).not.toContain("tavily-api-key");
  });

  it("credentials add never echoes a secret-shaped --credential value", async () => {
    const secretShapedCredential = "tvly-secret-leaked-9999";
    const result = await validateAdd({
      credentials: [secretShapedCredential],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.failureLines.join("\n")).not.toContain(secretShapedCredential);
  });

  it("credentials reset without provider ignores poisoned stdin", () => {
    const r = runWithInput("credentials reset --yes", "/usr/bin/dmesg\n3");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
    expect(r.out).not.toContain("Could not remove provider");
  });
});
