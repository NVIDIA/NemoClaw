// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CleanupRegistry } from "./cleanup.ts";

/** Keep installer gateway state beneath trusted ancestors and register disposal immediately. */
export function createPublicInstallWorkspace(cleanup: CleanupRegistry): string {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, ".nemoclaw-public-install-"));
  cleanup.trackDisposable("remove public installer workspace", () =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
  return root;
}
