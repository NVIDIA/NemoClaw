// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { vi } from "vitest";

/** Model bounded descriptor reads for synthetic /proc files; leave other files real. */
export function mockGatewayProcFiles(files: ReadonlyMap<string, string>) {
  const open = fs.openSync;
  const read = fs.readSync;
  const close = fs.closeSync;
  const handles = new Map<number, { bytes: Buffer; offset: number }>();
  const openedPaths: string[] = [];
  let nextFd = -1;

  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    const filePath = String(file);
    const content = files.get(filePath);
    if (content === undefined) return open(file, flags, mode);
    const fd = nextFd--;
    handles.set(fd, { bytes: Buffer.from(content), offset: 0 });
    openedPaths.push(filePath);
    return fd;
  });
  vi.spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const handle = handles.get(fd);
    if (!handle) return read(fd, buffer, offset, length, position);
    const start = position ?? handle.offset;
    const count = handle.bytes.copy(buffer, offset, start, start + length);
    if (position === null) handle.offset += count;
    return count;
  }) as typeof fs.readSync);
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (!handles.delete(fd)) close(fd);
  });
  return { openedPaths };
}
