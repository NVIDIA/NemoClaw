// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  assertPodmanExecutableAuthority,
  assertPodmanExecutableMetadataAuthority,
  capturePodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
  type PodmanExecutableStat,
} from "./executable-authority";

const EXECUTABLE_PATH = "/usr/bin/podman";
const EXECUTABLE_BYTES = Buffer.from("qualified-podman-binary", "utf8");
const DIRECTORY_INODES = new Map([
  ["/usr/bin", 101n],
  ["/usr", 102n],
  ["/", 103n],
]);

function executableStat(
  overrides: Partial<{
    ctimeNs: bigint;
    dev: bigint;
    file: boolean;
    ino: bigint;
    mode: bigint;
    mtimeNs: bigint;
    size: bigint;
    symlink: boolean;
    uid: bigint;
  }> = {},
): PodmanExecutableStat {
  return {
    dev: overrides.dev ?? 8n,
    ino: overrides.ino ?? 42n,
    mode: overrides.mode ?? 0o100755n,
    uid: overrides.uid ?? 0n,
    size: overrides.size ?? BigInt(EXECUTABLE_BYTES.byteLength),
    mtimeNs: overrides.mtimeNs ?? 1_000n,
    ctimeNs: overrides.ctimeNs ?? 2_000n,
    isDirectory: () => false,
    isFile: () => overrides.file ?? true,
    isSymbolicLink: () => overrides.symlink ?? false,
  };
}

function directoryStat(
  filePath: string,
  overrides: Partial<{ dev: bigint; ino: bigint; mode: bigint; uid: bigint }> = {},
): PodmanExecutableStat {
  return {
    dev: overrides.dev ?? 8n,
    ino: overrides.ino ?? DIRECTORY_INODES.get(filePath) ?? 199n,
    mode: overrides.mode ?? 0o40755n,
    uid: overrides.uid ?? 0n,
    size: 0n,
    mtimeNs: 1_000n,
    ctimeNs: 2_000n,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function authorityDeps(
  overrides: Partial<PodmanExecutableAuthorityDeps> = {},
): PodmanExecutableAuthorityDeps {
  return {
    uid: 1000,
    realpath: (filePath) => filePath,
    lstat: (filePath) =>
      filePath === EXECUTABLE_PATH ? executableStat() : directoryStat(filePath),
    readFile: () => EXECUTABLE_BYTES,
    ...overrides,
  };
}

describe("Podman executable authority", () => {
  it("captures immutable metadata and a content digest from a canonical absolute file", () => {
    const lstat = vi.fn((filePath: string) =>
      filePath === EXECUTABLE_PATH ? executableStat() : directoryStat(filePath),
    );
    const readFile = vi.fn(() => EXECUTABLE_BYTES);
    const realpath = vi.fn((filePath: string) => filePath);

    const authority = capturePodmanExecutableAuthority(
      EXECUTABLE_PATH,
      authorityDeps({ lstat, readFile, realpath }),
    );

    expect(authority).toEqual({
      changedTimeNanoseconds: "2000",
      device: "8",
      directoryChain: [
        {
          device: "8",
          inode: "101",
          mode: String(0o40755),
          ownerUid: "0",
          path: "/usr/bin",
        },
        {
          device: "8",
          inode: "102",
          mode: String(0o40755),
          ownerUid: "0",
          path: "/usr",
        },
        {
          device: "8",
          inode: "103",
          mode: String(0o40755),
          ownerUid: "0",
          path: "/",
        },
      ],
      executablePath: EXECUTABLE_PATH,
      inode: "42",
      mode: String(0o100755),
      modifiedTimeNanoseconds: "1000",
      ownerUid: "0",
      sha256: createHash("sha256").update(EXECUTABLE_BYTES).digest("hex"),
      size: String(EXECUTABLE_BYTES.byteLength),
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(lstat).toHaveBeenCalledTimes(8);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(EXECUTABLE_PATH);
    expect(realpath).toHaveBeenCalledTimes(2);
  });

  it("reports non-overlapping executable authority leaf operations", () => {
    const stages: string[] = [];

    capturePodmanExecutableAuthority(
      EXECUTABLE_PATH,
      authorityDeps({
        timing: {
          measure: (stage, operation) => {
            stages.push(stage);
            return operation();
          },
        },
      }),
    );

    expect(stages).toEqual([
      "podmanCanonicalRealpath",
      "podmanDirectoryChain",
      "podmanExecutableMetadata",
      "podmanContentRead",
      "podmanExecutableMetadata",
      "podmanDirectoryChain",
      "podmanCanonicalRealpath",
      "podmanAuthorityCompare",
      "podmanContentHash",
    ]);
  });

  it("accepts an executable owned by the current user", () => {
    const authority = capturePodmanExecutableAuthority(
      EXECUTABLE_PATH,
      authorityDeps({
        lstat: (filePath) =>
          filePath === EXECUTABLE_PATH
            ? executableStat({ uid: 1000n })
            : directoryStat(filePath, { uid: 1000n }),
      }),
    );

    expect(authority.ownerUid).toBe("1000");
  });

  it.each([
    ["podman", "canonical absolute path"],
    ["/usr/local/bin/../bin/podman", "canonical absolute path"],
    ["/usr/bin/podman\n", "canonical absolute path"],
  ])("rejects unsafe executable path %j", (executablePath, evidence) => {
    expect(() => capturePodmanExecutableAuthority(executablePath, authorityDeps())).toThrow(
      evidence,
    );
  });

  it("rejects a path whose canonical target differs", () => {
    expect(() =>
      capturePodmanExecutableAuthority(
        "/usr/local/bin/podman",
        authorityDeps({ realpath: () => "/opt/podman/bin/podman" }),
      ),
    ).toThrow("symlinked or non-canonical");
  });

  it.each([
    ["symlink", { symlink: true }, "symlink or is not a regular file"],
    ["non-file", { file: false }, "symlink or is not a regular file"],
    ["foreign owner", { uid: 2000n }, "expected root or current uid"],
    ["group-writable", { mode: 0o100775n }, "writable by another user or group"],
    ["other-writable", { mode: 0o100757n }, "writable by another user or group"],
    ["non-executable", { mode: 0o100644n }, "is not executable"],
    ["empty", { size: 0n }, "size is invalid"],
    ["unbounded", { size: 512n * 1024n * 1024n + 1n }, "exceeds its byte bound"],
  ] as const)("rejects %s executable authority", (_name, statOverrides, evidence) => {
    expect(() =>
      capturePodmanExecutableAuthority(
        EXECUTABLE_PATH,
        authorityDeps({
          lstat: (filePath) =>
            filePath === EXECUTABLE_PATH ? executableStat(statOverrides) : directoryStat(filePath),
        }),
      ),
    ).toThrow(evidence);
  });

  it("rejects metadata rotation while hashing the executable", () => {
    let executableReads = 0;
    const nextExecutableStat = () =>
      (executableReads += 1) === 1 ? executableStat() : executableStat({ ino: 43n });
    const lstat = vi.fn((filePath: string) =>
      filePath === EXECUTABLE_PATH ? nextExecutableStat() : directoryStat(filePath),
    );

    expect(() =>
      capturePodmanExecutableAuthority(EXECUTABLE_PATH, authorityDeps({ lstat })),
    ).toThrow("changed while it was captured");
  });

  it("rejects writable or foreign-owned executable parent directories", () => {
    expect(() =>
      capturePodmanExecutableAuthority(
        EXECUTABLE_PATH,
        authorityDeps({
          lstat: (filePath) =>
            filePath === EXECUTABLE_PATH
              ? executableStat()
              : directoryStat(filePath, filePath === "/usr/bin" ? { mode: 0o40775n } : {}),
        }),
      ),
    ).toThrow("writable by another user or group");
    expect(() =>
      capturePodmanExecutableAuthority(
        EXECUTABLE_PATH,
        authorityDeps({
          lstat: (filePath) =>
            filePath === EXECUTABLE_PATH
              ? executableStat()
              : directoryStat(filePath, filePath === "/usr/bin" ? { uid: 2000n } : {}),
        }),
      ),
    ).toThrow("expected root or current uid");
  });

  it("rejects executable parent-directory replacement after qualification", () => {
    const authority = capturePodmanExecutableAuthority(EXECUTABLE_PATH, authorityDeps());

    expect(() =>
      assertPodmanExecutableAuthority(
        authority,
        authorityDeps({
          lstat: (filePath) =>
            filePath === EXECUTABLE_PATH
              ? executableStat()
              : directoryStat(filePath, filePath === "/usr/bin" ? { ino: 999n } : {}),
        }),
      ),
    ).toThrow("changed after it was qualified");
  });

  it("rechecks the canonical path, trusted directory chain, and immutable metadata without rereading bytes", () => {
    const lstat = vi.fn((filePath: string) =>
      filePath === EXECUTABLE_PATH ? executableStat() : directoryStat(filePath),
    );
    const readFile = vi.fn(() => EXECUTABLE_BYTES);
    const realpath = vi.fn((filePath: string) => filePath);
    const deps = authorityDeps({ lstat, readFile, realpath });
    const authority = capturePodmanExecutableAuthority(EXECUTABLE_PATH, deps);
    lstat.mockClear();
    readFile.mockClear();
    realpath.mockClear();

    assertPodmanExecutableMetadataAuthority(authority, deps);

    expect(lstat).toHaveBeenCalledTimes(8);
    expect(realpath).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports metadata-only leaf operations without content work", () => {
    const authority = capturePodmanExecutableAuthority(EXECUTABLE_PATH, authorityDeps());
    const stages: string[] = [];

    assertPodmanExecutableMetadataAuthority(
      authority,
      authorityDeps({
        timing: {
          measure: (stage, operation) => {
            stages.push(stage);
            return operation();
          },
        },
      }),
    );

    expect(stages).toEqual([
      "podmanCanonicalRealpath",
      "podmanDirectoryChain",
      "podmanExecutableMetadata",
      "podmanExecutableMetadata",
      "podmanDirectoryChain",
      "podmanCanonicalRealpath",
      "podmanAuthorityCompare",
      "podmanAuthorityCompare",
    ]);
  });

  it("rejects executable rotation during a metadata-only authority check", () => {
    const authority = capturePodmanExecutableAuthority(EXECUTABLE_PATH, authorityDeps());
    let executableReads = 0;
    const nextExecutableStat = () =>
      (executableReads += 1) === 1 ? executableStat() : executableStat({ ino: 43n });
    const lstat = vi.fn((filePath: string) =>
      filePath === EXECUTABLE_PATH ? nextExecutableStat() : directoryStat(filePath),
    );
    const readFile = vi.fn(() => EXECUTABLE_BYTES);

    expect(() =>
      assertPodmanExecutableMetadataAuthority(authority, authorityDeps({ lstat, readFile })),
    ).toThrow("changed while it was checked");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects inconsistent executable bytes", () => {
    expect(() =>
      capturePodmanExecutableAuthority(
        EXECUTABLE_PATH,
        authorityDeps({ readFile: () => Buffer.from("short", "utf8") }),
      ),
    ).toThrow("inconsistent executable bytes");
  });

  it("rejects content drift even when all metadata is unchanged", () => {
    const authority = capturePodmanExecutableAuthority(EXECUTABLE_PATH, authorityDeps());
    const changedBytes = Buffer.from("changed-podman-executab", "utf8");
    expect(changedBytes.byteLength).toBe(EXECUTABLE_BYTES.byteLength);

    expect(() =>
      assertPodmanExecutableAuthority(authority, authorityDeps({ readFile: () => changedBytes })),
    ).toThrow("changed after it was qualified");
  });
});
