// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

export function boundedTestTempRoot(relativePath: string, maxPathBytes: number): string {
  const privateTempRoot = os.tmpdir();
  if (Buffer.byteLength(path.join(privateTempRoot, relativePath)) < maxPathBytes) {
    return privateTempRoot;
  }

  const shortSystemTempRoot = path.join(path.parse(privateTempRoot).root, "tmp");
  if (Buffer.byteLength(path.join(shortSystemTempRoot, relativePath)) < maxPathBytes) {
    return shortSystemTempRoot;
  }

  throw new Error(`Temporary path cannot fit within ${maxPathBytes} bytes`);
}
