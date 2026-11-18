// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hermesPolicyCleanupFilesystem,
  policyFileStat as stat,
} from "../../support/hermes-policy-cleanup-filesystem";
const processMock = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => processMock);
import hermesFs, {
  unlinkHermesGeneratedFile,
} from "../../../agents/hermes/managed-startup-filesystem.ts";

const source = "/sandbox/.hermes/managed-policy.json";
const denied = (code = "EACCES") => Object.assign(new Error("denied"), { code });
let fixture: ReturnType<typeof hermesPolicyCleanupFilesystem>;
let state: ReturnType<typeof hermesPolicyCleanupFilesystem>["state"];
beforeEach(() => {
  fixture = hermesPolicyCleanupFilesystem();
  state = fixture.state;
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw denied();
  });
  vi.spyOn(fs, "lstatSync").mockImplementation(fixture.lstat as typeof fs.lstatSync);
  processMock.spawnSync.mockImplementation(fixture.spawn);
});
afterEach(() => {
  vi.restoreAllMocks();
  processMock.spawnSync.mockReset();
});

describe("Hermes generated-source cleanup", () => {
  it("keeps native fs unchanged and uses ordinary unlink when allowed", () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);
    hermesFs.unlinkSync(source);
    expect(fs.unlinkSync).not.toBe(unlinkHermesGeneratedFile);
    expect(processMock.spawnSync).not.toHaveBeenCalled();
  });
  it.each(["EACCES", "EPERM"])("removes a denied source as its owner for %s", (code) => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw denied(code);
    });
    unlinkHermesGeneratedFile(source);
    const call = processMock.spawnSync.mock.calls[2];
    expect(call[0]).toBe(process.execPath);
    expect(call[1].slice(-3)[0]).toBe(source);
    expect(call[2]).toEqual({
      uid: 1000,
      gid: 1000,
      env: { PATH: "/usr/bin:/bin", HOME: "/sandbox" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(state.removed).toBe(true);
  });
  it.each([
    "hermes-relay-plugins.toml",
    "hermes-relay-plugin-state.json",
    "hermes-switchyard-v1.toml",
  ])("also removes the generated routing source %s", (name) => {
    unlinkHermesGeneratedFile(`/sandbox/.hermes/${name}`);
    expect(state.removed).toBe(true);
  });
  it.each(["ENOENT", "EIO", "EROFS"])("preserves %s without changing identity", (code) => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw denied(code);
    });
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("denied");
    expect(processMock.spawnSync).not.toHaveBeenCalled();
  });
  it.each([
    "/sandbox/.hermes/config.yaml",
    "/usr/local/share/nemoclaw/hermes-managed-policy.json",
    "/tmp/managed-policy.json",
  ])("does not apply the owner fallback to %s", (target) => {
    expect(() => unlinkHermesGeneratedFile(target)).toThrow("denied");
    expect(processMock.spawnSync).not.toHaveBeenCalled();
  });
  it.each([
    { uid: 0n },
    { gid: 0n },
    { nlink: 2n },
    { mode: 0o100644n },
    { isSymbolicLink: () => true },
    { isFile: () => false },
  ])("rejects unsafe source metadata %o", (overrides) => {
    state.file = stat(overrides);
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("unsafe ownership or metadata");
    expect(processMock.spawnSync).toHaveBeenCalledTimes(2);
  });
  it.each([
    { uid: 0n },
    { gid: 0n },
    { mode: 0o42770n },
    { mode: 0o43772n },
    { mode: 0o40777n },
    { isSymbolicLink: () => true },
    { isDirectory: () => false },
  ])("rejects an unsafe private parent %o", (overrides) => {
    state.parent = stat({ ...state.parent, ...overrides });
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("unsafe ownership or metadata");
  });
  it("preserves the declared sandbox-owned 3770 state root during owner cleanup", () => {
    state.parent = stat({ ...state.parent, mode: 0o43770n });
    unlinkHermesGeneratedFile(source);
    expect(state.removed).toBe(true);
    expect(state.parent.mode).toBe(0o43770n);
  });
  it("rejects an untrusted identity executable before starting children", () => {
    vi.mocked(fs.lstatSync).mockReturnValueOnce({
      uid: 1000,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats);
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("trusted executable");
    expect(processMock.spawnSync).not.toHaveBeenCalled();
  });
  it.each(["0", "1000x", "", "9007199254740992"])(
    "rejects invalid sandbox identity %s",
    (value) => {
      processMock.spawnSync.mockReturnValueOnce({ status: 0, stdout: value });
      expect(() => unlinkHermesGeneratedFile(source)).toThrow("resolve the sandbox identity");
    },
  );
  it("rejects a failed identity lookup", () => {
    processMock.spawnSync.mockReturnValueOnce({ status: 1, stdout: "1000" });
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("resolve the sandbox identity");
  });
  it("propagates cleanup child failure", () => {
    state.childStatus = 1;
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("cleanup failed");
  });
  it("propagates cleanup child timeout", () => {
    state.childError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("cleanup failed");
  });
  it("requires absence even after a successful child exit", () => {
    processMock.spawnSync.mockImplementation((command: string) => ({
      status: 0,
      stdout: command === "/usr/bin/id" ? "1000" : "",
    }));
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("remains after cleanup");
  });
  it("does not let a no-op child satisfy the filesystem double", () => {
    processMock.spawnSync
      .mockImplementationOnce(fixture.spawn)
      .mockImplementationOnce(fixture.spawn)
      .mockImplementationOnce((command: string, args: string[]) =>
        fixture.spawn(command, [...args.slice(0, 2), "", ...args.slice(3)]),
      );
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("remains after cleanup");
    expect(state.removed).toBe(false);
  });
  it("does not interpret an inspection denial as absence", () => {
    state.verifyError = denied();
    expect(() => unlinkHermesGeneratedFile(source)).toThrow("removal could not be verified");
  });
  it("deletes the unchanged source after changing identity", () => {
    unlinkHermesGeneratedFile(source);
    const child = fixture.child(processMock.spawnSync.mock.calls[2][1] as string[]);
    child.run();
    expect(child.effects.deleted).toBe(true);
  });
  it.each([
    {
      label: "replaced file",
      mutate: () => {
        state.file = stat({ ino: 99n });
      },
    },
    {
      label: "replaced parent",
      mutate: () => {
        state.parent = stat({ ...state.parent, ino: 99n });
      },
    },
    {
      label: "wrong owner",
      mutate: () => {
        state.file = stat({ uid: 0n });
      },
    },
    {
      label: "symlink",
      mutate: () => {
        state.file = stat({ isSymbolicLink: () => true });
      },
    },
    {
      label: "hardlink",
      mutate: () => {
        state.file = stat({ nlink: 2n });
      },
    },
  ])("rejects $label after changing identity", ({ mutate }) => {
    unlinkHermesGeneratedFile(source);
    const child = fixture.child(processMock.spawnSync.mock.calls[2][1] as string[]);
    mutate();
    expect(child.run).toThrow("child refused changed source");
    expect(child.effects.deleted).toBe(false);
  });
});
