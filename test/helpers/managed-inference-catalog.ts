// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";

import { generateServingCatalog } from "../../src/lib/inference/serving/generate-catalog";

/** Supply the real catalog for source tests without replacing restored CI artifacts. */
export function ensureTestServingCatalog(rootDir: string): void {
  if (!existsSync(join(rootDir, "dist", "managed-inference", "catalog.json"))) {
    generateServingCatalog({ rootDir });
  }
}
