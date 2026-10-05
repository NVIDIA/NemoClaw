// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createCliOpenShellProviderAdapter,
  type RunProviderCommand,
} from "../adapters/openshell/provider-adapter-cli";

import {
  inspectGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
  matchesGatewayProviderBinding,
  parseGatewayProviderMetadata,
  readGatewayProviderMetadata,
} from "./gateway-provider-metadata";

const COMPLETE_OUTPUT = [
  "\u001b[36mProvider:\u001b[0m",
  "  \u001b[2mId:\u001b[0m 2ca3b7c7-eff4-4399-af5a-13c4984d7343",
  "  \u001b[2mName:\u001b[0m compatible-endpoint",
  "  \u001b[2mType:\u001b[0m openai",
  "  \u001b[2mResource version:\u001b[0m 1",
  "  \u001b[2mCredential keys:\u001b[0m COMPATIBLE_API_KEY",
  "  \u001b[2mConfig keys:\u001b[0m OPENAI_BASE_URL, EXTRA_FLAG",
].join("\n");

function providerAdapter(run: RunProviderCommand) {
  return createCliOpenShellProviderAdapter({ run });
}

describe("gateway provider metadata", () => {
  it("matches only an exact non-secret provider binding (#6289)", () => {
    const metadata = parseGatewayProviderMetadata(
      "Name: compatible-anthropic-endpoint\nType: openai\nCredential keys: COMPATIBLE_ANTHROPIC_API_KEY\nConfig keys: OPENAI_BASE_URL",
    );
    const expected = {
      name: "compatible-anthropic-endpoint",
      type: "openai",
      credentialKey: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "OPENAI_BASE_URL",
    };

    expect(matchesGatewayProviderBinding(metadata, expected)).toBe(true);
    expect(matchesGatewayProviderBinding({ ...metadata!, type: "anthropic" }, expected)).toBe(
      false,
    );
    expect(
      matchesGatewayProviderBinding(
        { ...metadata!, configKeys: ["OPENAI_BASE_URL", "EXTRA_FLAG"] },
        expected,
      ),
    ).toBe(false);
  });

  it("matches only an exact credential-only provider binding", () => {
    const metadata = {
      name: "alpha-telegram-bridge",
      type: "generic",
      credentialKeys: ["TELEGRAM_BOT_TOKEN"],
      configKeys: [],
    };
    const expected = {
      name: "alpha-telegram-bridge",
      type: "generic",
      credentialKey: "TELEGRAM_BOT_TOKEN",
    };

    expect(matchesGatewayCredentialOnlyProviderBinding(metadata, expected)).toBe(true);
    expect(matchesGatewayCredentialOnlyProviderBinding(null, expected)).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding(
        { ...metadata, name: "other-provider" },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding({ ...metadata, type: "brave" }, expected),
    ).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding(
        { ...metadata, credentialKeys: ["OTHER_TOKEN"] },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding({ ...metadata, credentialKeys: [] }, expected),
    ).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding(
        { ...metadata, credentialKeys: ["TELEGRAM_BOT_TOKEN", "OTHER_TOKEN"] },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesGatewayCredentialOnlyProviderBinding(
        { ...metadata, configKeys: ["EXTRA_CONFIG"] },
        expected,
      ),
    ).toBe(false);
  });

  it("distinguishes exact, missing, incompatible, and indeterminate credential providers", async () => {
    const expected = {
      name: "alpha-telegram-bridge",
      type: "nemoclaw-mcp-v1",
      credentialKey: "TELEGRAM_BOT_TOKEN",
    };
    const exact =
      "Name: alpha-telegram-bridge\nType: nemoclaw-mcp-v1\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n";

    expect(
      await inspectGatewayCredentialFamilyProviderBinding(
        expected,
        providerAdapter(() => ({ status: 0, stdout: exact })),
      ),
    ).toEqual({ kind: "exact" });
    expect(
      await inspectGatewayCredentialFamilyProviderBinding(
        expected,
        providerAdapter(() => ({
          status: 0,
          stdout: exact.replace("Type: nemoclaw-mcp-v1", "Type: generic"),
        })),
      ),
    ).toEqual({ kind: "collision" });
    expect(
      await inspectGatewayCredentialFamilyProviderBinding(
        expected,
        providerAdapter(() => ({
          status: 1,
          stderr:
            "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
        })),
      ),
    ).toEqual({ kind: "missing" });
    expect(
      await inspectGatewayCredentialFamilyProviderBinding(
        expected,
        providerAdapter(() => ({
          status: 1,
          stderr: 'Error: status: Unavailable, message: "provider not found"',
        })),
      ),
    ).toEqual({ kind: "indeterminate" });
    expect(
      await inspectGatewayCredentialFamilyProviderBinding(
        expected,
        providerAdapter(() => {
          throw new Error("transport failure");
        }),
      ),
    ).toEqual({ kind: "indeterminate" });
  });

  it("parses one complete ANSI-decorated provider identity", () => {
    expect(parseGatewayProviderMetadata(COMPLETE_OUTPUT)).toEqual({
      name: "compatible-endpoint",
      type: "openai",
      credentialKeys: ["COMPATIBLE_API_KEY"],
      configKeys: ["OPENAI_BASE_URL", "EXTRA_FLAG"],
    });
  });

  it.each([
    [
      "OSC injection inside the provider name",
      "Name: comp\u001b]8;;https://attacker.invalid\u0007atible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL",
    ],
    [
      "CSI injection inside the provider name",
      "Name: compat\u001b[31mi\u001b[0mble-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL",
    ],
    [
      "CSI injection inside a binding key",
      "Name: compatible-endpoint\nType: openai\nCredential keys: COMPATIBLE_\u001b[1mAPI_KEY\u001b[0m\nConfig keys: OPENAI_BASE_URL",
    ],
    [
      "null byte inside the provider name",
      "Name: compat\u0000ible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL",
    ],
    [
      "Unicode lookalike inside the provider name",
      "Name: compat\u0456ble-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL",
    ],
  ])("rejects adversarial %s", async (_label, output) => {
    expect(parseGatewayProviderMetadata(output)).toBeNull();
    expect(
      await readGatewayProviderMetadata(
        "compatible-endpoint",
        providerAdapter(() => ({ status: 0, stdout: output })),
      ),
    ).toBeNull();
  });

  it("parses syntactic binding identity without authorizing provider-specific reuse", () => {
    // Semantic matching requires the selected provider and therefore belongs
    // to assessRecoveredProviderCredentialReuse. Its regression test feeds
    // this exact spoof through the parser and proves the decision is rejected.
    expect(
      parseGatewayProviderMetadata(
        "Name: compatible-endpoint\nType: openai\nCredential keys: ATTACKER_KEY\nConfig keys: ATTACKER_BASE_URL",
      ),
    ).toEqual({
      name: "compatible-endpoint",
      type: "openai",
      credentialKeys: ["ATTACKER_KEY"],
      configKeys: ["ATTACKER_BASE_URL"],
    });
  });

  it("reads only the exact requested provider without exposing command output", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: Buffer.from(COMPLETE_OUTPUT) }));

    expect(
      await readGatewayProviderMetadata("compatible-endpoint", providerAdapter(runOpenshell)),
    ).toEqual(parseGatewayProviderMetadata(COMPLETE_OUTPUT));
    expect(runOpenshell).toHaveBeenCalledWith(["provider", "get", "compatible-endpoint"], {
      ignoreError: true,
      maxBuffer: 64 * 1024,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  });

  it("scopes provider inspection to an explicit non-default gateway", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: COMPLETE_OUTPUT }));

    expect(
      await readGatewayProviderMetadata(
        "compatible-endpoint",
        providerAdapter(runOpenshell),
        "nemoclaw-9090",
      ),
    ).toEqual(parseGatewayProviderMetadata(COMPLETE_OUTPUT));
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "get", "-g", "nemoclaw-9090", "compatible-endpoint"],
      {
        ignoreError: true,
        maxBuffer: 64 * 1024,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
  });

  it("accepts providers with no credential or config bindings", () => {
    expect(
      parseGatewayProviderMetadata(
        "Name: local-provider\nType: openai\nCredential keys: <none>\nConfig keys: <none>",
      ),
    ).toEqual({
      name: "local-provider",
      type: "openai",
      credentialKeys: [],
      configKeys: [],
    });
  });

  it.each([
    ["incomplete", "Name: compatible-endpoint\nType: openai"],
    [
      "duplicate field",
      "Name: compatible-endpoint\nName: attacker\nType: openai\nCredential keys: KEY\nConfig keys: BASE",
    ],
    [
      "duplicate key",
      "Name: compatible-endpoint\nType: openai\nCredential keys: KEY, KEY\nConfig keys: BASE",
    ],
    [
      "unsafe provider name",
      "Name: ../provider\nType: openai\nCredential keys: KEY\nConfig keys: BASE",
    ],
    [
      "unsafe provider type",
      "Name: compatible-endpoint\nType: openai shell\nCredential keys: KEY\nConfig keys: BASE",
    ],
    [
      "unsafe binding key",
      "Name: compatible-endpoint\nType: openai\nCredential keys: KEY=value\nConfig keys: BASE",
    ],
  ])("rejects %s output", (_label, output) => {
    expect(parseGatewayProviderMetadata(output)).toBeNull();
  });

  it("rejects oversized provider output", () => {
    expect(parseGatewayProviderMetadata(`${COMPLETE_OUTPUT}\n${"x".repeat(16 * 1024)}`)).toBeNull();
  });

  it("rejects command failures, mismatched names, and unsafe requested names", async () => {
    expect(
      await readGatewayProviderMetadata(
        "compatible-endpoint",
        providerAdapter(() => ({ status: 1 })),
      ),
    ).toBeNull();
    expect(
      await readGatewayProviderMetadata(
        "other-provider",
        providerAdapter(() => ({
          status: 0,
          stdout: COMPLETE_OUTPUT,
        })),
      ),
    ).toBeNull();

    const runOpenshell = vi.fn(() => ({ status: 0, stdout: COMPLETE_OUTPUT }));
    expect(
      await readGatewayProviderMetadata("../compatible-endpoint", providerAdapter(runOpenshell)),
    ).toBeNull();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it.each([
    [
      "exact absence",
      { status: 1, stderr: "provider 'alpha-telegram-bridge' not found" },
      "missing",
    ],
    ["gateway failure", { status: 1, stderr: "gateway unavailable" }, "indeterminate"],
    ["null status", { status: null, stderr: "transport closed" }, "indeterminate"],
  ] as const)(
    "classifies %s without authorizing a create (#9875)",
    async (_label, result, kind) => {
      expect(
        await inspectGatewayCredentialFamilyProviderBinding(
          {
            name: "alpha-telegram-bridge",
            type: "nemoclaw-mcp-v1",
            credentialKey: "TELEGRAM_BOT_TOKEN",
          },
          providerAdapter(() => result),
        ),
      ).toEqual({ kind });
    },
  );
});
