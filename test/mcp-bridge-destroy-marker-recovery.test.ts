// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for #6376: `nemoclaw <sandbox> mcp remove <server> --force`
// must clear an incomplete-destroy transaction (`destroyPreparedAt` /
// `destroyPendingAt` markers), otherwise the sandbox is stuck without any
// non-destructive recovery — the only way out was `nemoclaw <sandbox> destroy`.

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

describe("clearMcpDestroyMarkers unit contract (#6376)", () => {
  it("clears both destroyPreparedAt and destroyPendingAt in place", () => {
    const home = createTempHome("nemoclaw-clear-destroy-markers-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: { github: {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: [],
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    } },
    managedServerNames: ["github"],
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    destroyPendingAt: "2026-06-27T01:05:00.000Z",
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
    expect(parsed.mcp?.destroyPendingAt).toBeUndefined();
    // Bridge state and managedServerNames must be preserved — this helper is
    // marker-only surgery.
    expect(parsed.mcp?.bridges).toHaveProperty("github");
    expect(parsed.mcp?.managedServerNames).toEqual(["github"]);
  });

  it("returns false without mutating the registry when no markers are set", () => {
    const home = createTempHome("nemoclaw-clear-destroy-noop-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
registry.registerSandbox({
  name: "healthy-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: { github: {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: [],
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    } },
    managedServerNames: ["github"],
  },
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

  it("clears markers even when only one of the two is set", () => {
    const home = createTempHome("nemoclaw-clear-destroy-single-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
for (const marker of ["destroyPreparedAt", "destroyPendingAt"]) {
  const name = "stuck-only-" + marker;
  registry.registerSandbox({
    name,
    agent: "openclaw",
    mcp: {
      bridges: {},
      [marker]: "2026-06-27T01:00:00.000Z",
    },
  });
  const changed = state.clearMcpDestroyMarkers(name);
  const after = registry.getSandbox(name);
  process.stdout.write(JSON.stringify({ marker, changed, mcp: after && after.mcp }) + "\\n");
}
`;
    const result = runNodeScript(home, script);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        marker: string;
        changed: boolean;
        mcp: SandboxMcpSnapshot | undefined;
      };
      expect(parsed.changed).toBe(true);
      expect(parsed.mcp?.destroyPreparedAt).toBeUndefined();
      expect(parsed.mcp?.destroyPendingAt).toBeUndefined();
    }
  });
});

describe("mcp remove --force clears stuck destroy markers (#6376)", () => {
  it("removeMcpBridge(--force) succeeds when a destroy transaction is incomplete and clears markers", async () => {
    const home = createTempHome("nemoclaw-mcp-force-destroy-recovery-");
    // The child prefixes the JSON payload with a sentinel so we can extract it
    // reliably: `removeMcpBridge` also logs its own diagnostic ("Cleared
    // incomplete MCP destroy transaction …") to stdout, and that must not be
    // parsed as JSON.
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: {
      // Empty bridges — mirroring the case where a destroy interrupted after
      // the bridge entry was purged but before markers were cleared.
    },
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    destroyPendingAt: "2026-06-27T01:05:00.000Z",
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
    // Regression assertion: the fix's own "Cleared incomplete MCP destroy
    // transaction …" diagnostic must appear on stdout so the user sees
    // what --force did.
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
    // Registry mcp state either cleared entirely (bridges empty + no markers)
    // or at least has no markers.
    expect(parsed.mcp?.destroyPreparedAt).toBeUndefined();
    expect(parsed.mcp?.destroyPendingAt).toBeUndefined();
  });

  it("removeMcpBridge WITHOUT --force still refuses when destroy markers are present (safety unchanged)", async () => {
    const home = createTempHome("nemoclaw-mcp-noforce-guard-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "stuck-sandbox",
  agent: "openclaw",
  mcp: {
    bridges: {},
    destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    destroyPendingAt: "2026-06-27T01:05:00.000Z",
  },
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
    // Hint in the error message points at the new recovery path so users can
    // reach it without reading the source.
    expect(result.stdout).toContain("mcp remove <server> --force");
  });
});
