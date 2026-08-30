// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const source = process.argv[2];
const pidPath =
  process.env.PID_PATH ?? (source ? path.join(source, "trusted-child-pid") : undefined);
const termPath =
  process.env.TERM_PATH ?? (source ? path.join(source, "trusted-child-term") : undefined);

if (!pidPath || !termPath) {
  throw new Error("PID_PATH and TERM_PATH or a source path are required");
}

process.on("SIGTERM", () => fs.writeFileSync(termPath, "SIGTERM"));
fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => undefined, 1_000);
