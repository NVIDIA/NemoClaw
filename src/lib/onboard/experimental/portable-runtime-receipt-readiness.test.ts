// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyPortableLifecycleReceipt,
  portableDemoReceiptPath,
} from "./portable-runtime-receipt-readiness";

function receipt(stateDir: string, overrides: Record<string, unknown> = {}) {
  const uid = process.getuid?.() ?? 1001;
  const homeDir = path.join(stateDir, "home");
  return {
    schemaVersion: 4,
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    containerId: "a".repeat(64),
    dashboardPort: 18789,
    registryGeneration: "generation-1",
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir,
      configHome: path.join(homeDir, ".config"),
      runtimeDir: `/run/user/${uid}`,
      socketPath: `/run/user/${uid}/podman/podman.sock`,
    },
    ...overrides,
  };
}

describe("Portable lifecycle receipt classification", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function stateDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-receipt-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  function writeReceipt(directory: string, value: unknown): void {
    const target = portableDemoReceiptPath("alpha", directory);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  function classificationDeps(directory: string): {
    stateDir: string;
    platform: NodeJS.Platform;
    runtimeReadiness: { uid: number; home: string };
  } {
    return {
      stateDir: directory,
      platform: "linux" as const,
      runtimeReadiness: {
        uid: process.getuid?.() ?? 1001,
        home: path.join(directory, "home"),
      },
    };
  }

  it("classifies absence without inferring Portable behavior (#9207)", () => {
    const directory = stateDir();
    expect(classifyPortableLifecycleReceipt("alpha", classificationDeps(directory))).toEqual({
      kind: "absent",
    });
  });

  it("accepts only a current schema-4 receipt with runtime authority (#9207)", () => {
    const directory = stateDir();
    writeReceipt(directory, receipt(directory));

    expect(classifyPortableLifecycleReceipt("alpha", classificationDeps(directory))).toMatchObject({
      kind: "current",
      registryGeneration: "generation-1",
      runtimeAuthority: { kind: "podman", ownership: "current-user" },
    });
  });

  it("fails closed when receipt metadata changes during its pinned read (#9207)", () => {
    const directory = stateDir();
    const target = portableDemoReceiptPath("alpha", directory);
    writeReceipt(directory, receipt(directory));
    const originalReadSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
      fs.chmodSync(target, 0o640);
      return Reflect.apply(originalReadSync, fs, args);
    }) as typeof fs.readSync);

    expect(classifyPortableLifecycleReceipt("alpha", classificationDeps(directory))).toEqual({
      kind: "invalid-or-legacy",
    });
  });

  function expectCompatibilityFailure(
    mutate: (deps: ReturnType<typeof classificationDeps>) => void,
  ): void {
    const directory = stateDir();
    writeReceipt(directory, receipt(directory));
    const deps = classificationDeps(directory);
    mutate(deps);

    expect(classifyPortableLifecycleReceipt("alpha", deps)).toEqual({
      kind: "invalid-or-legacy",
    });
  }

  it("rejects an otherwise current receipt for another user ID (#9207)", () => {
    expectCompatibilityFailure((deps) => {
      deps.runtimeReadiness.uid = 9999;
    });
  });

  it("rejects an otherwise current receipt for another user home (#9207)", () => {
    expectCompatibilityFailure((deps) => {
      deps.runtimeReadiness.home = "/home/other";
    });
  });

  it("rejects an otherwise current receipt on a non-Linux host (#9207)", () => {
    expectCompatibilityFailure((deps) => {
      deps.platform = "darwin";
    });
  });

  it.each([
    ["legacy", { schemaVersion: 3, runtimeAuthority: undefined }],
    ["missing authority", { runtimeAuthority: undefined }],
    ["extra field", { unexpected: true }],
    ["wrong sandbox", { sandboxName: "beta" }],
  ])("fails closed for %s receipt state (#9207)", (_label, overrides) => {
    const directory = stateDir();
    const value = Object.fromEntries(
      Object.entries(receipt(directory, overrides)).filter(([, entry]) => entry !== undefined),
    );
    writeReceipt(directory, value);

    expect(classifyPortableLifecycleReceipt("alpha", classificationDeps(directory))).toEqual({
      kind: "invalid-or-legacy",
    });
  });
});
