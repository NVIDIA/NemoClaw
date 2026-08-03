// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dualStationVllmApiKeyPath,
  ensureDualStationVllmApiKey,
  loadDualStationVllmApiKey,
} from "./vllm-api-key";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-key-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("dual-Station vLLM API key persistence", () => {
  it("creates one private 256-bit key and reuses it", () => {
    const stateDir = path.join(temporaryDirectory(), "state");
    const generated = ensureDualStationVllmApiKey({
      stateDir,
      randomBytes: () => Buffer.alloc(32, 0xab),
    });

    expect(generated).toBe("ab".repeat(32));
    expect(loadDualStationVllmApiKey({ stateDir })).toBe(generated);
    expect(ensureDualStationVllmApiKey({ stateDir, randomBytes: () => Buffer.alloc(32, 1) })).toBe(
      generated,
    );
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dualStationVllmApiKeyPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  it("returns null when no key has been provisioned", () => {
    expect(loadDualStationVllmApiKey({ stateDir: temporaryDirectory() })).toBeNull();
  });

  it("rejects malformed or overly permissive key files", () => {
    const stateDir = temporaryDirectory();
    const filePath = dualStationVllmApiKeyPath(stateDir);
    fs.writeFileSync(filePath, `${"ab".repeat(32)}\n`, { mode: 0o644 });
    expect(() => loadDualStationVllmApiKey({ stateDir })).toThrow("group or others");

    fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(filePath, "not-a-key\n");
    expect(() => loadDualStationVllmApiKey({ stateDir })).toThrow("malformed");
  });

  it("refuses to follow a symbolic-link key path", () => {
    const root = temporaryDirectory();
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const target = path.join(root, "target");
    fs.writeFileSync(target, `${"cd".repeat(32)}\n`, { mode: 0o600 });
    fs.symlinkSync(target, dualStationVllmApiKeyPath(stateDir));

    expect(() => loadDualStationVllmApiKey({ stateDir })).toThrow("symbolic link");
    expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow("symbolic link");
  });

  it("fails closed when secure no-follow opens are unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const constants = { ...actual.constants, O_NOFOLLOW: undefined };
      const actualDefault = (actual as { default?: typeof fs }).default ?? actual;
      return { ...actual, constants, default: { ...actualDefault, constants } };
    });
    const unavailable = await import("./vllm-api-key");

    expect(() =>
      unavailable.ensureDualStationVllmApiKey({
        stateDir: path.join(temporaryDirectory(), "state"),
      }),
    ).toThrow("Secure no-follow file opens are unavailable");
  });
});
