// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const pidPath = process.env.PID_PATH;
const termPath = process.env.TERM_PATH;

if (!pidPath || !termPath) {
  throw new Error("PID_PATH and TERM_PATH are required");
}

process.on("SIGTERM", () => fs.writeFileSync(termPath, "SIGTERM"));
fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => undefined, 1_000);
