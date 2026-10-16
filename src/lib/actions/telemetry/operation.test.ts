// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ status: 0, pid: undefined })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

import { telemetryRuntime, TEST_TELEMETRY_ENDPOINT } from "../../adapters/telemetry/http";
import { runAgentsApply } from "../sandbox/agents/apply";
import {
  beginInstallerTelemetry,
  finishInstallerTelemetry,
  finishTelemetryOperation,
  recordTelemetryTarget,
  setTelemetryOutcome,
  TELEMETRY_CONTEXT_ENV,
  withTelemetryOperation,
} from "./operation";
import { recordRebuildCompletion } from "./upgrade";

beforeEach(() => {
  spawnSync.mockClear();
  telemetryRuntime.config = null;
  for (const key of ["CI", "GITHUB_ACTIONS", "VITEST", "NODE_ENV", "NEMOCLAW_DISABLE_TELEMETRY"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-telemetry:client:attempt-1");
});

afterEach(() => {
  telemetryRuntime.config = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function deliveryInput(): {
  context: { operation: string; outcome: string; state: string; targets: unknown[] };
  config: { endpoint: string; localReceiver: boolean };
} {
  expect(spawnSync).toHaveBeenCalledOnce();
  const options = spawnSync.mock.calls[0][2] as { input: string };
  return JSON.parse(options.input);
}

it("hands one terminal CLI operation to the delivery child (#12859)", async () => {
  await withTelemetryOperation("sandbox_create", async () => {
    recordTelemetryTarget({ scope: "sandbox", outcome: "completed", state: "applied" });
    setTelemetryOutcome("completed", "applied", "sandbox");
    await withTelemetryOperation("sandbox_rebuild", async () => {
      recordTelemetryTarget({ scope: "sandbox", outcome: "completed", state: "applied" });
    });
  });

  const input = deliveryInput();
  expect(input.context).toMatchObject({
    operation: "sandbox_create",
    outcome: "completed",
    state: "applied",
  });
  expect(input.context.targets).toHaveLength(1);
  expect(input.config).toEqual({ endpoint: TEST_TELEMETRY_ENDPOINT, localReceiver: false });
});

it("waits for the command boundary after an agent apply refusal (#12859)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-agents-"));
  const manifestPath = path.join(home, "invalid-agents.yaml");
  fs.writeFileSync(manifestPath, 'agents:\n  - id: "--help"\n');
  try {
    await expect(
      withTelemetryOperation("agents_apply", () =>
        runAgentsApply(
          { sandboxName: "selected", manifestPath, yes: true },
          {
            ensureLive: async () => undefined,
            getSandboxAgent: () => "openclaw",
            log: () => {},
            exit: (code: number): never => {
              expect(spawnSync).not.toHaveBeenCalled();
              throw new Error(`exit:${code}`);
            },
          },
        ),
      ),
    ).rejects.toThrow("exit:1");
    expect(deliveryInput().context).toMatchObject({
      operation: "agents_apply",
      outcome: "failed",
      state: "unchanged",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("hands an installer failure to the delivery child (#12859)", async () => {
  const directory = beginInstallerTelemetry("install")!;
  expect(directory).toBeTruthy();
  telemetryRuntime.config = null; // The begin process has exited.
  vi.stubEnv(TELEMETRY_CONTEXT_ENV, directory);
  await finishInstallerTelemetry(directory, "failed", "partial", "cli", 1, {
    target: "1.2.3",
  });

  const input = deliveryInput();
  expect(input.context).toMatchObject({
    operation: "install",
    outcome: "failed",
    state: "partial",
  });
  expect(fs.existsSync(directory)).toBe(false);
});

it("leaves a CLI-owned update context for the outer command to finish (#12859)", async () => {
  await withTelemetryOperation("update", async () => {
    const directory = beginInstallerTelemetry("update")!;
    expect(directory).toBe(process.env[TELEMETRY_CONTEXT_ENV]);
    await finishInstallerTelemetry(directory, "completed", "applied", "cli", 0, {
      installed: "1.2.3",
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(true);
    setTelemetryOutcome("failed", "partial", "cli");
  });

  expect(deliveryInput().context).toMatchObject({
    operation: "update",
    outcome: "failed",
    state: "partial",
  });
});

it.each([
  ["completed", "applied", 0],
  ["failed", "partial", 1],
  ["unverified", "pending", 10],
  ["unverified", "pending", 11],
] as const)(
  "records the installer %s/%s result in a CLI-owned update (exit %i) (#12859)",
  async (outcome, state, exitCode) => {
    await withTelemetryOperation("update", async () => {
      const directory = beginInstallerTelemetry("update")!;
      await finishInstallerTelemetry(directory, outcome, state, "cli", exitCode);
      expect(spawnSync).not.toHaveBeenCalled();
      await finishTelemetryOperation(exitCode);
    });
    expect(deliveryInput().context).toMatchObject({ operation: "update", outcome, state });
  },
);

it("uses a published sandbox's non-default gateway for its terminal receipt (#12859)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-gateway-"));
  vi.stubEnv("HOME", home);
  const registry = path.join(home, ".nemoclaw", "gateways", "19000", "sandboxes.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(
    registry,
    JSON.stringify({
      defaultSandbox: null,
      sandboxes: { selected: { name: "selected", gatewayPort: 19000 } },
    }),
  );
  try {
    await withTelemetryOperation("sandbox_rebuild", async () => {
      recordTelemetryTarget({
        scope: "sandbox",
        sandboxName: "selected",
        gatewayName: "nemoclaw",
        outcome: "failed",
        state: "unchanged",
      });
    });
    expect(deliveryInput().context.targets).toMatchObject([
      { sandboxName: "selected", gatewayName: "nemoclaw-19000" },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it.each([
  { mutated: false, state: "unchanged" },
  { mutated: true, state: "partial" },
])(
  "reports failed rebuild state $state when mutation is $mutated (#12859)",
  async ({ mutated, state }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-rebuild-"));
    vi.stubEnv("HOME", home);
    try {
      await withTelemetryOperation("sandbox_rebuild", async () => {
        await recordRebuildCompletion(
          "selected",
          false,
          false,
          { name: "selected", gatewayPort: 19000 } as NonNullable<
            Parameters<typeof recordRebuildCompletion>[3]
          >,
          mutated,
        );
      });
      expect(deliveryInput().context.targets).toMatchObject([
        { outcome: "failed", state, gatewayName: "nemoclaw-19000" },
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

it("removes only old, private operation contexts before beginning a new one (#12859)", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-cleanup-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(temporaryRoot);
  const stale = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-operation-"));
  const claimed = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-operation-"));
  const unsafe = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-operation-"));
  const metadata = JSON.stringify({
    operation: "sandbox_rebuild",
    contextOwner: "cli",
    startedAt: new Date(0).toISOString(),
  });
  fs.chmodSync(stale, 0o700);
  fs.writeFileSync(path.join(stale, "metadata.json"), metadata, { mode: 0o600 });
  fs.writeFileSync(path.join(stale, "receipts.ndjson"), "", { mode: 0o600 });
  fs.chmodSync(claimed, 0o700);
  fs.writeFileSync(path.join(claimed, "metadata.json"), metadata, { mode: 0o600 });
  fs.writeFileSync(path.join(claimed, "receipts.ndjson"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(claimed, "claimed"), "", { mode: 0o600 });
  fs.chmodSync(unsafe, 0o700);
  fs.writeFileSync(path.join(unsafe, "metadata.json"), metadata, { mode: 0o600 });
  fs.writeFileSync(path.join(unsafe, "receipts.ndjson"), "", { mode: 0o600 });
  fs.chmodSync(unsafe, 0o755);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(claimed, old, old);
  fs.utimesSync(unsafe, old, old);
  try {
    await withTelemetryOperation("sandbox_rebuild", async () => undefined);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(claimed)).toBe(false);
    expect(fs.existsSync(unsafe)).toBe(true);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

it("does not hand malformed receipts to the delivery child (#12859)", async () => {
  const directory = beginInstallerTelemetry("update")!;
  expect(directory).toBeTruthy();
  fs.appendFileSync(`${directory}/receipts.ndjson`, "{not-json}\n");
  vi.stubEnv(TELEMETRY_CONTEXT_ENV, directory);
  await finishInstallerTelemetry(directory, "completed", "applied", "cli", 0);

  expect(spawnSync).not.toHaveBeenCalled();
  expect(fs.existsSync(directory)).toBe(false);
});
