// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Gateway credentials require trusted ancestors; an isolated HOME under /tmp is rejected. */
export function createPublicInstallerWorkspace(): string {
  return fs.mkdtempSync(path.join(os.userInfo().homedir, ".nemoclaw-public-install-"));
}
