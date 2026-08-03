// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { nemoclawStateRoot } from "../state/state-root";
import { createProductionDualSparkDiscoveryDeps } from "./serving/dual-spark-discovery-production";
import {
  assertNoManagedDistributedVllmRuntimeReceipts,
  findManagedDistributedVllmRuntimeReceipts,
} from "./serving/managed-runtime-receipts";
import { dualSparkVllmRuntimeReceiptPath } from "./serving/spark-runtime-receipt";
import { dualStationVllmRuntimeReceiptPath } from "./vllm-station-runtime-receipt";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-receipts-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "stale\n", { mode: 0o600 });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const homeDir of temporaryHomes.splice(0)) fs.rmSync(homeDir, { recursive: true });
});

describe("managed distributed vLLM receipt preflight", () => {
  it("allows installation when no durable distributed receipt exists", () => {
    expect(() =>
      assertNoManagedDistributedVllmRuntimeReceipts({ homeDir: temporaryHome() }),
    ).not.toThrow();
  });

  it("blocks a host-global Spark receipt without parsing stale contents", () => {
    const homeDir = temporaryHome();
    const receiptPath = dualSparkVllmRuntimeReceiptPath(
      nemoclawStateRoot(homeDir, DEFAULT_GATEWAY_PORT),
    );
    touch(receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir })).toEqual({
      sparkBindingPath: null,
      sparkDiscoveryBindingPaths: [],
      sparkPath: receiptPath,
      stationBindingPaths: [],
      stationPaths: [],
    });
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(
      "recover it through Local vLLM",
    );
  });

  it("blocks Station receipts across safely enumerated gateway roots", () => {
    const homeDir = temporaryHome();
    const receiptPath = dualStationVllmRuntimeReceiptPath(nemoclawStateRoot(homeDir, 18080));
    touch(receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir }).stationPaths).toEqual([
      receiptPath,
    ]);
  });

  it.each([
    { topology: "Spark", gatewayPort: DEFAULT_GATEWAY_PORT },
    { topology: "Station", gatewayPort: 18080 },
  ])("blocks an orphaned $topology SSH binding tree", ({ topology, gatewayPort }) => {
    const homeDir = temporaryHome();
    const stateRoot = nemoclawStateRoot(homeDir, gatewayPort);
    const receiptPath =
      topology === "Spark"
        ? dualSparkVllmRuntimeReceiptPath(stateRoot)
        : dualStationVllmRuntimeReceiptPath(stateRoot);
    const bindingPath = `${receiptPath}.ssh-binding`;
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });

    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(bindingPath);
  });

  it("blocks an orphaned Spark discovery binding claim", () => {
    const homeDir = temporaryHome();
    const bindingPath = path.join(
      nemoclawStateRoot(homeDir),
      "dual-spark-managed-serving.json.ssh-binding",
    );
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });

    expect(
      findManagedDistributedVllmRuntimeReceipts({ homeDir }).sparkDiscoveryBindingPaths,
    ).toEqual([bindingPath]);
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(bindingPath);
  });

  it("places the production Spark discovery claim in the scanner-visible gateway root", () => {
    const homeDir = temporaryHome();
    vi.stubEnv("HOME", homeDir);
    const deps = createProductionDualSparkDiscoveryDeps(() => {
      throw new Error("unexpected host probe");
    });

    expect(deps.resolveBindingStatePath()).toBe(
      path.join(nemoclawStateRoot(homeDir), "dual-spark-managed-serving.json"),
    );
  });

  it("treats a receipt symlink as existing without following it", () => {
    const homeDir = temporaryHome();
    const receiptPath = dualSparkVllmRuntimeReceiptPath(nemoclawStateRoot(homeDir));
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.symlinkSync(path.join(homeDir, "missing-target"), receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir }).sparkPath).toBe(receiptPath);
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(
      "Managed vLLM runtime state already exists",
    );
  });
});
