// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";

type NativeFunction = (...args: unknown[]) => unknown;
type Koffi = {
  load(name: string): { func(declaration: string): NativeFunction };
  address(pointer: unknown): bigint;
};
export type CanonicalPathApi = {
  open(pathname: string): unknown;
  invalid(handle: unknown): boolean;
  finalPath(handle: unknown, output: Buffer, volume?: number): number;
  close(handle: unknown): boolean;
  lastError(): number;
};

function windowsApi(koffi: Koffi): CanonicalPathApi {
  const kernel = koffi.load("kernel32.dll");
  const open = kernel.func(
    "void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template)",
  );
  const finalPath = kernel.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, _Out_ uint16_t *output, uint32_t length, uint32_t flags)",
  );
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  return {
    open: (pathname) => open(pathname, 0, 7, null, 3, 0x02000080, null),
    invalid: (handle) =>
      handle === null || [-1n, 0xffffffffffffffffn].includes(koffi.address(handle)),
    finalPath: (handle, output, volume = 2) =>
      Number(finalPath(handle, output, output.length / 2, volume)),
    close: (handle) => Boolean(close(handle)),
    lastError: () => Number(lastError()),
  };
}

function pathError(code: string, pathname: string, detail: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${detail}, realpath '${pathname}'`), {
    code,
    syscall: "realpath",
    path: pathname,
  });
}

function apiError(api: CanonicalPathApi, pathname: string): NodeJS.ErrnoException {
  const status = api.lastError();
  const codes: Record<number, string> = {
    2: "ENOENT",
    3: "ENOENT",
    5: "EPERM",
    15: "ENOENT",
    32: "EBUSY",
    87: "EINVAL",
    123: "EINVAL",
    206: "ENAMETOOLONG",
    1921: "ELOOP",
  };
  return pathError(codes[status] ?? "EIO", pathname, `Windows path error ${status}`);
}

export function canonicalPathFromHandle(
  pathname: string,
  api: CanonicalPathApi,
  volume: "nt" | "relative" = "nt",
): string {
  if (typeof pathname !== "string" || pathname.includes("\0"))
    throw new TypeError("SQLite canonical paths must be strings without NUL characters.");
  const handle = api.open(pathname);
  if (api.invalid(handle)) throw apiError(api, pathname);
  try {
    const output = Buffer.alloc(65536);
    const length = api.finalPath(handle, output, volume === "nt" ? 2 : 4);
    if (length === 0) throw apiError(api, pathname);
    if (!Number.isInteger(length) || length < 0 || length >= output.length / 2)
      throw pathError("ENAMETOOLONG", pathname, "canonical path exceeds the Windows limit");
    const normalized = output.subarray(0, length * 2).toString("utf16le");
    if (volume === "relative") {
      if (!/^\\(?!\\)/u.test(normalized) || normalized.includes("\0"))
        throw pathError("EIO", pathname, "unexpected Windows volume-relative name");
      return normalized;
    }
    if (!normalized.startsWith("\\Device\\") || normalized.includes("\0"))
      throw pathError("EIO", pathname, "unexpected Windows canonical namespace");
    // NT normalized names retain link resolution without consulting the mount manager.
    return "\\\\?\\GLOBALROOT" + normalized;
  } finally {
    if (!api.close(handle)) throw apiError(api, pathname);
  }
}

export function createSqliteCanonicalPath(loadKoffi: () => Koffi) {
  let api: CanonicalPathApi | undefined;
  return (pathname: string): string => {
    if (process.platform !== "win32") return fs.realpathSync.native(pathname);
    api ??= windowsApi(loadKoffi());
    return canonicalPathFromHandle(pathname, api);
  };
}

export function workspacePathFromHandle(pathname: string, api: CanonicalPathApi): string {
  const canonical = canonicalPathFromHandle(pathname, api);
  const relative = canonicalPathFromHandle(pathname, api, "relative");
  const preferred = /^(?:\\\\\?\\)?([a-z]:)\\/iu.exec(pathname)?.[1]?.toUpperCase();
  const drives = new Set([
    ...(preferred ? [preferred] : []),
    ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (letter) => `${letter}:`),
  ]);
  for (const drive of drives) {
    const resolved = drive + relative;
    try {
      // A drive spelling is accepted only after its handle proves the same NT identity.
      if (canonicalPathFromHandle(resolved, api) === canonical) return resolved;
    } catch (error) {
      if (!["ENOENT", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw pathError("EIO", pathname, "canonical workspace has no accessible drive mapping");
}

export function createWorkspaceCanonicalPath(loadKoffi: () => Koffi) {
  let api: CanonicalPathApi | undefined;
  return (pathname: string): string => {
    if (process.platform !== "win32") return fs.realpathSync.native(pathname);
    api ??= windowsApi(loadKoffi());
    return workspacePathFromHandle(pathname, api);
  };
}

export function resolveMissingSqlitePath(
  pathname: string,
  filesystem: Pick<typeof fs, "lstatSync" | "readlinkSync"> = fs,
  paths: typeof path = path,
): { existingPath: string; unresolvedSegments: string[] } {
  let current = pathname;
  let suffix: string[] = [];
  const visited = new Set<string>();
  let hops = 0;
  for (;;) {
    let stat: fs.BigIntStats;
    try {
      stat = filesystem.lstatSync(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = paths.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(paths.basename(current));
      current = parent;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      if (suffix.length && !stat.isDirectory())
        throw pathError("ENOTDIR", pathname, "missing path parent is not a directory");
      return { existingPath: current, unresolvedSegments: suffix };
    }
    const state = `${stat.dev}:${stat.ino}:${current}\0${suffix.join(paths.sep)}`;
    if (hops >= 64 || visited.has(state))
      throw pathError("ELOOP", pathname, "too many symbolic links");
    hops += 1;
    visited.add(state);
    const target = filesystem.readlinkSync(current);
    // Do not normalize '..' across a link before the filesystem resolves it.
    const absolute = paths.isAbsolute(target)
      ? target
      : paths.dirname(current) + paths.sep + target;
    current = absolute + (suffix.length ? paths.sep + suffix.join(paths.sep) : "");
    suffix = [];
  }
}
