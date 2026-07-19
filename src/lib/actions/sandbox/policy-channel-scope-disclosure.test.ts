// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as defs from "../../agent/defs";
import * as policy from "../../policy";
import * as registry from "../../state/registry";
import { addSandboxChannel } from "./policy-channel";

const WHATSAPP_PRESET = `preset:
  name: whatsapp
  description: "WhatsApp Web WebSocket and media"
network_policies:
  whatsapp:
    name: whatsapp
    endpoints:
      - host: web.whatsapp.com
        port: 443
        access: full
        tls: skip
      - host: raw.githubusercontent.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow:
              method: GET
              path: "/WhiskeySockets/Baileys/master/src/Defaults/index.ts"
    binaries:
      - { path: /usr/local/bin/node }
`;

let exitMock: MockInstance;
let logSpy: MockInstance;

function agentFixture(name: string): defs.AgentDefinition {
  return { name } as defs.AgentDefinition;
}

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitMock = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "sb-scope" });
  vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("openclaw"));
  vi.spyOn(policy, "loadPresetForSandbox").mockReturnValue(WHATSAPP_PRESET);
  vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["whatsapp"]);
  vi.spyOn(policy, "getPresetContentGatewayState").mockReturnValue("absent");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function collectLogOutput(): string {
  return (logSpy.mock.calls as unknown[][]).map((call) => call.map(String).join(" ")).join("\n");
}

describe("channels add --dry-run discloses effective preset egress before mutation (#7179)", () => {
  it("prints every declared endpoint host with its port and mode", async () => {
    await addSandboxChannel("sb-scope", { channel: "whatsapp", dryRun: true });

    const output = collectLogOutput();
    expect(output).toContain("Effective egress that would be opened:");
    expect(output).toContain("- web.whatsapp.com:443 (access: full, tls: skip)");
    expect(output).toContain(
      "- raw.githubusercontent.com:443 (protocol: rest, enforcement: enforce)",
    );
  });

  it("names the narrowly scoped Baileys version-fetch method and path, not just the host", async () => {
    await addSandboxChannel("sb-scope", { channel: "whatsapp", dryRun: true });

    const output = collectLogOutput();
    expect(output).toMatch(
      /allow:\s+GET\s+\/WhiskeySockets\/Baileys\/master\/src\/Defaults\/index\.ts/,
    );
  });

  it("lists declared binaries alongside the endpoints", async () => {
    await addSandboxChannel("sb-scope", { channel: "whatsapp", dryRun: true });

    const output = collectLogOutput();
    expect(output).toContain("binaries:");
    expect(output).toContain("- /usr/local/bin/node");
  });

  it("emits the scope block before the 'would enable channel' summary", async () => {
    await addSandboxChannel("sb-scope", { channel: "whatsapp", dryRun: true });

    const lines = (logSpy.mock.calls as unknown[][]).map((call) => call.map(String).join(" "));
    const scopeHeader = lines.findIndex((line) =>
      line.includes("Effective egress that would be opened:"),
    );
    const wouldEnable = lines.findIndex((line) => line.includes("--dry-run: would enable channel"));
    expect(scopeHeader).toBeGreaterThan(-1);
    expect(wouldEnable).toBeGreaterThan(scopeHeader);
    void exitMock;
  });

  it("does not claim new egress when the channel's preset already matches the live policy (#7179)", async () => {
    vi.spyOn(policy, "getPresetContentGatewayState").mockReturnValue("match");

    await addSandboxChannel("sb-scope", { channel: "whatsapp", dryRun: true });

    const output = collectLogOutput();
    expect(output).not.toContain("Effective egress that would be opened:");
    expect(output).toContain("is already effective; no new egress would be opened.");
  });
});
