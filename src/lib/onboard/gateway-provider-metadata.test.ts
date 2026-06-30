// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
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

describe("gateway provider metadata", () => {
  it("parses one complete ANSI-decorated provider identity", () => {
    expect(parseGatewayProviderMetadata(COMPLETE_OUTPUT)).toEqual({
      name: "compatible-endpoint",
      type: "openai",
      credentialKeys: ["COMPATIBLE_API_KEY"],
      configKeys: ["OPENAI_BASE_URL", "EXTRA_FLAG"],
    });
  });

  it("strips bounded OSC and CSI sequences before parsing field values", () => {
    const output = [
      "Name: comp\u001b]8;;https://attacker.invalid\u0007atible-endpoint",
      "Type: \u001b[31mopenai\u001b[0m",
      "Credential keys: COMPATIBLE_\u001b[1mAPI_KEY\u001b[0m",
      "Config keys: OPENAI_BASE_URL",
    ].join("\n");

    expect(parseGatewayProviderMetadata(output)).toEqual({
      name: "compatible-endpoint",
      type: "openai",
      credentialKeys: ["COMPATIBLE_API_KEY"],
      configKeys: ["OPENAI_BASE_URL"],
    });
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

  it("reads only the exact requested provider without exposing command output", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: Buffer.from(COMPLETE_OUTPUT) }));

    expect(readGatewayProviderMetadata("compatible-endpoint", runOpenshell)).toEqual(
      parseGatewayProviderMetadata(COMPLETE_OUTPUT),
    );
    expect(runOpenshell).toHaveBeenCalledWith(["provider", "get", "compatible-endpoint"], {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  it("rejects command failures, mismatched names, and unsafe requested names", () => {
    expect(readGatewayProviderMetadata("compatible-endpoint", () => ({ status: 1 }))).toBeNull();
    expect(
      readGatewayProviderMetadata("other-provider", () => ({
        status: 0,
        stdout: COMPLETE_OUTPUT,
      })),
    ).toBeNull();

    const runOpenshell = vi.fn(() => ({ status: 0, stdout: COMPLETE_OUTPUT }));
    expect(readGatewayProviderMetadata("../compatible-endpoint", runOpenshell)).toBeNull();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
