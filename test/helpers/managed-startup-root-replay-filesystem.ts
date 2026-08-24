// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { vi } from "vitest";

import { MANAGED_STARTUP_RUNTIME_ENV_FILE } from "../../src/lib/onboard/managed-startup/image-runtime";

type RenameObserver = (source: string, target: string) => void;
type UnlinkObserver = (target: string) => void;
type ObserverEffect = () => void;
type ObserverGate = () => boolean;

const alwaysObserve: ObserverGate = () => true;

export function observeMatchingRename(
  expectedSource: string,
  expectedTarget: string,
  effect: ObserverEffect,
  enabled: ObserverGate = alwaysObserve,
): RenameObserver {
  return (source, target) => {
    if (enabled() && source === expectedSource && target === expectedTarget) effect();
  };
}

export function observeMatchingLink(
  expectedSource: string,
  expectedTarget: string,
  effect: ObserverEffect,
): RenameObserver {
  return observeMatchingRename(expectedSource, expectedTarget, effect);
}

export function observeMatchingRenameTarget(
  expectedTarget: string,
  effect: ObserverEffect,
): RenameObserver {
  return (_source, target) => {
    if (target === expectedTarget) effect();
  };
}

export function observeMatchingUnlink(
  expectedTarget: string,
  effect: ObserverEffect,
  enabled: ObserverGate = alwaysObserve,
): UnlinkObserver {
  return (target) => {
    if (enabled() && target === expectedTarget) effect();
  };
}

export function mockRootReplayFilesystem(
  runtimeWrites: string[],
  seededFiles: ReadonlyMap<
    string,
    { readonly contents: string | Buffer; readonly mode: number }
  > = new Map(),
): {
  readonly beforeRename: (callback: ((source: string, target: string) => void) | null) => void;
  readonly afterRename: (callback: ((source: string, target: string) => void) | null) => void;
  readonly beforeLink: (callback: ((source: string, target: string) => void) | null) => void;
  readonly beforeUnlink: (callback: ((target: string) => void) | null) => void;
  readonly chmodDirectory: (target: string, mode: number) => void;
  readonly hasFile: (target: string) => boolean;
  readonly linkCount: (target: string) => bigint;
  readonly markDirectorySymlink: (target: string) => void;
  readonly readFile: (target: string) => string | null;
  readonly writeFile: (target: string, contents: string | Buffer, mode: number) => void;
} {
  const directories = new Set([
    "/",
    "/etc",
    "/etc/ssl",
    "/etc/ssl/certs",
    "/run",
    "/run/nemoclaw",
    "/usr",
    "/usr/local",
    "/usr/local/share",
    "/usr/local/share/ca-certificates",
    "/usr/sbin",
    "/var",
    "/var/lib",
    "/var/lib/nemoclaw",
  ]);
  const fixtureFiles = new Map([
    [
      "/usr/sbin/update-ca-certificates",
      { contents: "managed startup test executable", mode: 0o555 },
    ],
    ...seededFiles,
  ]);
  const files: Map<string, Buffer> = new Map(
    [...fixtureFiles].map(([target, file]) => [
      target,
      Buffer.isBuffer(file.contents)
        ? Buffer.from(file.contents)
        : Buffer.from(file.contents, "utf8"),
    ]),
  );
  const directoryModes = new Map([...directories].map((target) => [target, 0o755]));
  const symlinkDirectories = new Set<string>();
  const fileModes = new Map([...fixtureFiles].map(([target, file]) => [target, file.mode]));
  let nextFileInode = 2n;
  const fileInodes = new Map<string, bigint>();
  const fileCtimes = new Map<string, bigint>();
  for (const target of files.keys()) {
    fileInodes.set(target, nextFileInode);
    fileCtimes.set(target, 1n);
    nextFileInode += 1n;
  }
  const descriptorTargets = new Map<number, string>();
  const descriptorSnapshots = new Map<
    number,
    {
      readonly bytes: Buffer;
      readonly ctimeNs: bigint;
      readonly ino: bigint;
      readonly mode: number;
    }
  >();
  const pendingFiles = new Map<string, Buffer>();
  const pendingModes = new Map<string, number>();
  let linkObserver: ((source: string, target: string) => void) | null = null;
  let renameObserver: ((source: string, target: string) => void) | null = null;
  let afterRenameObserver: ((source: string, target: string) => void) | null = null;
  let unlinkObserver: ((target: string) => void) | null = null;
  let nextDescriptor = 91;
  const fileLinkCount = (ino: bigint): bigint =>
    BigInt([...fileInodes.values()].filter((candidate) => candidate === ino).length);
  const bumpFileCtime = (ino: bigint): void => {
    const currentCtimes = [
      ...[...fileCtimes].flatMap(([target, ctimeNs]) =>
        fileInodes.get(target) === ino ? [ctimeNs] : [],
      ),
      ...[...descriptorSnapshots.values()].flatMap((snapshot) =>
        snapshot.ino === ino ? [snapshot.ctimeNs] : [],
      ),
    ];
    const nextCtime =
      currentCtimes.reduce((latest, ctimeNs) => (ctimeNs > latest ? ctimeNs : latest), 0n) + 1n;
    for (const [target, targetInode] of fileInodes) {
      if (targetInode === ino) fileCtimes.set(target, nextCtime);
    }
    for (const [descriptor, snapshot] of descriptorSnapshots) {
      if (snapshot.ino === ino)
        descriptorSnapshots.set(descriptor, { ...snapshot, ctimeNs: nextCtime });
    }
  };
  const stat = (kind: "directory" | "file" | "symlink", mode: number) =>
    ({
      gid: 0,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => kind === "symlink",
      mode,
      nlink: 1,
      uid: 0,
    }) as fs.Stats;
  const bigDirectoryStat = (target: string) =>
    ({
      ctimeNs: 1n,
      dev: 1n,
      gid: 0n,
      ino: 1n,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      mode: BigInt(0o040000 | (directoryModes.get(target) ?? 0o755)),
      mtimeNs: 1n,
      nlink: 1n,
      size: 0n,
      uid: 0n,
    }) as fs.BigIntStats;
  const bigFileStat = (bytes: Buffer, mode: number, ino: bigint, ctimeNs: bigint, nlink: bigint) =>
    ({
      ctimeNs,
      dev: 1n,
      gid: 0n,
      ino,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: BigInt(0o100000 | mode),
      mtimeNs: 1n,
      nlink,
      size: BigInt(bytes.length),
      uid: 0n,
    }) as fs.BigIntStats;
  const missing = (): never => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const allocateDescriptor = (resolved: string, mode = 0o600): number => {
    const descriptor = nextDescriptor;
    nextDescriptor += 1;
    descriptorTargets.set(descriptor, resolved);
    pendingModes.set(resolved, mode);
    return descriptor;
  };
  const deleteExistingFile = (resolved: string): void => {
    void (files.get(resolved) ?? missing());
    const inode = fileInodes.get(resolved) ?? missing();
    files.delete(resolved);
    fileInodes.delete(resolved);
    fileCtimes.delete(resolved);
    fileModes.delete(resolved);
    bumpFileCtime(inode);
  };

  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(fs, "lstatSync").mockImplementation(((
    target: fs.PathLike,
    options?: { bigint?: boolean },
  ) => {
    const resolved = String(target);
    const bytes = files.get(resolved);
    const mode = fileModes.get(resolved) ?? 0o444;
    return directories.has(resolved)
      ? options?.bigint
        ? bigDirectoryStat(resolved)
        : stat(
            symlinkDirectories.has(resolved) ? "symlink" : "directory",
            directoryModes.get(resolved) ?? 0o755,
          )
      : bytes === undefined
        ? missing()
        : options?.bigint
          ? bigFileStat(
              bytes,
              mode,
              fileInodes.get(resolved) ?? missing(),
              fileCtimes.get(resolved) ?? missing(),
              fileLinkCount(fileInodes.get(resolved) ?? missing()),
            )
          : stat("file", mode);
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, "mkdirSync").mockImplementation(((
    target: fs.PathLike,
    options?: { mode?: number },
  ) => {
    const resolved = String(target);
    if (directories.has(resolved) || files.has(resolved)) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    directories.add(resolved);
    directoryModes.set(resolved, options?.mode ?? 0o777);
    return undefined;
  }) as typeof fs.mkdirSync);
  vi.spyOn(fs, "chownSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "chmodSync").mockImplementation(((target: fs.PathLike, mode: fs.Mode) => {
    const resolved = String(target);
    const numeric = typeof mode === "number" ? mode : Number.parseInt(mode, 8);
    if (directories.has(resolved)) directoryModes.set(resolved, numeric);
    else if (files.has(resolved)) fileModes.set(resolved, numeric);
    else missing();
  }) as typeof fs.chmodSync);
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags, mode) => {
    const resolved = String(target);
    const creates =
      typeof flags === "number" ? (flags & fs.constants.O_CREAT) !== 0 : /[awx]/u.test(flags);
    if (!creates && !files.has(resolved) && !directories.has(resolved)) missing();
    const descriptor = allocateDescriptor(resolved, typeof mode === "number" ? mode : 0o600);
    const bytes = files.get(resolved);
    if (bytes !== undefined) {
      descriptorSnapshots.set(descriptor, {
        bytes: Buffer.from(bytes),
        ctimeNs: fileCtimes.get(resolved) ?? missing(),
        ino: fileInodes.get(resolved) ?? missing(),
        mode: fileModes.get(resolved) ?? 0o444,
      });
    }
    return descriptor;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number) => {
    const snapshot = descriptorSnapshots.get(descriptor);
    if (snapshot !== undefined) {
      return bigFileStat(
        snapshot.bytes,
        snapshot.mode,
        snapshot.ino,
        snapshot.ctimeNs,
        fileLinkCount(snapshot.ino),
      );
    }
    const target = descriptorTargets.get(descriptor);
    const bytes = target === undefined ? undefined : files.get(target);
    return bytes === undefined
      ? missing()
      : bigFileStat(
          bytes,
          fileModes.get(target as string) ?? 0o444,
          fileInodes.get(target as string) ?? missing(),
          fileCtimes.get(target as string) ?? missing(),
          fileLinkCount(fileInodes.get(target as string) ?? missing()),
        );
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, "readSync").mockImplementation(((
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const target = descriptorTargets.get(descriptor);
    const bytes =
      descriptorSnapshots.get(descriptor)?.bytes ??
      (target === undefined ? undefined : files.get(target)) ??
      missing();
    const start = position ?? 0;
    const count = Math.min(length, Math.max(0, bytes.length - start));
    bytes.copy(buffer as Buffer, offset, start, start + count);
    return count;
  }) as typeof fs.readSync);
  vi.spyOn(fs, "fchownSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, value) => {
    const resolved =
      (typeof target === "number" ? descriptorTargets.get(target) : undefined) ?? missing();
    pendingFiles.set(
      resolved,
      Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8"),
    );
  }) as typeof fs.writeFileSync);
  vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
    const target = descriptorTargets.get(descriptor) ?? missing();
    pendingModes.set(target, typeof mode === "number" ? mode : Number.parseInt(mode, 8));
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
    descriptorSnapshots.delete(descriptor);
    descriptorTargets.delete(descriptor);
  });
  vi.spyOn(fs, "linkSync").mockImplementation(((existingPath, newPath) => {
    const resolvedSource = String(existingPath);
    const resolvedTarget = String(newPath);
    linkObserver?.(resolvedSource, resolvedTarget);
    if (files.has(resolvedTarget) || directories.has(resolvedTarget)) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    const sourceInode = fileInodes.get(resolvedSource) ?? missing();
    files.set(resolvedTarget, files.get(resolvedSource) ?? missing());
    fileInodes.set(resolvedTarget, sourceInode);
    fileCtimes.set(resolvedTarget, fileCtimes.get(resolvedSource) ?? missing());
    fileModes.set(resolvedTarget, fileModes.get(resolvedSource) ?? missing());
    bumpFileCtime(sourceInode);
  }) as typeof fs.linkSync);
  vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
    const resolvedSource = String(source);
    const resolvedTarget = String(target);
    renameObserver?.(resolvedSource, resolvedTarget);
    const pending = pendingFiles.get(resolvedSource);
    if (pending !== undefined) {
      if (files.has(resolvedTarget)) deleteExistingFile(resolvedTarget);
      files.set(resolvedTarget, pending);
      fileInodes.set(resolvedTarget, nextFileInode);
      fileCtimes.set(resolvedTarget, 1n);
      nextFileInode += 1n;
      fileModes.set(resolvedTarget, pendingModes.get(resolvedSource) ?? 0o444);
      pendingFiles.delete(resolvedSource);
      pendingModes.delete(resolvedSource);
    } else {
      const sourceBytes = files.get(resolvedSource) ?? missing();
      const sourceInode = fileInodes.get(resolvedSource) ?? missing();
      const targetInode = fileInodes.get(resolvedTarget);
      if (targetInode === sourceInode) {
        afterRenameObserver?.(resolvedSource, resolvedTarget);
        return;
      }
      const sourceMode = fileModes.get(resolvedSource) ?? missing();
      if (files.has(resolvedTarget)) deleteExistingFile(resolvedTarget);
      files.set(resolvedTarget, sourceBytes);
      fileInodes.set(resolvedTarget, sourceInode);
      fileModes.set(resolvedTarget, sourceMode);
      fileCtimes.set(resolvedTarget, fileCtimes.get(resolvedSource) ?? missing());
      files.delete(resolvedSource);
      fileInodes.delete(resolvedSource);
      fileModes.delete(resolvedSource);
      fileCtimes.delete(resolvedSource);
      bumpFileCtime(sourceInode);
    }
    runtimeWrites.push(
      ...(resolvedTarget === MANAGED_STARTUP_RUNTIME_ENV_FILE
        ? [(files.get(resolvedTarget) ?? missing()).toString("utf8")]
        : []),
    );
    afterRenameObserver?.(resolvedSource, resolvedTarget);
  });
  vi.spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
    const resolved = String(target);
    unlinkObserver?.(resolved);
    const removedPendingFile = pendingFiles.delete(resolved);
    pendingModes.delete(resolved);
    if (removedPendingFile) return;
    deleteExistingFile(resolved);
  }) as typeof fs.unlinkSync);
  vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike) => {
    const resolved = String(target);
    if (!directories.has(resolved)) return missing();
    const prefix = `${resolved}/`;
    return [...files.keys(), ...directories]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .filter((entry) => entry.length > 0 && !entry.includes("/"));
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, "rmdirSync").mockImplementation(((target: fs.PathLike) => {
    const resolved = String(target);
    if (!directories.has(resolved)) return missing();
    const prefix = `${resolved}/`;
    if (
      [...files.keys(), ...directories].some(
        (entry) => entry !== resolved && entry.startsWith(prefix),
      )
    ) {
      throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
    }
    directories.delete(resolved);
    directoryModes.delete(resolved);
  }) as typeof fs.rmdirSync);

  return {
    afterRename: (callback) => {
      afterRenameObserver = callback;
    },
    beforeLink: (callback) => {
      linkObserver = callback;
    },
    beforeRename: (callback) => {
      renameObserver = callback;
    },
    beforeUnlink: (callback) => {
      unlinkObserver = callback;
    },
    chmodDirectory: (target, mode) => {
      if (!directories.has(target)) missing();
      directoryModes.set(target, mode);
    },
    hasFile: (target) => files.has(target),
    linkCount: (target) => fileLinkCount(fileInodes.get(target) ?? missing()),
    markDirectorySymlink: (target) => {
      if (!directories.has(target)) missing();
      symlinkDirectories.add(target);
    },
    readFile: (target) => files.get(target)?.toString("utf8") ?? null,
    writeFile: (target, contents, mode) => {
      if (files.has(target)) deleteExistingFile(target);
      files.set(
        target,
        Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8"),
      );
      fileInodes.set(target, nextFileInode);
      fileCtimes.set(target, 1n);
      nextFileInode += 1n;
      fileModes.set(target, mode);
    },
  };
}
