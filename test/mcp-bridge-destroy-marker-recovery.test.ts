// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for #6376: `nemoclaw <sandbox> mcp remove <server> --force`
// must recover an incomplete-destroy transaction non-destructively — but only
// the PREPARED (phase-one) marker, where the sandbox still exists. The PENDING
// (phase-two) marker means OpenShell already deleted the sandbox, so it must NOT
// be cleared here (that would abandon the still-owed provider/policy cleanup).
// The prepared marker is cleared only AFTER the removal succeeds, so a failed
// recovery preserves the durable retry state.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
  .filter(Boolean)
  .join(" ");
const tempHomes = new Set<string>();

function createTempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempHomes.add(home);
  return home;
}

afterEach(() => {
  tempHomes.forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  tempHomes.clear();
});

interface SandboxMcpSnapshot {
  bridges: Record<string, unknown>;
  managedServerNames?: readonly string[];
  destroyPreparedAt?: string;
  destroyPendingAt?: string;
}

function runNodeScript(
  home: string,
  script: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

const GITHUB_BRIDGE = `{
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: [],
  policyName: "mcp-bridge-github",
  addedAt: "2026-06-01T00:00:00.000Z",
}`;

describe("clearMcpDestroyMarkers — phase-aware (#6376)", () => {
  it("clears the prepared (phase-one) marker in place, preserving bridges + managedServerNames", () => {
    const home = createTempHome("nemoclaw-clear-prepared-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: { github: ${GITHUB_BRIDGE} },
    managedServerNames: ["github"],
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
  },
});
const changed = state.clearMcpDestroyMarkers("stuck-sandbox");
const after = registry.getSandbox("stuck-sandbox");
process.stdout.write(JSON.stringify({ changed, mcp: after && after.mcp }));
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      changed: boolean;
      mcp: SandboxMcpSnapshot | undefined;
    };
    expect(parsed.changed).toBe(true);
    expect(parsed.mcp?.destroyPreparedAt).toBeUndefined();
    // Marker-only surgery: bridges and managedServerNames are preserved.
    expect(parsed.mcp?.bridges).toHaveProperty("github");
    expect(parsed.mcp?.managedServerNames).toEqual(["github"]);
  });

  it("returns false without mutating the registry when no markers are set", () => {
    const home = createTempHome("nemoclaw-clear-noop-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
registry.registerSandbox({
  name: "healthy-sandbox",
  agent: "openclaw",
  mcp: { bridges: { github: ${GITHUB_BRIDGE} }, managedServerNames: ["github"] },
});
const before = JSON.stringify(registry.getSandbox("healthy-sandbox"));
const changed = state.clearMcpDestroyMarkers("healthy-sandbox");
const after = JSON.stringify(registry.getSandbox("healthy-sandbox"));
process.stdout.write(JSON.stringify({ changed, mutated: before !== after }));
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { changed: boolean; mutated: boolean };
    expect(parsed.changed).toBe(false);
    expect(parsed.mutated).toBe(false);
  });

  it("REFUSES to clear a pending (phase-two) marker and preserves it — the sandbox was already deleted", () => {
    const home = createTempHome("nemoclaw-clear-pending-refuse-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
registry.registerSandbox({
  name: "deleted-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: {},
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    destroyPendingAt: "2026-06-27T01:05:00.000Z",
  },
});
let threw = "";
try {
  state.clearMcpDestroyMarkers("deleted-sandbox");
} catch (error) {
  threw = String(error && error.message || error);
}
const after = registry.getSandbox("deleted-sandbox");
process.stdout.write(JSON.stringify({ threw, mcp: after && after.mcp }));
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      threw: string;
      mcp: SandboxMcpSnapshot | undefined;
    };
    expect(parsed.threw).toContain("past the point of no return");
    // The durable pending retry marker survives the refusal.
    expect(parsed.mcp?.destroyPendingAt).toBe("2026-06-27T01:05:00.000Z");
  });
});

describe("mcp remove --force — phase-aware recovery (#6376)", () => {
  it("recovers a prepared-only stuck destroy and clears the marker after the removal succeeds", async () => {
    const home = createTempHome("nemoclaw-force-prepared-recover-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    // Empty bridges — a destroy interrupted after the bridge entry was purged
    // but before the marker was cleared. The sandbox still exists (phase one).
    bridges: {},
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
  },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("stuck-sandbox", "github", { force: true }).then(
  () => {
    const after = registry.getSandbox("stuck-sandbox");
    process.stdout.write("\\n<<REPRO_JSON>>" + JSON.stringify({ ok: true, mcp: after && after.mcp }));
    process.exit(0);
  },
  (error) => {
    process.stderr.write(String(error && error.message || error));
    process.exit(1);
  },
);
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Cleared incomplete MCP destroy transaction on sandbox 'stuck-sandbox'",
    );
    const jsonMarker = "<<REPRO_JSON>>";
    const jsonPayload = result.stdout.slice(result.stdout.indexOf(jsonMarker) + jsonMarker.length);
    const parsed = JSON.parse(jsonPayload) as {
      ok: boolean;
      mcp: SandboxMcpSnapshot | undefined;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mcp?.destroyPreparedAt).toBeUndefined();
    expect(parsed.mcp?.destroyPendingAt).toBeUndefined();
  });

  it("REFUSES --force on a pending destroy (sandbox already deleted) and preserves the marker", async () => {
    const home = createTempHome("nemoclaw-force-pending-refuse-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "deleted-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: {},
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    destroyPendingAt: "2026-06-27T01:05:00.000Z",
  },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("deleted-sandbox", "github", { force: true }).then(
  () => {
    process.stdout.write("UNEXPECTED_OK");
    process.exit(0);
  },
  (error) => {
    const after = registry.getSandbox("deleted-sandbox");
    process.stdout.write(JSON.stringify({ error: String(error && error.message || error), mcp: after && after.mcp }));
    process.exit(0);
  },
);
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: string;
      mcp: SandboxMcpSnapshot | undefined;
    };
    expect(parsed.error).toContain("past the point of no return");
    expect(parsed.error).toContain("destroy");
    // The pending marker is NOT cleared — the destroy must be finished, not erased.
    expect(parsed.mcp?.destroyPendingAt).toBe("2026-06-27T01:05:00.000Z");
    // And the fix's "Cleared incomplete MCP destroy transaction" log must NOT appear.
    expect(result.stdout).not.toContain("Cleared incomplete MCP destroy transaction");
  });

  it("PRESERVES the prepared marker when the --force removal itself fails (durable retry state)", async () => {
    const home = createTempHome("nemoclaw-force-fail-preserve-");
    // Deterministically fail the removal at the gateway-selection step (before
    // any provider/openshell work) by stubbing ensureSandboxGatewaySelected to
    // throw. Because the prepared marker is cleared only AFTER a successful
    // removal, it must survive this failure — the #6376 blocker was that the
    // earlier code cleared markers up front and lost the retry state.
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
// CJS interop: mcp-bridge-remove calls this via the module object, so the
// override is observed at call time.
state.ensureSandboxGatewaySelected = async () => {
  throw new Error("gateway unavailable (injected)");
};
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: {
      github: {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: [],
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      },
    },
    managedServerNames: ["github"],
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
  },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("stuck-sandbox", "github", { force: true }).then(
  () => {
    const after = registry.getSandbox("stuck-sandbox");
    process.stdout.write("<<REPRO_JSON>>" + JSON.stringify({ threw: false, mcp: after && after.mcp }));
    process.exit(0);
  },
  (error) => {
    const after = registry.getSandbox("stuck-sandbox");
    process.stdout.write("<<REPRO_JSON>>" + JSON.stringify({ threw: true, error: String(error && error.message || error), mcp: after && after.mcp }));
    process.exit(0);
  },
);
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const jsonMarker = "<<REPRO_JSON>>";
    const jsonPayload = result.stdout.slice(result.stdout.indexOf(jsonMarker) + jsonMarker.length);
    const parsed = JSON.parse(jsonPayload) as {
      threw: boolean;
      error?: string;
      mcp: SandboxMcpSnapshot | undefined;
    };
    // The removal failed ...
    expect(parsed.threw).toBe(true);
    expect(parsed.error).toContain("gateway unavailable (injected)");
    // ... so the durable prepared retry marker MUST be preserved for a later
    // `sandbox destroy` or retry.
    expect(parsed.mcp?.destroyPreparedAt).toBe("2026-06-27T01:00:00.000Z");
    // The success log must NOT have printed.
    expect(result.stdout).not.toContain("Cleared incomplete MCP destroy transaction");
  });

  it("rebuild refuses a stuck destroy in the PREFLIGHT phase, before any destructive/backup work (#6376)", async () => {
    const home = createTempHome("nemoclaw-rebuild-preflight-marker-");
    // runRebuildPreflightPhase runs before the pipeline's backup and delete
    // phases. A stuck marker must throw here (throwOnError mode) so the pipeline
    // never reaches backup/delete — recovery is no longer "too late".
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: { bridges: {}, destroyPreparedAt: "2026-06-27T01:00:00.000Z" },
});
const preflight = require("./src/lib/actions/sandbox/rebuild-preflight-phase.js");
preflight.runRebuildPreflightPhase("stuck-sandbox", [], { throwOnError: true }).then(
  () => {
    process.stdout.write("UNEXPECTED_OK");
    process.exit(0);
  },
  (error) => {
    process.stdout.write(String(error && error.message || error));
    process.exit(0);
  },
);
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("UNEXPECTED_OK");
    expect(result.stdout).toContain("incomplete MCP destroy transaction");
    // Destructive markers from a real backup/delete must not appear — the guard
    // fired first.
    expect(result.stdout).not.toContain("Deleting old sandbox");
  });

  it("WITHOUT --force still refuses (prepared phase points at the --force recovery)", async () => {
    const home = createTempHome("nemoclaw-noforce-guard-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: { bridges: {}, destroyPreparedAt: "2026-06-27T01:00:00.000Z" },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("stuck-sandbox", "github", {}).then(
  () => {
    process.stdout.write("UNEXPECTED_OK");
    process.exit(0);
  },
  (error) => {
    process.stdout.write(String(error && error.message || error));
    process.exit(0);
  },
);
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("incomplete MCP destroy transaction");
    expect(result.stdout).toContain("mcp remove <server> --force");
  });
});
