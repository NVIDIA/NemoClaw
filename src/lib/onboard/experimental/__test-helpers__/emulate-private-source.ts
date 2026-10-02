// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

import { ROOT } from "../../../runner";

/**
 * Emulate owner-only modes for the repository working tree and its ancestors,
 * plus shared temp roots. This allows build-context tests to run on checkouts
 * created under a permissive umask (e.g., 0002) without triggering group-
 * writable authority failures.
 */
export function emulatePrivateSourceAncestor(): void {
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const originalOpen = fs.openSync;
  const sharedTemporaryRoots = new Set([path.resolve("/tmp"), fs.realpathSync("/tmp")]);
  const sourceRoot = path.resolve(ROOT);
  for (let directory = sourceRoot; ; directory = path.dirname(directory)) {
    sharedTemporaryRoots.add(directory);
    if (path.dirname(directory) === directory) break;
  }
  const maskedFds = new Set<number>();
  const emulateOwnerOnlyMode = (target: unknown): boolean => {
    const resolved = path.resolve(String(target));
    return sharedTemporaryRoots.has(resolved) || resolved.startsWith(`${sourceRoot}${path.sep}`);
  };
  const wrapStat = (stat: fs.Stats): fs.Stats =>
    new Proxy(stat, {
      get(value, property) {
        const mode = BigInt(Reflect.get(value, "mode", value));
        return property === "mode" ? mode & ~0o22n : Reflect.get(value, property, value);
      },
    });
  vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
    const stat = originalLstat(target, options as never);
    if (stat === undefined) return undefined;
    return emulateOwnerOnlyMode(target) ? wrapStat(stat) : stat;
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, "openSync").mockImplementation(((path_, flags, mode) => {
    const fd = originalOpen(path_, flags, mode);
    if (emulateOwnerOnlyMode(path_)) maskedFds.add(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
    const stat = originalFstat(fd, options as never);
    return maskedFds.has(fd) ? wrapStat(stat) : stat;
  }) as typeof fs.fstatSync);
  const originalClose = fs.closeSync;
  vi.spyOn(fs, "closeSync").mockImplementation(((fd) => {
    maskedFds.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync);
}
