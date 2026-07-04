// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateOpenClawToolSearchRuntime } from "../scripts/validate-openclaw-tool-search.mts";

const EXPECTED_VERSION = "2026.5.27";
const PROGRESSIVE_CONFIG = {
  tools: {
    toolSearch: {
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    },
  },
};

const RUNTIME_FIXTURE_SOURCE = String.raw`
const CONTROL_NAMES = new Set(["tool_search_code", "tool_search", "tool_describe", "tool_call"]);

function readConfig(config) {
  return config && config.tools ? config.tools.toolSearch : undefined;
}

function resolveToolSearchConfig(config) {
  const raw = readConfig(config);
  if (raw === false) {
    return {
      enabled: false,
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    };
  }
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Object.keys(value).length > 0,
    mode: value.mode === "tools" ? "tools" : "code",
    searchDefaultLimit: value.searchDefaultLimit || 8,
    maxSearchLimit: value.maxSearchLimit || 20,
  };
}

function payload(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  };
}

function catalogEntry(tool) {
  return {
    id: "openclaw:core:" + tool.name,
    name: tool.name,
    label: tool.label,
    description: tool.description || "",
    parameters: tool.parameters,
    tool,
  };
}

function findEntry(catalogRef, id) {
  const entries = catalogRef.current || [];
  const entry = entries.find((candidate) => candidate.id === id || candidate.name === id);
  if (!entry) throw new Error("Unknown tool id: " + id);
  return entry;
}

function createOpenClawCodingTools(options) {
  const config = resolveToolSearchConfig(options && options.config);
  if (!options || options.includeToolSearchControls !== true || !config.enabled) return [];
  const catalogRef = options.toolSearchCatalogRef;
  return [
    {
      name: "tool_search_code",
      execute: async () => payload({ mode: "code" }),
    },
    {
      name: "tool_search",
      execute: async (_id, args) => {
        const query = String(args.query || "").toLowerCase();
        const matches = (catalogRef.current || [])
          .filter((entry) =>
            (entry.name + " " + entry.label + " " + entry.description)
              .toLowerCase()
              .includes(query),
          )
          .slice(0, args.limit || config.searchDefaultLimit)
          .map(({ tool, parameters, ...entry }) => entry);
        return payload(matches);
      },
    },
    {
      name: "tool_describe",
      execute: async (_id, args) => {
        const entry = findEntry(catalogRef, args.id);
        return payload({
          id: entry.id,
          name: entry.name,
          label: entry.label,
          description: entry.description,
          parameters: entry.parameters,
        });
      },
    },
    {
      name: "tool_call",
      execute: async (toolCallId, args, signal, onUpdate) => {
        const entry = findEntry(catalogRef, args.id);
        const result = await entry.tool.execute(toolCallId, args.args || {}, signal, onUpdate);
        return payload({
          tool: { id: entry.id, name: entry.name },
          result,
        });
      },
    },
  ];
}

function applyToolSearchCatalog(params) {
  const config = resolveToolSearchConfig(params.config);
  if (!config.enabled) {
    return {
      tools: params.tools,
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
    };
  }
  const visibleNames =
    config.mode === "tools"
      ? new Set(["tool_search", "tool_describe", "tool_call"])
      : new Set(["tool_search_code"]);
  const catalog = params.tools
    .filter((tool) => !CONTROL_NAMES.has(tool.name))
    .map((tool) => catalogEntry(tool));
  params.catalogRef.current = catalog;
  return {
    tools: params.tools.filter((tool) => visibleNames.has(tool.name)),
    compacted: catalog.length > 0,
    catalogToolCount: catalog.length,
    catalogRegistered: true,
  };
}

export {
  resolveToolSearchConfig as _,
  createOpenClawCodingTools as t,
  applyToolSearchCatalog as p,
};
`;

interface FixtureOptions {
  config?: unknown;
  runtimeFileName?: string;
  source?: string;
  version?: string;
  secondSource?: string;
}

let tmpDir: string;
let fixtureNumber = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-search-validator-test-"));
  fixtureNumber = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(options: FixtureOptions = {}) {
  const root = path.join(tmpDir, `fixture-${fixtureNumber++}`);
  const distDir = path.join(root, "dist");
  const configPath = path.join(root, "openclaw.json");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", version: options.version ?? EXPECTED_VERSION }),
  );
  const runtimeSources: ReadonlyArray<readonly [string, string]> = [
    [options.runtimeFileName ?? "pi-tools-fixture.js", options.source ?? RUNTIME_FIXTURE_SOURCE],
    ...(options.secondSource === undefined
      ? []
      : [["pi-tools-second.js", options.secondSource] as const]),
  ];
  for (const [name, source] of runtimeSources) {
    fs.writeFileSync(path.join(distDir, name), source);
  }
  fs.writeFileSync(configPath, JSON.stringify(options.config ?? PROGRESSIVE_CONFIG));
  return { distDir, configPath };
}

async function validateFixture(
  fixture: ReturnType<typeof writeFixture>,
  expectedMode: "progressive" | "direct",
  expectedVersion = EXPECTED_VERSION,
) {
  return validateOpenClawToolSearchRuntime({
    ...fixture,
    expectedMode,
    expectedVersion,
  });
}

describe("OpenClaw Tool Search pinned-runtime validator", () => {
  it("proves structured progressive search, describe, and call through compiled aliases", async () => {
    const result = await validateFixture(writeFixture(), "progressive");

    expect(result.version).toBe(EXPECTED_VERSION);
    expect(result.expectedMode).toBe("progressive");
    expect(result.runtimeModulePath).toMatch(/pi-tools-fixture\.js$/);
    expect(result.visibleToolNames.sort()).toEqual(["tool_call", "tool_describe", "tool_search"]);
  });

  it("proves direct mode preserves the hidden probe without search controls", async () => {
    const fixture = writeFixture({ config: { tools: { toolSearch: false } } });
    const result = await validateFixture(fixture, "direct");

    expect(result.visibleToolNames).toEqual(["nemoclaw_runtime_validator_probe"]);
  });

  it("selects the exact 2026.6.10 agent-tools runtime layout", async () => {
    const fixture = writeFixture({
      runtimeFileName: "agent-tools-fixture.js",
      version: "2026.6.10",
    });
    const result = await validateFixture(fixture, "progressive", "2026.6.10");

    expect(result.runtimeModulePath).toMatch(/agent-tools-fixture\.js$/);
  });

  it("fails closed when package metadata does not match the expected pin", async () => {
    const fixture = writeFixture({ version: "2026.5.28" });

    await expect(validateFixture(fixture, "progressive")).rejects.toThrow(
      /version mismatch.*expected 2026\.5\.27, found 2026\.5\.28/,
    );
  });

  it("fails closed when the compiled source shape or export aliases drift", async () => {
    const missingFunction = writeFixture({
      source: RUNTIME_FIXTURE_SOURCE.replace(
        "function applyToolSearchCatalog(params)",
        "function renamedApplyToolSearchCatalog(params)",
      ),
    });
    await expect(validateFixture(missingFunction, "progressive")).rejects.toThrow(
      /expected exactly one registered OpenClaw 2026\.5\.27 runtime module.*found 0/,
    );

    const missingExport = writeFixture({
      source: RUNTIME_FIXTURE_SOURCE.replace("  applyToolSearchCatalog as p,\n", ""),
    });
    await expect(validateFixture(missingExport, "progressive")).rejects.toThrow(
      /does not export compiled function applyToolSearchCatalog/,
    );

    const duplicate = writeFixture({ secondSource: RUNTIME_FIXTURE_SOURCE });
    await expect(validateFixture(duplicate, "progressive")).rejects.toThrow(
      /expected exactly one registered OpenClaw 2026\.5\.27 runtime module.*found 2/,
    );
  });

  it("fails closed when the pinned version has no reviewed runtime layout", async () => {
    const fixture = writeFixture({ version: "2026.6.11" });

    await expect(validateFixture(fixture, "progressive", "2026.6.11")).rejects.toThrow(
      /no compiled runtime module layout is registered for OpenClaw 2026\.6\.11/,
    );
  });

  it("fails closed for non-exact progressive and direct generated config", async () => {
    const wrongProgressive = writeFixture({
      config: {
        tools: {
          toolSearch: { mode: "tools", searchDefaultLimit: 7, maxSearchLimit: 20 },
        },
      },
    });
    await expect(validateFixture(wrongProgressive, "progressive")).rejects.toThrow(
      /must set tools\.toolSearch to exactly/,
    );

    const wrongDirect = writeFixture();
    await expect(validateFixture(wrongDirect, "direct")).rejects.toThrow(
      /must set tools\.toolSearch to false/,
    );
  });
});
