// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for #2666.
 *
 * When the openshell sandbox container is stopped AND the host-side
 * gateway-published port is held by a foreign listener, the live-gateway
 * recovery path inside `nemoclaw list` and the gateway-state probe inside
 * `nemoclaw <name> status` can fail unexpectedly. The bug surfaced as
 * exit 0 + completely empty stdout/stderr — neither the registered sandbox
 * listing nor the sandbox header reached the user.
 *
 * Two layers of fix:
 * 1. Defensive try/catch wraps in status.ts and list-command-deps.ts.
 * 2. The actual silent-fail in cli/oclif-runner.ts: errors carrying
 *    `oclif.exit === 0` were swallowed silently. Now only intentional
 *    ExitError(0) instances stay silent; anything else surfaces.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ListSandboxesCommandDeps,
  getSandboxInventory,
  renderSandboxInventoryText,
} from "../dist/lib/inventory-commands.js";
import { recoverRegistryEntriesWithFallback } from "../dist/lib/list-command-deps.js";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function buildDepsWithThrowingRecovery(): ListSandboxesCommandDeps {
  const registryFallback = {
    sandboxes: [
      {
        name: "my-assist",
        model: "stored-model",
        provider: "stored-provider",
        gpuEnabled: false,
        policies: ["pypi"],
        agent: "openclaw",
      },
    ],
    defaultSandbox: "my-assist",
  };
  // Simulates the deps behavior in list-command-deps.ts: the underlying
  // recover throws (e.g. openshell hangs/errors talking to the foreign
  // port-holder), and the wrapper falls back to the registry shape.
  return {
    recoverRegistryEntries: async () => {
      try {
        throw new Error("simulated openshell timeout / hang");
      } catch {
        return { ...registryFallback, recoveredFromSession: false, recoveredFromGateway: 0 };
      }
    },
    getLiveInference: () => null,
    loadLastSession: () => ({
      sandboxName: "my-assist",
      steps: { sandbox: { status: "complete" } },
    }),
  };
}

describe("#2666 — silent empty output regression", () => {
  it("nemoclaw list renders the registry-only listing when recovery fails", async () => {
    const deps = buildDepsWithThrowingRecovery();
    const inventory = await getSandboxInventory(deps);
    const lines: string[] = [];
    renderSandboxInventoryText(inventory, (line?: string) => lines.push(String(line ?? "")));

    const joined = lines.join("\n");
    expect(joined).toContain("my-assist");
    expect(joined).toContain("Sandboxes:");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("getSandboxInventory does not throw when recovery returns the registry-only fallback", async () => {
    const deps = buildDepsWithThrowingRecovery();
    const inventory = await getSandboxInventory(deps);
    expect(inventory.sandboxes).toHaveLength(1);
    expect(inventory.sandboxes[0].name).toBe("my-assist");
    expect(inventory.recovery.recoveredFromGateway).toBe(0);
    expect(inventory.recovery.recoveredFromSession).toBe(false);
  });
});

describe("#2666 — list-command-deps resilience wrapper", () => {
  // Exercises the actual exported `recoverRegistryEntriesWithFallback` from
  // src/lib/list-command-deps.ts, not a parallel re-implementation. If the
  // production wrapper regresses, these tests fail.

  it("returns the primary result on the happy path", async () => {
    const primary = vi.fn(async () => ({
      sandboxes: [{ name: "happy", model: null, provider: null, gpuEnabled: false, policies: [] }],
      defaultSandbox: "happy",
      recoveredFromSession: true,
      recoveredFromGateway: 2,
    }));
    const fallback = vi.fn(() => ({ sandboxes: [], defaultSandbox: null }));

    const result = await recoverRegistryEntriesWithFallback(primary, fallback);

    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(result.sandboxes).toEqual([
      { name: "happy", model: null, provider: null, gpuEnabled: false, policies: [] },
    ]);
    expect(result.recoveredFromGateway).toBe(2);
    expect(result.recoveredFromSession).toBe(true);
  });

  it("falls back to the registry-only listing when primary throws", async () => {
    const primary = vi.fn(async () => {
      throw new Error("simulated openshell hang");
    });
    const fallback = vi.fn(() => ({
      sandboxes: [
        { name: "my-assist", model: "test-model", provider: "test-provider", gpuEnabled: false, policies: [] },
      ],
      defaultSandbox: "my-assist",
    }));

    const result = await recoverRegistryEntriesWithFallback(primary, fallback);

    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(result.sandboxes).toHaveLength(1);
    expect(result.sandboxes[0].name).toBe("my-assist");
    // Fallback synthesizes recovery flags so downstream rendering treats the
    // result as the registry-only state, not a partial recovery from gateway.
    expect(result.recoveredFromGateway).toBe(0);
    expect(result.recoveredFromSession).toBe(false);
  });
});

describe("#2666 — subprocess regression: simulated (container-stopped + foreign-port-holder)", () => {
  // End-to-end test that runs the real `nemoclaw` binary against a fake
  // `openshell` shell script simulating the bug repro: the openshell sandbox
  // container is stopped AND a foreign listener holds port 8080. In that
  // state, `openshell sandbox get` returns transport-error output and
  // `openshell status` reports a refusing connection on port 8080.
  //
  // Pre-fix this combination silently produced exit 0 + empty stdout/stderr.
  // Post-fix neither command may produce silent empty output: `list` must
  // render the registered sandbox from disk, and `status` must produce a
  // sandbox header plus an actionable error block.

  let home: string;
  let binDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2666-repro-"));
    binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    // Fake openshell that mirrors what users observed in the bug repro:
    // - `openshell status` reports gateway nemoclaw with refusing connection
    // - `openshell sandbox get <name>` exits non-zero with a transport error
    // - `openshell sandbox list` and `inference get` fail to produce useful output
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      [
        "#!/usr/bin/env bash",
        "case \"$*\" in",
        "  status)",
        "    cat <<'EOF'",
        "Status: Disconnected",
        "  Gateway: nemoclaw",
        "  client error (Connect): tcp connect error: Connection refused (os error 61)",
        "EOF",
        "    exit 1",
        "    ;;",
        '  "gateway info -g nemoclaw")',
        "    echo 'Gateway: nemoclaw'",
        "    exit 0",
        "    ;;",
        '  "sandbox get my-assist")',
        "    echo 'transport error: client error (Connect)' >&2",
        "    exit 1",
        "    ;;",
        '  "sandbox list")',
        "    echo ''",
        "    exit 1",
        "    ;;",
        '  "inference get")',
        "    echo ''",
        "    exit 1",
        "    ;;",
        "  *)",
        "    exit 0",
        "    ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          "my-assist": {
            name: "my-assist",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "my-assist",
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "2000",
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("nemoclaw list never produces silent empty output when openshell is broken", () => {
    const { code, stdout, stderr } = runCli(["list"]);
    const combined = `${stdout}\n${stderr}`;
    // The exact failure mode pre-fix was exit 0 + completely empty output.
    // The contract here is the negation of that — the user must see
    // SOMETHING that includes the sandbox they registered on disk.
    expect(combined.trim().length).toBeGreaterThan(0);
    expect(combined).toContain("my-assist");
    // `list` succeeds even when the live gateway is unreachable: the
    // registry-only listing is the documented fallback behavior (#2666).
    expect(code).toBe(0);
  });

  it("nemoclaw <name> status never produces silent empty output when openshell is broken", () => {
    const { code, stdout, stderr } = runCli(["my-assist", "status"]);
    const combined = `${stdout}\n${stderr}`;
    // Must include the sandbox header AND an actionable hint.
    expect(combined.trim().length).toBeGreaterThan(0);
    expect(combined).toContain("my-assist");
    // `status` must exit non-zero when the live gateway can't be verified
    // — that's the contract a watchdog wrapping the command relies on.
    expect(code).not.toBe(0);
  });
});
