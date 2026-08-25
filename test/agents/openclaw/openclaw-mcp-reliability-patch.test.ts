// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { beforeEach, describe, expect, it } from "vitest";

import {
  auditOpenClawMcpReliability,
  INJECTED_START_RETRY_HELPER,
  MARKER,
  patchBundleMcpRuntimeText,
  patchOpenClawMcpReliability,
} from "../../../scripts/patch-openclaw-mcp-reliability.mts";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "../../..",
  "scripts",
  "patch-openclaw-mcp-reliability.mts",
);

/**
 * Mirrors the reviewed `openclaw@2026.7.1`
 * `dist/agent-bundle-mcp-runtime-*.js` catalog shape, including its tab
 * indentation, so patch anchors are exercised against the real preimage.
 */
function bundleMcpRuntimeFixture(): string {
  return [
    'import { a as logWarn } from "./logger.js";',
    'import { t as runTasksWithConcurrency } from "./run-with-concurrency.js";',
    "function resolveMcpTransport(serverName, rawServer) {",
    "\treturn null;",
    "}",
    "function createSessionMcpRuntime(params) {",
    "\tlet catalog = null;",
    "\tlet activeLeases = 0;",
    "\tconst getCatalog = async () => {",
    "\t\tconst inFlight = (async () => {",
    "\t\t\ttry {",
    "\t\t\t\tconst { results, firstError, hasError } = await runTasksWithConcurrency({",
    "\t\t\t\t\ttasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => async () => {",
    "\t\t\t\t\t\tfailIfDisposed();",
    '\t\t\t\t\t\tlogWarn(`bundle-mcp: starting server "${serverName}".`);',
    "\t\t\t\t\t\ttry {",
    '\t\t\t\t\t\t\tconst client = new Client({ name: "openclaw-bundle-mcp" });',
    "\t\t\t\t\t\t\treturn {",
    "\t\t\t\t\t\t\t\tserverName,",
    "\t\t\t\t\t\t\t\tserverEntry,",
    "\t\t\t\t\t\t\t\ttoolEntries,",
    "\t\t\t\t\t\t\t\tdiagnostics: []",
    "\t\t\t\t\t\t\t};",
    "\t\t\t\t\t\t} catch (error) {",
    "\t\t\t\t\t\t\tconst diags = [{ serverName, message: redactErrorUrls(error) }];",
    "\t\t\t\t\t\t\tif (!session.connected) await retireSessionIfCurrent(serverName, session);",
    "\t\t\t\t\t\t\tfailIfDisposed();",
    "\t\t\t\t\t\t\treturn {",
    "\t\t\t\t\t\t\t\tserverName,",
    "\t\t\t\t\t\t\t\tserverEntry: null,",
    "\t\t\t\t\t\t\t\ttoolEntries: [],",
    "\t\t\t\t\t\t\t\tdiagnostics: diags",
    "\t\t\t\t\t\t\t};",
    "\t\t\t\t\t\t} finally {",
    "\t\t\t\t\t\t\tsession.catalogUseCount -= 1;",
    "\t\t\t\t\t\t\tif (session.catalogUseCount === 0) session.sharedAcrossCatalogGenerations = false;",
    "\t\t\t\t\t\t}",
    "\t\t\t\t\t}),",
    "\t\t\t\t\tlimit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,",
    '\t\t\t\t\terrorMode: "continue"',
    "\t\t\t\t});",
    "\t\t\t\tif (hasError) throw firstError;",
    "\t\t\t} catch (error) {",
    "\t\t\t\tthrow error;",
    "\t\t\t}",
    "\t\t})();",
    "\t\treturn await inFlight;",
    "\t};",
    "\treturn {",
    "\t\tget activeLeases() {",
    "\t\t\treturn activeLeases;",
    "\t\t},",
    "\t\tacquireLease() {",
    "\t\t\tactiveLeases += 1;",
    "\t\t\tlet released = false;",
    "\t\t\treturn () => {",
    "\t\t\t\tif (released) return;",
    "\t\t\t\treleased = true;",
    "\t\t\t\tactiveLeases = Math.max(0, activeLeases - 1);",
    "\t\t\t};",
    "\t\t},",
    "\t\tgetCatalog",
    "\t};",
    "}",
    "",
  ].join("\n");
}

function writeFixtureDist(version = "2026.7.1"): { dist: string; runtime: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-reliability-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  // The reviewed openclaw@2026.7.1 package declares "type": "module"; mirror it
  // so the fixture carries the same module classification as the real package.
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module", version }));
  const runtime = path.join(dist, "agent-bundle-mcp-runtime-Fixture.js");
  fs.writeFileSync(runtime, bundleMcpRuntimeFixture());
  fs.writeFileSync(path.join(dist, "unrelated.js"), "export const unrelated = 1;\n");
  return { dist, runtime, tmp };
}

interface InjectedHelper {
  nemoClawIsTransientMcpStartFailure: (error: unknown) => boolean;
  nemoClawWithMcpStartRetry: (params: Record<string, unknown>) => () => Promise<unknown>;
  nemoClawCatalogHasStartDiagnostics: (catalog: unknown) => boolean;
  nemoClawFinalizeMcpStartResult: (result: unknown, retried: boolean) => unknown;
  NEMOCLAW_MCP_START_FAILURE: symbol;
}

/** Evaluates the injected compatibility runtime exactly as the patch emits it. */
function loadInjectedHelper(warnings: string[]): InjectedHelper {
  const context = vm.createContext({
    logWarn: (message: string) => warnings.push(message),
    setTimeout,
  });
  return vm.runInContext(
    [
      INJECTED_START_RETRY_HELPER,
      "({",
      "nemoClawIsTransientMcpStartFailure,",
      "nemoClawWithMcpStartRetry,",
      "nemoClawCatalogHasStartDiagnostics,",
      "nemoClawFinalizeMcpStartResult,",
      "NEMOCLAW_MCP_START_FAILURE",
      "})",
    ].join("\n"),
    context,
  ) as InjectedHelper;
}

function startFailureResult(helper: InjectedHelper, error: unknown, reusedSession = false) {
  return {
    serverName: "remotedocs",
    serverEntry: null,
    toolEntries: [],
    diagnostics: [{ serverName: "remotedocs", message: String(error) }],
    [helper.NEMOCLAW_MCP_START_FAILURE]: { error, reusedSession },
  };
}

describe("OpenClaw MCP transient startup recovery patch (#7958)", () => {
  const created: string[] = [];

  beforeEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites the reviewed bundle-mcp catalog shape and stays idempotent", () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);

    const first = patchOpenClawMcpReliability(dist);
    expect(first).toMatchObject({ status: "patched", file: runtime, version: "2026.7.1" });

    const patched = fs.readFileSync(runtime, "utf-8");
    expect(patched).toContain(MARKER);
    expect(patched).toContain("nemoClawWithMcpStartRetry({");
    expect(patched).toContain("attempt: async (resolved) => {");
    expect(patched).toContain("resolveTransport: () => resolveMcpTransport(serverName, rawServer)");
    expect(patched).toContain("[NEMOCLAW_MCP_START_FAILURE]: {");
    expect(patched).toContain(
      "if (activeLeases === 0 && nemoClawCatalogHasStartDiagnostics(catalog)) catalog = null;",
    );
    expect(patched).not.toContain(
      "tasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => async () => {",
    );

    const syntax = spawnSync(process.execPath, ["--check", runtime], { encoding: "utf-8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);

    expect(patchOpenClawMcpReliability(dist).status).toBe("already-patched");
    expect(fs.readFileSync(runtime, "utf-8")).toBe(patched);
    expect(auditOpenClawMcpReliability(dist)).toMatchObject({ file: runtime });
  });

  it("fails closed when an audited runtime carries a duplicate patch marker", () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);
    patchOpenClawMcpReliability(dist);
    fs.appendFileSync(runtime, `\n${MARKER}\n`);

    expect(() => auditOpenClawMcpReliability(dist)).toThrow(
      /expected exactly one patched target, found 2/,
    );
  });

  it("fails closed when the reviewed catalog shape is unrecognized", () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);
    fs.writeFileSync(
      runtime,
      fs
        .readFileSync(runtime, "utf-8")
        .replace("\t\t\t\t\t\t\t\tdiagnostics: diags", "\t\t\t\t\t\t\t\tdiagnostics: serverDiags"),
    );

    expect(() => patchOpenClawMcpReliability(dist)).toThrow(
      /expected exactly one MCP startup recovery target, found 0/,
    );
  });

  it("fails closed when a marked runtime still carries an unpatched target", () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);
    fs.writeFileSync(runtime, `${MARKER}\n${fs.readFileSync(runtime, "utf-8")}`);

    expect(() => patchOpenClawMcpReliability(dist)).toThrow(/patch is partial/);
  });

  it("fails closed when no single bundle-mcp runtime can be identified", () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);
    fs.copyFileSync(runtime, path.join(dist, "agent-bundle-mcp-runtime-Duplicate.js"));

    expect(() => patchOpenClawMcpReliability(dist)).toThrow(
      /Expected exactly one OpenClaw bundle-mcp runtime .*found 2/,
    );
  });

  it("rejects an audit of an unpatched reviewed dist", () => {
    const { dist, tmp } = writeFixtureDist();
    created.push(tmp);

    expect(() => auditOpenClawMcpReliability(dist)).toThrow(/patch is not applied/);
  });

  it("reports the reviewed OpenClaw version through the CLI entrypoint", () => {
    const { dist, tmp } = writeFixtureDist();
    created.push(tmp);

    const applied = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PATCH_SCRIPT, dist],
      {
        encoding: "utf-8",
      },
    );
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("MCP startup recovery patched");
    expect(applied.stdout).toContain("openclaw 2026.7.1");

    const audited = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PATCH_SCRIPT, "--audit", dist],
      { encoding: "utf-8" },
    );
    expect(audited.status).toBe(0);
    expect(audited.stdout).toContain("MCP startup recovery audit ok");
  });

  it.each([
    ["unauthorized", new Error("Error POSTing to endpoint (HTTP 401): Unauthorized")],
    ["forbidden", new Error("Streamable HTTP error: HTTP 403 Forbidden")],
    [
      // An OpenShell L4 policy denial reaches the MCP client as a refused
      // connection, so a refused destination must never be retried (#7958).
      "sandbox network policy denial",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9958"), {
          code: "ECONNREFUSED",
        }),
      }),
    ],
    [
      "unresolvable host",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo EAI_AGAIN mcp.example.com"), {
          code: "EAI_AGAIN",
        }),
      }),
    ],
    ["oauth token rejection", new Error('token exchange failed: {"error":"invalid_grant"}')],
    [
      "expired certificate",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("certificate has expired"), {
          code: "CERT_HAS_EXPIRED",
        }),
      }),
    ],
    [
      "self-signed chain",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      }),
    ],
    ["policy denial", new Error("request blocked by sandbox egress policy")],
    ["SSRF guard", new Error("SSRF guard rejected destination")],
    ["invalid configuration", Object.assign(new Error("Invalid URL"), { code: "ERR_INVALID_URL" })],
    ["unknown failure", new Error("something else went wrong")],
    ["missing error", undefined],
  ] as Array<[string, unknown]>)(
    "does not classify %s as a retryable transport startup failure",
    (label, error) => {
      const helper = loadInjectedHelper([]);
      expect(helper.nemoClawIsTransientMcpStartFailure(error), label).toBe(false);
    },
  );

  it.each([
    [
      "upstream reset before headers",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ],
    [
      "socket reset",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    ],
    [
      "MCP request timeout",
      Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 }),
    ],
    ["OpenClaw connect timeout", new Error("MCP server connection timed out after 30000ms")],
    [
      "headers timeout",
      Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    ],
  ] as Array<[string, unknown]>)(
    "classifies %s as a retryable transport startup failure",
    (label, error) => {
    const helper = loadInjectedHelper([]);
      expect(helper.nemoClawIsTransientMcpStartFailure(error), label).toBe(true);
    },
  );

  it("retries a transient streamable-http startup once and returns the recovered result", async () => {
    const warnings: string[] = [];
    const helper = loadInjectedHelper(warnings);
    const seen: Array<Record<string, unknown>> = [];
    const success = {
      serverName: "remotedocs",
      serverEntry: {},
      toolEntries: [{}],
      diagnostics: [],
    };

    // Scripted per-attempt results: the first startup resets in flight, the
    // retry succeeds.
    const scriptedResults = [
      startFailureResult(
        helper,
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        }),
      ),
      success,
    ];

    const task = helper.nemoClawWithMcpStartRetry({
      serverName: "remotedocs",
      initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 30_000 },
      resolveTransport: () => ({ transportType: "streamable-http", connectionTimeoutMs: 30_000 }),
      attempt: async (resolved: Record<string, unknown>) => {
        seen.push(resolved);
        return scriptedResults[seen.length - 1];
      },
    });

    await expect(task()).resolves.toEqual(success);
    expect(seen).toHaveLength(2);
    expect(seen[1].connectionTimeoutMs).toBe(10_000);
    expect(warnings).toEqual([
      'bundle-mcp: retrying transient startup failure for server "remotedocs" once with a fresh transport.',
    ]);
  });

  it("marks an exhausted retry as a temporary transport failure without blaming credentials", async () => {
    const helper = loadInjectedHelper([]);
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });

    const task = helper.nemoClawWithMcpStartRetry({
      serverName: "remotedocs",
      initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
      resolveTransport: () => ({ transportType: "streamable-http", connectionTimeoutMs: 5_000 }),
      attempt: async () => startFailureResult(helper, error),
    });

    const result = (await task()) as { diagnostics: Array<{ message: string }> };
    expect(result.diagnostics[0].message).toContain("temporary MCP transport failure");
    expect(result.diagnostics[0].message).toContain(
      "Credentials and configuration were not rejected",
    );
    expect(Object.getOwnPropertySymbols(result)).toEqual([]);
  });

  it("preserves the first diagnostic when a fresh transport cannot be constructed", async () => {
    const warnings: string[] = [];
    const helper = loadInjectedHelper(warnings);
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    let attempts = 0;

    const task = helper.nemoClawWithMcpStartRetry({
      serverName: "remotedocs",
      initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
      resolveTransport: () => {
        throw new Error("fresh transport construction failed");
      },
      attempt: async () => {
        attempts += 1;
        return startFailureResult(helper, error);
      },
    });

    const result = (await task()) as { diagnostics: Array<{ message: string }> };
    expect(attempts).toBe(1);
    expect(warnings).toEqual([]);
    expect(result.diagnostics[0].message).toBe(String(error));
    expect(result.diagnostics[0].message).not.toContain("temporary MCP transport failure");
    expect(result.diagnostics[0].message).not.toContain("retried");
  });

  it("never retries auth, non-streamable transports, or already-connected refresh failures", async () => {
    const helper = loadInjectedHelper([]);
    const deepBlockedCause = Object.assign(new Error("connection reset"), {
      code: "ECONNRESET",
    }) as Error & { cause?: unknown };
    let deepCursor: { cause?: unknown } = deepBlockedCause;
    for (let depth = 0; depth < 8; depth += 1) {
      const next: { cause?: unknown } = {};
      deepCursor.cause = next;
      deepCursor = next;
    }
    deepCursor.cause = new Error("Error POSTing to endpoint (HTTP 401): Unauthorized");
    const cyclicCause = Object.assign(new Error("connection reset"), {
      code: "ECONNRESET",
    }) as Error & { cause?: unknown };
    cyclicCause.cause = cyclicCause;
    const cases = [
      {
        label: "auth failure",
        initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
        error: new Error("Error POSTing to endpoint (HTTP 401): Unauthorized"),
        reusedSession: false,
      },
      {
        label: "stdio transport",
        initialResolved: { transportType: "stdio", connectionTimeoutMs: 5_000 },
        error: new TypeError("fetch failed"),
        reusedSession: false,
      },
      {
        label: "sse transport",
        initialResolved: { transportType: "sse", connectionTimeoutMs: 5_000 },
        error: new TypeError("fetch failed"),
        reusedSession: false,
      },
      {
        label: "connected refresh failure",
        initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
        error: new TypeError("fetch failed"),
        reusedSession: true,
      },
      {
        label: "blocked cause beyond the bounded classifier depth",
        initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
        error: deepBlockedCause,
        reusedSession: false,
      },
      {
        label: "cyclic cause chain",
        initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
        error: cyclicCause,
        reusedSession: false,
      },
    ];

    for (const testCase of cases) {
      let attempts = 0;
      let resolvedTransports = 0;
      const task = helper.nemoClawWithMcpStartRetry({
        serverName: "remotedocs",
        initialResolved: testCase.initialResolved,
        resolveTransport: () => {
          resolvedTransports += 1;
          return testCase.initialResolved;
        },
        attempt: async () => {
          attempts += 1;
          return startFailureResult(helper, testCase.error, testCase.reusedSession);
        },
      });

      const result = (await task()) as { diagnostics: Array<{ message: string }> };
      expect(attempts, testCase.label).toBe(1);
      expect(resolvedTransports, testCase.label).toBe(0);
      expect(result.diagnostics[0].message, testCase.label).not.toContain(
        "temporary MCP transport failure",
      );
    }
  });

  it("treats any catalog carrying a server diagnostic as unfit for the stable session catalog", () => {
    const helper = loadInjectedHelper([]);
    const exhausted = helper.nemoClawFinalizeMcpStartResult(
      startFailureResult(
        helper,
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        }),
      ),
      true,
    ) as { diagnostics: Array<{ message: string }> };

    // A catalog without server diagnostics omits the key entirely, so a healthy
    // catalog is still reused.
    expect(helper.nemoClawCatalogHasStartDiagnostics(null)).toBe(false);
    expect(helper.nemoClawCatalogHasStartDiagnostics({ servers: {}, tools: [] })).toBe(false);
    expect(helper.nemoClawCatalogHasStartDiagnostics({ tools: [], diagnostics: [] })).toBe(false);
    expect(
      helper.nemoClawCatalogHasStartDiagnostics({
        tools: [],
        diagnostics: exhausted.diagnostics,
      }),
    ).toBe(true);

    // A credential, TLS, policy, or configuration rejection keeps its own
    // diagnostic, but its catalog is still degraded, so it is not retained.
    const rejected = helper.nemoClawFinalizeMcpStartResult(
      startFailureResult(helper, new Error("Error POSTing to endpoint (HTTP 401): Unauthorized")),
      true,
    ) as { diagnostics: Array<{ message: string }> };
    expect(rejected.diagnostics[0].message).not.toContain("temporary MCP transport failure");
    expect(
      helper.nemoClawCatalogHasStartDiagnostics({
        tools: [],
        diagnostics: rejected.diagnostics,
      }),
    ).toBe(true);
  });

  it("keeps the real retry failure when a transient startup is followed by a rejection", async () => {
    const helper = loadInjectedHelper([]);
    const attempts: unknown[] = [];

    const task = helper.nemoClawWithMcpStartRetry({
      serverName: "remotedocs",
      initialResolved: { transportType: "streamable-http", connectionTimeoutMs: 5_000 },
      resolveTransport: () => ({ transportType: "streamable-http", connectionTimeoutMs: 5_000 }),
      attempt: async () => {
        attempts.push(1);
        return attempts.length === 1
          ? startFailureResult(
              helper,
              Object.assign(new TypeError("fetch failed"), {
                cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
              }),
            )
          : startFailureResult(
              helper,
              new Error("Error POSTing to endpoint (HTTP 401): Unauthorized"),
            );
      },
    });

    const result = (await task()) as { diagnostics: Array<{ message: string }> };
    expect(attempts).toHaveLength(2);
    expect(result.diagnostics[0].message).toContain("HTTP 401");
    expect(result.diagnostics[0].message).not.toContain("temporary MCP transport failure");
  });

  it("drops a diagnostics-carrying catalog at the next agent run boundary", async () => {
    const { dist, runtime, tmp } = writeFixtureDist();
    created.push(tmp);
    patchOpenClawMcpReliability(dist);

    const patched = fs.readFileSync(runtime, "utf-8");
    const leaseBody = patched.slice(
      patched.indexOf("\t\tacquireLease() {"),
      patched.indexOf("\t\tgetCatalog"),
    );
    expect(leaseBody).toContain(
      "if (activeLeases === 0 && nemoClawCatalogHasStartDiagnostics(catalog)) catalog = null;",
    );

    // The invalidation must be scoped to an idle runtime so an in-flight agent
    // run keeps its catalog and cannot trigger a per-tool-call reconnect sweep.
    const helper = loadInjectedHelper([]);
    const exhausted = helper.nemoClawFinalizeMcpStartResult(
      startFailureResult(
        helper,
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        }),
      ),
      true,
    ) as { diagnostics: Array<{ message: string }> };
    const degraded = { tools: [], diagnostics: exhausted.diagnostics };
    let catalog: unknown = degraded;
    let activeLeases = 1;
    const acquireLease = () => {
      const dropsCatalog = activeLeases === 0 && helper.nemoClawCatalogHasStartDiagnostics(catalog);
      catalog = dropsCatalog ? null : catalog;
      activeLeases += 1;
    };
    acquireLease();
    expect(catalog).toBe(degraded);
    activeLeases = 0;
    acquireLease();
    expect(catalog).toBeNull();
  });

  it("keeps the compiled helper free of unpatched-target text", () => {
    expect(INJECTED_START_RETRY_HELPER).toContain(MARKER);
    expect(INJECTED_START_RETRY_HELPER).not.toContain("preparedEntries.map");
    expect(patchBundleMcpRuntimeText(bundleMcpRuntimeFixture(), "fixture.js").patched).toBe(true);
  });
});
