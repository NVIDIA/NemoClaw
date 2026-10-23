// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { vi } from "vitest";

/** Stub only one proc thread directory; leave other filesystem reads real. */
export function mockGatewayProcTaskDir(taskPath: string, initialEntries: readonly string[]) {
  const openDir = fs.opendirSync;
  let entries = initialEntries;
  let reads = 0;
  let closes = 0;
  vi.spyOn(fs, "opendirSync").mockImplementation((directory, options) => {
    if (String(directory) !== taskPath) return openDir(directory, options);
    let index = 0;
    return {
      readSync: () => {
        reads += 1;
        const name = entries[index++];
        return name === undefined ? null : { name };
      },
      closeSync: () => {
        closes += 1;
      },
    } as unknown as fs.Dir;
  });
  return {
    setEntries: (next: readonly string[]) => {
      entries = next;
    },
    get reads() {
      return reads;
    },
    get closes() {
      return closes;
    },
    resetCounts: () => {
      reads = 0;
      closes = 0;
    },
  };
}
