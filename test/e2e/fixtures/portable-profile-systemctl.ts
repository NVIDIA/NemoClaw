// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEMCTL_SHIM_SOURCE = fileURLToPath(
  new URL("./portable-profile-systemctl-shim.sh", import.meta.url),
);

export function installPortableProfileSystemctlShim(binDir: string): string {
  const systemctl = path.join(binDir, "systemctl");
  fs.copyFileSync(SYSTEMCTL_SHIM_SOURCE, systemctl);
  fs.chmodSync(systemctl, 0o700);
  return systemctl;
}
