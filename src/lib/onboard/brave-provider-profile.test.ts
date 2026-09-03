// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import {
  BRAVE_PROVIDER_PROFILE_ID,
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
  shouldEnableWebSearch,
  TAVILY_PROVIDER_PROFILE_ID,
  webSearchProviderProfilePath,
} from "./brave-provider-profile";

type RunResult = { status: number; stderr: string; stdout: string };

const PROFILE_ABSENT: RunResult = {
  status: 1,
  stderr: "custom provider profile not found",
  stdout: "",
};
const IMPORTED: RunResult = { status: 0, stderr: "", stdout: "" };

/** A minimal, internally-consistent credential boundary for a given profile id. */
function boundary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    credentials: [
      {
        name: "api_key",
        env_vars: [`${id.toUpperCase()}_API_KEY`],
        required: true,
        auth_style: "header",
        header_name: "x-api-key",
        query_param: "",
      },
    ],
    endpoints: [{ host: `api.${id}.example`, port: 443, protocol: "rest", access: "read-write" }],
    binaries: ["/usr/bin/node"],
    inference_capable: false,
    ...overrides,
  };
}

/**
 * The checked-in YAML `readFileSync` should return for each provider id, by
 * default — every "already registered" fixture below claims a matching
 * export unless a test explicitly builds a drifted one, so this is what
 * every id-aware probe response is compared against.
 */
function makeReadFileSync(perProvider: Record<string, unknown> = {}) {
  return vi.fn((file: string) => {
    const id = WEB_SEARCH_IDS.find((candidate) => file.endsWith(`${candidate}.yaml`));
    return YAML.stringify(perProvider[id ?? ""] ?? boundary(id ?? "unknown"));
  });
}

const WEB_SEARCH_IDS = [
  BRAVE_PROVIDER_PROFILE_ID,
  TAVILY_PROVIDER_PROFILE_ID,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
] as const;

/**
 * Answer the existence probe per the exact profile id the call names —
 * catches a probe that hardcodes one provider id instead of using the
 * loop variable, which a call-shape-only mock cannot (#10371). Registered
 * ids answer with a matching boundary by default so the new drift check
 * doesn't fail every pre-existing "already registered" test; pass an
 * override to test the mismatch path itself.
 */
function makeRunOpenshell(
  registeredIds: readonly string[],
  importResult: RunResult,
  registeredBoundaryOverrides: Record<string, Record<string, unknown>> = {},
) {
  const importedIds = new Set<string>();
  return vi.fn((args: string[]) => {
    const exportIndex = args.indexOf("export");
    const probedId = exportIndex === -1 ? null : (args[exportIndex + 1] ?? "");
    const file = args[args.indexOf("--file") + 1] ?? "";
    const importedId = WEB_SEARCH_IDS.find((candidate) => file.endsWith(`${candidate}.yaml`));
    const shouldRecordImport = importResult.status === 0 && importedId !== undefined;
    shouldRecordImport && importedIds.add(importedId);
    return probedId === null
      ? importResult
      : registeredIds.includes(probedId) || importedIds.has(probedId)
        ? {
            status: 0,
            stderr: "",
            stdout: JSON.stringify(boundary(probedId, registeredBoundaryOverrides[probedId] ?? {})),
          }
        : PROFILE_ABSENT;
  });
}

function importCalls(
  runOpenshell: ReturnType<typeof vi.fn>,
): Array<{ args: string[]; options: Record<string, unknown> }> {
  return runOpenshell.mock.calls
    .map(([args, options]) => ({
      args: args as string[],
      options: options as Record<string, unknown>,
    }))
    .filter(({ args }) => args.includes("import"));
}

function importCallArgs(runOpenshell: ReturnType<typeof vi.fn>): string[][] {
  return importCalls(runOpenshell).map(({ args }) => args);
}

function loggedText(deps: Parameters<typeof ensureWebSearchProviderProfiles>[1]): string {
  return (deps.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
}

function makeDeps(runOpenshell: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    root: "/repo",
    runOpenshell,
    redact: (s: string) => s,
    log: vi.fn(),
    exit: vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }),
    readFileSync: makeReadFileSync(),
    ...overrides,
  } as Parameters<typeof ensureWebSearchProviderProfiles>[1];
}

describe("ensureWebSearchProviderProfiles", () => {
  it("does nothing without a selected web-search credential", () => {
    const runOpenshell = vi.fn();
    ensureWebSearchProviderProfiles(
      [
        { providerType: "generic", token: "token" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: null },
      ],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reconciles each selected web-search profile through its checked-in path (#10371)", () => {
    const runOpenshell = makeRunOpenshell(
      [BRAVE_PROVIDER_PROFILE_ID, TAVILY_PROVIDER_PROFILE_ID],
      IMPORTED,
    );
    ensureWebSearchProviderProfiles(
      [
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brave" },
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tavily" },
      ],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", BRAVE_PROVIDER_PROFILE_ID, "--output", "json"],
      ["provider", "profile", "export", TAVILY_PROVIDER_PROFILE_ID, "--output", "json"],
    ]);
  });

  it("uses the versioned Hermes Tavily profile path", () => {
    const runOpenshell = makeRunOpenshell([HERMES_TAVILY_PROVIDER_PROFILE_ID], IMPORTED);
    ensureWebSearchProviderProfiles(
      [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tavily" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", HERMES_TAVILY_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it("redacts a profile probe failure without importing (#10371)", () => {
    const runOpenshell = vi.fn(() => ({
      status: null,
      stderr: "secret-value",
      error: new Error("ETIMEDOUT"),
    }));
    const deps = makeDeps(runOpenshell, {
      redact: (text: string) => text.replaceAll("secret-value", "[REDACTED]"),
    });
    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brave" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(loggedText(deps)).toContain("[REDACTED]");
    expect(loggedText(deps)).not.toContain("secret-value");
    expect(importCalls(runOpenshell)).toEqual([]);
  });
});

describe("shouldEnableWebSearch", () => {
  it("returns false for null/undefined web search config", () => {
    expect(shouldEnableWebSearch(null)).toBe(false);
    expect(shouldEnableWebSearch(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is missing or falsy", () => {
    // Regression for #3626: a `{ fetchEnabled: false }` config previously
    // tripped `if (webSearchConfig)` in createSandbox and pushed a Brave
    // provider/token plus the BRAVE_API_KEY abort even though the runtime
    // gate downstream is `fetchEnabled`.
    expect(shouldEnableWebSearch({})).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: false })).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: null })).toBe(false);
  });

  it("returns true only when fetchEnabled is explicitly true", () => {
    expect(shouldEnableWebSearch({ fetchEnabled: true })).toBe(true);
  });
});
