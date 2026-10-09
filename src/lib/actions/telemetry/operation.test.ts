// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ status: 0, pid: undefined })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

import { telemetryRuntime, TEST_TELEMETRY_ENDPOINT } from "../../adapters/telemetry/http";
import {
  beginInstallerTelemetry,
  finishInstallerTelemetry,
  recordTelemetryTarget,
  setTelemetryOutcome,
  TELEMETRY_CONTEXT_ENV,
  withTelemetryOperation,
} from "./operation";

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

it("does not hand malformed receipts to the delivery child (#12859)", async () => {
  const directory = beginInstallerTelemetry("update")!;
  expect(directory).toBeTruthy();
  fs.appendFileSync(`${directory}/receipts.ndjson`, "{not-json}\n");
  vi.stubEnv(TELEMETRY_CONTEXT_ENV, directory);
  await finishInstallerTelemetry(directory, "completed", "applied", "cli", 0);

  expect(spawnSync).not.toHaveBeenCalled();
  expect(fs.existsSync(directory)).toBe(false);
});
