// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { vi } from "vitest";

/** Interrupt the selected metadata write only after the filesystem accepts a prefix. */
export function interruptMetadataWrite(marker: string, prefixLength: (contents: string) => number) {
  const write = fs.writeSync;
  let interrupted: number | undefined;
  return vi.spyOn(fs, "writeSync").mockImplementation((descriptor, bytes, ...args) => {
    if (descriptor === interrupted) throw new Error("injected partial metadata write failure");
    const contents = Buffer.from(bytes).toString();
    if (contents.includes(marker)) {
      interrupted = descriptor;
      return write(descriptor, Buffer.from(bytes), 0, prefixLength(contents), 0);
    }
    return write(descriptor, bytes, ...args);
  });
}

/** Model another owner replacing metadata immediately after the selected read. */
export function replaceAfterMetadataRead(marker: string, replace: () => void) {
  const read = fs.readFileSync;
  let replaced = false;
  return vi.spyOn(fs, "readFileSync").mockImplementation((descriptor, ...args) => {
    const contents = read(descriptor, ...args);
    if (!replaced && contents.toString().includes(marker)) {
      replaced = true;
      replace();
    }
    return contents;
  });
}

/** Fail directory publication while allowing staged file contents to sync. */
export function failMetadataDirectorySync() {
  const sync = fs.fsyncSync;
  return vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) throw new Error("directory sync failed");
    sync(descriptor);
  });
}
