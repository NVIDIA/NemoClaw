// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedSandboxHostMountsEqual } from "../../state/registry/host-mount";
import {
  beginHostMountScope,
  isDockerBindMountsEnabled,
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
  reportReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
} from ".";

const created: string[] = [];

function workspaceTempDir(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".host-mount-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const target of created.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("read-only host mount validation", () => {
  it("accepts an existing absolute directory below /sandbox", () => {
    const source = workspaceTempDir();
    expect(parseReadOnlyHostMount(`${source}:/sandbox/project`)).toEqual(
      expect.objectContaining({
        source,
        target: "/sandbox/project",
        readOnly: true,
        sourceIdentity: {
          device: expect.any(String),
          inode: expect.any(String),
        },
      }),
    );
  });

  it("rejects missing, relative, symlinked, non-normalized, and terminal-control paths", () => {
    const source = workspaceTempDir();
    const symlink = `${source}-link`;
    fs.symlinkSync(source, symlink);
    created.push(symlink);

    expect(() => parseReadOnlyHostMount("relative:/sandbox/project")).toThrow(
      "host directory must be an absolute path",
    );
    expect(() => parseReadOnlyHostMount(`${source}-missing:/sandbox/project`)).toThrow(
      "does not exist",
    );
    expect(() => parseReadOnlyHostMount(`${symlink}:/sandbox/project`)).toThrow(
      "must not contain symlinks",
    );
    expect(() => parseReadOnlyHostMount(`${source}:/sandbox/../project`)).toThrow(
      "normalized absolute path below /sandbox",
    );
    for (const terminalControl of ["\u001b[31m", "\u202e", "\u2028", "\u2029"]) {
      let message = "";
      try {
        parseReadOnlyHostMount(`${source}:/sandbox/project${terminalControl}forged`);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("must not contain terminal control characters");
      expect(message).not.toContain(terminalControl);
    }
  });

  it("rejects duplicate host and sandbox directories", () => {
    const first = workspaceTempDir();
    const second = workspaceTempDir();
    expect(() =>
      parseReadOnlyHostMounts([`${first}:/sandbox/first`, `${first}:/sandbox/second`]),
    ).toThrow("Duplicate --host-mount host directory");
    expect(() =>
      parseReadOnlyHostMounts([`${first}:/sandbox/project`, `${second}:/sandbox/project`]),
    ).toThrow("Duplicate --host-mount sandbox directory");
  });

  it("fails closed when durable registry state is malformed or no longer usable", () => {
    const source = workspaceTempDir();
    expect(
      normalizePersistedSandboxHostMounts([{ source, target: "/sandbox/project", readOnly: true }]),
    ).toEqual([
      {
        source,
        target: "/sandbox/project",
        readOnly: true,
        sourceIdentity: { device: expect.any(String), inode: expect.any(String) },
      },
    ]);
    expect(() =>
      normalizePersistedSandboxHostMounts([
        { source, target: "/sandbox/project", readOnly: false },
      ]),
    ).toThrow("invalid read-only host mount");
    fs.rmSync(source, { recursive: true, force: true });
    created.splice(created.indexOf(source), 1);
    expect(() =>
      normalizePersistedSandboxHostMounts([{ source, target: "/sandbox/project", readOnly: true }]),
    ).toThrow("host directory does not exist");
  });

  it("revalidates and compares unordered declarations before sandbox reuse", () => {
    const first = {
      source: workspaceTempDir(),
      target: "/sandbox/first",
      readOnly: true as const,
    };
    const second = {
      source: workspaceTempDir(),
      target: "/sandbox/second",
      readOnly: true as const,
    };
    expect(persistedSandboxHostMountsEqual([first, second], [second, first])).toBe(true);
    expect(persistedSandboxHostMountsEqual([first], [first, second])).toBe(false);
    expect(persistedSandboxHostMountsEqual([first, second], [first])).toBe(false);
    expect(persistedSandboxHostMountsEqual([first], [second])).toBe(false);
    expect(persistedSandboxHostMountsEqual(undefined, [first])).toBe(false);
  });

  it("compares reordered distinct Unicode mount keys with a binary total order", () => {
    const lstat = vi
      .spyOn(fs, "lstatSync")
      .mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    const stat = vi.spyOn(fs, "statSync").mockReturnValue({
      isDirectory: () => true,
      dev: 1n,
      ino: 2n,
    } as fs.BigIntStats);
    const first = { source: "/srv/ñ", target: "/sandbox/é", readOnly: true as const };
    const second = { source: "/srv/ñ", target: "/sandbox/é", readOnly: true as const };
    try {
      expect(persistedSandboxHostMountsEqual([first, second], [second, first])).toBe(true);
    } finally {
      lstat.mockRestore();
      stat.mockRestore();
    }
  });

  it("rejects a validated source replaced before the sandbox create boundary", () => {
    const source = workspaceTempDir();
    const replacement = workspaceTempDir();
    const mount = parseReadOnlyHostMount(`${source}:/sandbox/project`);
    fs.rmSync(source, { recursive: true, force: true });
    fs.symlinkSync(replacement, source);

    expect(() => verifyReadOnlyHostMountSources([mount])).toThrow(
      `Read-only host mount source changed after validation: ${source}`,
    );
  });

  it("scopes the managed gateway capability and reports requested access", () => {
    const mount = {
      source: workspaceTempDir(),
      target: "/sandbox/project",
      readOnly: true as const,
    };
    const messages: string[] = [];
    const scope = beginHostMountScope([mount]);

    expect(isDockerBindMountsEnabled()).toBe(false);
    const mounts = scope.activate(undefined);
    expect(isDockerBindMountsEnabled()).toBe(true);
    reportReadOnlyHostMounts(mounts, (message) => messages.push(message));
    expect(messages).toContain(`    ${mount.source} -> /sandbox/project`);

    scope.restore();
    expect(isDockerBindMountsEnabled()).toBe(false);
  });

  it("rejects terminal-control mount text before capability changes or onboarding output", () => {
    const source = workspaceTempDir();
    const unsafeMount = {
      source,
      target: "/sandbox/project\u2028forged",
      readOnly: true as const,
    };
    const messages: string[] = [];

    expect(() => beginHostMountScope([unsafeMount])).toThrow("terminal control characters");
    expect(isDockerBindMountsEnabled()).toBe(false);
    expect(() =>
      reportReadOnlyHostMounts([unsafeMount], (message) => messages.push(message)),
    ).toThrow("terminal control characters");
    expect(messages).toEqual([]);
  });
});
