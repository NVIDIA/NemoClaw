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
  return vi.fn((args: string[]) => {
    const exportIndex = args.indexOf("export");
    const probedId = exportIndex === -1 ? null : args[exportIndex + 1];
    return probedId === null
      ? importResult
      : registeredIds.includes(probedId)
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
  it("does nothing when no token def is brave-typed", () => {
    const runOpenshell = vi.fn();
    ensureWebSearchProviderProfiles(
      [{ providerType: "generic", token: "tok" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does nothing when the brave token def has no token", () => {
    const runOpenshell = vi.fn();
    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: null }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("imports the Brave profile from the blueprint path on first run", () => {
    const runOpenshell = makeRunOpenshell([], IMPORTED);
    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        webSearchProviderProfilePath("/repo", BRAVE_PROVIDER_PROFILE_ID),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("imports Tavily and Brave profiles when both have tokens", () => {
    const runOpenshell = makeRunOpenshell([], IMPORTED);
    ensureWebSearchProviderProfiles(
      [
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" },
      ],
      makeDeps(runOpenshell),
    );
    expect(importCallArgs(runOpenshell)).toEqual([
      ["provider", "profile", "import", "--file", webSearchProviderProfilePath("/repo", "tavily")],
      [
        "provider",
        "profile",
        "import",
        "--file",
        webSearchProviderProfilePath("/repo", BRAVE_PROVIDER_PROFILE_ID),
      ],
    ]);
  });

  it("uses a versioned Hermes profile instead of accepting a stale Tavily profile", () => {
    const runOpenshell = makeRunOpenshell([], IMPORTED);

    ensureWebSearchProviderProfiles(
      [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
      makeDeps(runOpenshell),
    );

    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        webSearchProviderProfilePath("/repo", HERMES_TAVILY_PROVIDER_PROFILE_ID),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("skips the import when the host already registered the Brave profile (#10371)", () => {
    const runOpenshell = makeRunOpenshell([BRAVE_PROVIDER_PROFILE_ID], IMPORTED);
    const deps = makeDeps(runOpenshell);

    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      deps,
    );

    expect(importCallArgs(runOpenshell)).toEqual([]);
    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("rejects an already-registered profile whose boundary doesn't match the checked-in one (#10371)", () => {
    // A profile ID match alone is not proof it's the same profile this
    // checkout ships — it could be a stale import from an older version,
    // or an unrelated host-global registration that happens to share the
    // name. Skipping on ID alone would silently trust its unverified
    // endpoints, credentials, and binaries.
    const runOpenshell = makeRunOpenshell([BRAVE_PROVIDER_PROFILE_ID], IMPORTED, {
      [BRAVE_PROVIDER_PROFILE_ID]: { endpoints: [{ host: "attacker.example", port: 443 }] },
    });
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(importCallArgs(runOpenshell)).toEqual([]);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("skips the import for every web-search profile the host already registered (#10371)", () => {
    const runOpenshell = makeRunOpenshell(
      [TAVILY_PROVIDER_PROFILE_ID, BRAVE_PROVIDER_PROFILE_ID, HERMES_TAVILY_PROVIDER_PROFILE_ID],
      IMPORTED,
    );
    const deps = makeDeps(runOpenshell);

    ensureWebSearchProviderProfiles(
      [
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" },
        { providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
      ],
      deps,
    );

    expect(importCallArgs(runOpenshell)).toEqual([]);
    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("probes each provider by its own id, not a copy-pasted one (#10371)", () => {
    // Only Brave is registered. A probe that hardcoded one provider's id
    // instead of using the loop variable would wrongly report Tavily and
    // the Hermes Tavily variant as already registered too, and skip both.
    const runOpenshell = makeRunOpenshell([BRAVE_PROVIDER_PROFILE_ID], IMPORTED);

    ensureWebSearchProviderProfiles(
      [
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" },
        { providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
      ],
      makeDeps(runOpenshell),
    );

    expect(importCallArgs(runOpenshell)).toEqual([
      ["provider", "profile", "import", "--file", webSearchProviderProfilePath("/repo", "tavily")],
      [
        "provider",
        "profile",
        "import",
        "--file",
        webSearchProviderProfilePath("/repo", HERMES_TAVILY_PROVIDER_PROFILE_ID),
      ],
    ]);
  });

  it("probes for an existing profile with output suppressed so a rebuild stays quiet (#10371)", () => {
    const runOpenshell = makeRunOpenshell([BRAVE_PROVIDER_PROFILE_ID], IMPORTED);

    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );

    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", BRAVE_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("suppresses the import's own output too, not just the probe's (#10371)", () => {
    const runOpenshell = makeRunOpenshell([], IMPORTED);

    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );

    expect(importCalls(runOpenshell)).toEqual([
      {
        args: [
          "provider",
          "profile",
          "import",
          "--file",
          webSearchProviderProfilePath("/repo", BRAVE_PROVIDER_PROFILE_ID),
        ],
        options: expect.objectContaining({ suppressOutput: true }),
      },
    ]);
  });

  /**
   * A race has three calls in sequence: the initial probe (not found), the
   * import (collides with a concurrent winner), and the post-race re-export
   * that must now find the concurrent winner's matching profile — simulated
   * with a call-order counter rather than `makeRunOpenshell`'s id-keyed
   * lookup, since the same id genuinely answers differently before and
   * after the race.
   */
  function makeRaceRunOpenshell(importResult: RunResult) {
    let exportCalls = 0;
    return vi.fn((args: string[]) => {
      const isExport = args.includes("export");
      exportCalls += isExport ? 1 : 0;
      return !isExport
        ? importResult
        : exportCalls === 1
          ? PROFILE_ABSENT
          : { status: 0, stderr: "", stdout: JSON.stringify(boundary(BRAVE_PROVIDER_PROFILE_ID)) };
    });
  }

  it("treats an existing-profile diagnostic as success when an import loses a race", () => {
    const runOpenshell = makeRaceRunOpenshell({
      status: 1,
      stderr: "custom provider profile 'brave' already exists",
      stdout: "",
    });
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).not.toThrow();
    expect(importCallArgs(runOpenshell)).toHaveLength(1);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("tolerates the existing-profile diagnostic across a wrapped, box-drawn terminal line (#10371)", () => {
    // OpenShell can wrap styled output across a box-drawing continuation
    // (│) depending on terminal width/TTY-ness (#10159's failure shape).
    // The plain, unnormalized substring test that guarded this same race
    // before #10371 would miss "already exists" split across a line break
    // like this and fall through to a hard failure instead of tolerating
    // the race.
    const runOpenshell = makeRaceRunOpenshell({
      status: 1,
      stderr: "custom provider profile 'brave' already\n │ exists",
      stdout: "",
    });
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).not.toThrow();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it("rejects a race winner whose profile doesn't match the checked-in boundary (#10371)", () => {
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) => {
      const isExport = args.includes("export");
      exportCalls += isExport ? 1 : 0;
      return !isExport
        ? { status: 1, stderr: "custom provider profile 'brave' already exists", stdout: "" }
        : exportCalls === 1
          ? PROFILE_ABSENT
          : {
              status: 0,
              stderr: "",
              stdout: JSON.stringify(
                boundary(BRAVE_PROVIDER_PROFILE_ID, { inference_capable: true }),
              ),
            };
    });
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("exits with the OpenShell status when import fails for a non-idempotent reason", () => {
    const runOpenshell = makeRunOpenshell([], {
      status: 2,
      stderr: "schema validation error: missing endpoints",
      stdout: "",
    });
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:2/);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it("stops without importing when the probe fails for a reason other than a missing profile (#10371)", () => {
    // An unreachable gateway or an unauthorized account both return a
    // nonzero export status, exactly like a genuinely missing profile does
    // — but proceeding to import in either case would attempt a state-
    // changing operation in response to a read that never actually told us
    // whether the profile exists.
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export")
        ? { status: 1, stderr: "gateway unreachable: connection refused", stdout: "" }
        : IMPORTED,
    );
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(importCallArgs(runOpenshell)).toEqual([]);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("reports a redacted cause without importing when the probe times out (#10371)", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export")
        ? {
            status: null,
            stderr: "",
            stdout: "",
            error: new Error("spawnSync openshell ETIMEDOUT secret-value"),
          }
        : IMPORTED,
    );
    const deps = makeDeps(runOpenshell, {
      redact: (text: string) => text.replaceAll("secret-value", "[REDACTED]"),
    });

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(importCallArgs(runOpenshell)).toEqual([]);
    expect(loggedText(deps)).toContain("ETIMEDOUT");
    expect(loggedText(deps)).toContain("[REDACTED]");
    expect(loggedText(deps)).not.toContain("secret-value");
  });

  it("stops without importing when the post-race re-export fails (#10371)", () => {
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) => {
      const isExport = args.includes("export");
      exportCalls += isExport ? 1 : 0;
      return !isExport
        ? { status: 1, stderr: "custom provider profile 'brave' already exists", stdout: "" }
        : exportCalls === 1
          ? PROFILE_ABSENT
          : { status: 1, stderr: "gateway unreachable: connection refused", stdout: "" };
    });
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("passes the bounded OpenShell operation timeout to the probe and the import (#10371)", () => {
    const runOpenshell = makeRunOpenshell([], IMPORTED);
    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );
    const calls = runOpenshell.mock.calls as unknown as Array<[string[], { timeout?: number }]>;
    const timeouts = calls.map(([, options]) => options.timeout);
    expect(timeouts).toEqual(calls.map(() => OPENSHELL_OPERATION_TIMEOUT_MS));
  });

  it("does not report an unreadable checked-in profile as drift (#10371)", () => {
    // Reading our own YAML can fail for reasons that say nothing about the
    // registered profile. Reporting that as drift sends the operator to
    // delete a profile whose contents were never compared.
    const runOpenshell = makeRunOpenshell([BRAVE_PROVIDER_PROFILE_ID], IMPORTED);
    const deps = makeDeps(runOpenshell, {
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }),
    });

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(loggedText(deps)).not.toContain("delete");
    expect(importCallArgs(runOpenshell)).toEqual([]);
  });

  it("does not report an export that is not JSON as drift (#10371)", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export")
        ? { status: 0, stderr: "", stdout: "profile export interrupted" }
        : IMPORTED,
    );
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(loggedText(deps)).not.toContain("delete");
  });

  it("does not report valid JSON with no provider boundary as drift (#10371)", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export") ? { status: 0, stderr: "", stdout: "{}" } : IMPORTED,
    );
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(loggedText(deps)).not.toContain("delete");
    expect(importCallArgs(runOpenshell)).toEqual([]);
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
