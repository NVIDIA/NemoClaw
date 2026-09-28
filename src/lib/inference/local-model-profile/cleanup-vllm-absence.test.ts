// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_VLLM_API_KEY_FILE } from "../serving/managed-runtime-receipts";
import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  persistHostLocalVllmRuntimeReceipt,
} from "../serving/vllm-host-local-lifecycle";
import { managedVllmStateDir } from "../vllm-api-key";
import {
  HOST_LOCAL_VLLM_PENDING_RETIREMENT_FILE,
  readPendingHostLocalVllmRetirement,
  recordPendingHostLocalVllmRetirement,
  cleanupLocalModelRuntimes,
  retireHostLocalVllmRuntime,
  type LocalModelRuntimeCleanupOptions,
} from "./cleanup";

type Capture = NonNullable<NonNullable<LocalModelRuntimeCleanupOptions["deps"]>["capture"]>;
const homes: string[] = [];
const inventoryArgs = [
  "container",
  "ls",
  "--all",
  "--no-trunc",
  "--filter",
  `name=^/${HOST_LOCAL_VLLM_CONTAINER_NAME}$`,
  "--format",
  "{{.ID}}",
];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function temporaryHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-absence-")));
  homes.push(home);
  return home;
}

function privateState() {
  const homeDir = temporaryHome();
  const stateDir = managedVllmStateDir(homeDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const apiKey = "a".repeat(64);
  const keyPath = path.join(stateDir, MANAGED_VLLM_API_KEY_FILE);
  fs.writeFileSync(keyPath, `${apiKey}\n`, { mode: 0o600 });
  persistHostLocalVllmRuntimeReceipt(
    {
      containerId: "f".repeat(64),
      authFingerprint: runtimeAuthFingerprint(apiKey),
      serving: {
        catalogDigest: `sha256:${"1".repeat(64)}`,
        presetId: "vllm.dgx-spark-gb10.single.example",
        presetDigest: `sha256:${"2".repeat(64)}`,
        recipeId: "vllm.dgx-spark-gb10.single.example",
        recipeDigest: `sha256:${"3".repeat(64)}`,
      },
    },
    stateDir,
  );
  const receiptPath = path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE);
  return {
    homeDir,
    keyPath,
    receiptPath,
    keyContent: fs.readFileSync(keyPath, "utf8"),
    receiptContent: fs.readFileSync(receiptPath, "utf8"),
  };
}

const inventoryCases = [
  {
    name: "unavailable",
    capture: () =>
      vi
        .fn<Capture>()
        .mockReturnValueOnce("")
        .mockImplementationOnce(() => {
          throw new Error("Docker container inventory failed");
        }),
  },
  {
    name: "present",
    capture: () => vi.fn<Capture>().mockReturnValueOnce("").mockReturnValueOnce("f".repeat(64)),
  },
] as const;

const operations = [
  {
    name: "destroy",
    cleanup: retireHostLocalVllmRuntime,
    refusal: { status: "preserved" },
    absent: { status: "absent" },
  },
  {
    name: "uninstall",
    cleanup: cleanupLocalModelRuntimes,
    refusal: { ok: false },
    absent: { ok: true },
  },
] as const;

describe.each(operations)("$name managed vLLM absence", ({ cleanup, refusal, absent }) => {
  it.each(inventoryCases)(
    "preserves private state when container inventory is $name",
    ({ capture: createCapture }) => {
      const state = privateState();
      const capture = createCapture();
      const forceRm = vi.fn(() => ({ status: 0 }) as never);
      const result = cleanup({
        homeDir: state.homeDir,
        deps: {
          capture,
          forceRm,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      });
      expect(result).toMatchObject({ ...refusal, removed: [] });
      expect(forceRm).not.toHaveBeenCalled();
      expect(fs.readFileSync(state.keyPath, "utf8")).toBe(state.keyContent);
      expect(fs.readFileSync(state.receiptPath, "utf8")).toBe(state.receiptContent);
      expect(capture).toHaveBeenLastCalledWith(inventoryArgs, {
        ignoreError: false,
        timeout: 10_000,
      });
    },
  );

  it("removes private state only after an empty successful container inventory", () => {
    const state = privateState();
    const capture = vi.fn<Capture>().mockReturnValueOnce("").mockReturnValueOnce("");
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const result = cleanup({
      homeDir: state.homeDir,
      deps: {
        capture,
        forceRm,
        run: vi.fn(() => ({ status: 0 }) as never),
      },
    });
    expect(result).toMatchObject(absent);
    expect(capture).toHaveBeenLastCalledWith(inventoryArgs, {
      ignoreError: false,
      timeout: 10_000,
    });
    expect(forceRm).not.toHaveBeenCalled();
    expect(fs.existsSync(state.keyPath)).toBe(false);
    expect(fs.existsSync(state.receiptPath)).toBe(false);
  });
});

it.each(inventoryCases)(
  "preserves bearerless retirement when container inventory is $name",
  ({ capture: createCapture }) => {
    const capture = createCapture();
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const result = retireHostLocalVllmRuntime({
      homeDir: temporaryHome(),
      deps: {
        capture,
        forceRm,
        run: vi.fn(() => ({ status: 0 }) as never),
      },
    });
    expect(result).toMatchObject({ status: "preserved", removed: [] });
    expect(forceRm).not.toHaveBeenCalled();
    expect(capture).toHaveBeenLastCalledWith(inventoryArgs, {
      ignoreError: false,
      timeout: 10_000,
    });
  },
);

it("records pending vLLM retirement without overwriting a linked host file", () => {
  const home = temporaryHome();
  const stateDir = managedVllmStateDir(home);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const unrelatedFile = path.join(home, "unrelated.json");
  fs.writeFileSync(unrelatedFile, "untouched", { mode: 0o600 });
  fs.symlinkSync(unrelatedFile, path.join(stateDir, HOST_LOCAL_VLLM_PENDING_RETIREMENT_FILE));

  recordPendingHostLocalVllmRetirement("alpha", home);

  expect({
    unrelated: fs.readFileSync(unrelatedFile, "utf8"),
    pending: readPendingHostLocalVllmRetirement(home),
  }).toEqual({ unrelated: "untouched", pending: "alpha" });
});
