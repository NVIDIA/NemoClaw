// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
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

  it.each(["write", "sync"])("keeps the final key absent when the %s fails (#13074)", (failure) => {
    const stateDir = temporaryDirectory();
    const filePath = dualStationVllmApiKeyPath(stateDir);
    const write = fs.writeFileSync;
    const injected = new Error("interrupted key persistence");
    const spy =
      failure === "write"
        ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce((descriptor) => {
            write(descriptor, "partial", "utf8");
            throw injected;
          })
        : vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
            throw injected;
          });
    try {
      expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow(injected);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.readdirSync(stateDir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const generated = ensureDualStationVllmApiKey({ stateDir });
    expect(loadDualStationVllmApiKey({ stateDir })).toBe(generated);
  });

  it("keeps incomplete keys invisible to concurrent readers (#13074)", () => {
    const stateDir = temporaryDirectory();
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((descriptor, value) => {
      expect(loadDualStationVllmApiKey({ stateDir })).toBeNull();
      write(descriptor, value, "utf8");
    });
    try {
      const generated = ensureDualStationVllmApiKey({ stateDir });
      expect(loadDualStationVllmApiKey({ stateDir })).toBe(generated);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the winner's complete key when another creator publishes first (#13074)", () => {
    const stateDir = temporaryDirectory();
    const write = fs.writeFileSync;
    const winner = "cd".repeat(32);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((descriptor, value) => {
      expect(
        ensureDualStationVllmApiKey({ stateDir, randomBytes: () => Buffer.alloc(32, 0xcd) }),
      ).toBe(winner);
      write(descriptor, value, "utf8");
    });
    try {
      expect(
        ensureDualStationVllmApiKey({ stateDir, randomBytes: () => Buffer.alloc(32, 0xab) }),
      ).toBe(winner);
      expect(loadDualStationVllmApiKey({ stateDir })).toBe(winner);
      expect(fs.readdirSync(stateDir)).toEqual([
        path.basename(dualStationVllmApiKeyPath(stateDir)),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("removes its temporary key when publication fails (#13074)", () => {
    const stateDir = temporaryDirectory();
    const spy = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("publication denied"), { code: "EACCES" });
    });
    try {
      expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow("publication denied");
      expect(loadDualStationVllmApiKey({ stateDir })).toBeNull();
      expect(fs.readdirSync(stateDir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves a temporary file owned by another creation attempt (#13074)", () => {
    const stateDir = temporaryDirectory();
    const id = "00000000-0000-4000-8000-000000000000";
    const temporaryPath = path.join(
      stateDir,
      `.${path.basename(dualStationVllmApiKeyPath(stateDir))}.${id}.tmp`,
    );
    fs.writeFileSync(temporaryPath, "other creator", { mode: 0o600 });
    const spy = vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow();
      expect(fs.readFileSync(temporaryPath, "utf8")).toBe("other creator");
      expect(loadDualStationVllmApiKey({ stateDir })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("retains a complete key while reporting directory sync failure (#13074)", () => {
    const stateDir = temporaryDirectory();
    const sync = fs.fsyncSync;
    const spy = vi
      .spyOn(fs, "fsyncSync")
      .mockImplementationOnce(sync)
      .mockImplementationOnce((descriptor) => {
        expect(fs.fstatSync(descriptor).isDirectory()).toBe(true);
        throw new Error("directory sync failed");
      });
    try {
      expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow("directory sync failed");
      const persisted = loadDualStationVllmApiKey({ stateDir });
      expect(persisted).toMatch(/^[a-f0-9]{64}$/);
      expect(ensureDualStationVllmApiKey({ stateDir })).toBe(persisted);
      expect(fs.readdirSync(stateDir)).toEqual([
        path.basename(dualStationVllmApiKeyPath(stateDir)),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a symlink published by a competing creator (#13074)", () => {
    const root = temporaryDirectory();
    const stateDir = path.join(root, "state");
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, `${"cd".repeat(32)}\n`, { mode: 0o600 });
    const link = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementationOnce((source, target) => {
      fs.symlinkSync(outside, target);
      link(source, target);
    });
    try {
      expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow("symbolic link");
      expect(fs.readFileSync(outside, "utf8")).toBe(`${"cd".repeat(32)}\n`);
      expect(fs.lstatSync(dualStationVllmApiKeyPath(stateDir)).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(stateDir)).toEqual([
        path.basename(dualStationVllmApiKeyPath(stateDir)),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects malformed or overly permissive key files", () => {
    const stateDir = temporaryDirectory();
    const filePath = dualStationVllmApiKeyPath(stateDir);
    fs.writeFileSync(filePath, `${"ab".repeat(32)}\n`, { mode: 0o644 });
    expect(() => loadDualStationVllmApiKey({ stateDir })).toThrow("group or others");

    fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(filePath, "not-a-key\n");
    expect(() => loadDualStationVllmApiKey({ stateDir })).toThrow("malformed");
    expect(() => ensureDualStationVllmApiKey({ stateDir })).toThrow("malformed");
    expect(fs.readFileSync(filePath, "utf8")).toBe("not-a-key\n");
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
