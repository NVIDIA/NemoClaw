// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpMigrationPlan } from "./mcp-bridge-migration";

const mocks = vi.hoisted(() => ({
  migrateMcpBridges: vi.fn(),
}));

vi.mock("./mcp-bridge-migration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-migration")>()),
  migrateMcpBridges: mocks.migrateMcpBridges,
}));

import { dispatchMcpBridgeCommand } from "./mcp-bridge";

const SECRET_URL =
  "https://legacy-user:legacy-pass@mcp.example.test/bot123456:AAAAsecretpath/?access_token=querysecret#hashsecret";
const SECRET_FREE_URL = "https://mcp.example.test/mcp";

function migrationPlan(url: string, applied = false): McpMigrationPlan {
  return {
    sandbox: "alpha",
    applied,
    items: [
      {
        server: "legacy-bot",
        agent: "openclaw",
        source: "legacy-agent",
        destination: "native",
        url,
        credentialEnv: "LEGACY_BOT_TOKEN",
        policyName: "mcp-bridge-legacy-bot",
        policyPresent: false,
        providerName: null,
        providerAttached: null,
        deniedTools: [],
        activationChanges: false,
        action: "migrate",
      },
    ],
  };
}

async function renderMigratePreview(): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await dispatchMcpBridgeCommand("alpha", ["migrate"]);
    return log.mock.calls.map(([line]) => String(line)).join("\n");
  } finally {
    log.mockRestore();
  }
}

async function renderMigrateJson(): Promise<string> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await dispatchMcpBridgeCommand("alpha", ["migrate", "--json"]);
    return write.mock.calls.map(([chunk]) => String(chunk)).join("");
  } finally {
    write.mockRestore();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.migrateMcpBridges.mockResolvedValue(migrationPlan(SECRET_URL));
});

describe("MCP migration display redaction", () => {
  it("redacts secret-bearing legacy URLs in the migrate preview", async () => {
    const output = await renderMigratePreview();

    expect(output).toContain("Migrate 'legacy-bot': legacy -> native (");
    expect(output).toContain("https://mcp.example.test/");
    expect(output).toContain("REDACTED");
    expect(output).not.toContain("legacy-pass");
    expect(output).not.toContain("AAAAsecretpath");
    expect(output).not.toContain("querysecret");
    expect(output).not.toContain("hashsecret");
    expect(output).toContain("Preview only. Rerun with --apply");
  });

  it("redacts secret-bearing legacy URLs in the migrate --json plan", async () => {
    const captured = await renderMigrateJson();
    const parsed = JSON.parse(captured) as McpMigrationPlan;

    expect(parsed.sandbox).toBe("alpha");
    expect(parsed.applied).toBe(false);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      server: "legacy-bot",
      action: "migrate",
      credentialEnv: "LEGACY_BOT_TOKEN",
    });
    expect(parsed.items[0].url).toContain("https://mcp.example.test/");
    expect(parsed.items[0].url).toContain("REDACTED");
    expect(captured).not.toContain("legacy-pass");
    expect(captured).not.toContain("AAAAsecretpath");
    expect(captured).not.toContain("querysecret");
    expect(captured).not.toContain("hashsecret");
  });

  it("keeps secret-free legacy URLs readable in both outputs", async () => {
    mocks.migrateMcpBridges.mockResolvedValue(migrationPlan(SECRET_FREE_URL));

    const preview = await renderMigratePreview();
    expect(preview).toContain(`legacy -> native (${SECRET_FREE_URL})`);

    const json = JSON.parse(await renderMigrateJson()) as McpMigrationPlan;
    expect(json.items[0].url).toBe(SECRET_FREE_URL);
  });
});
