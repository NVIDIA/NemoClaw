// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

const [entry, mode, store] = process.argv.slice(2);
if (!entry || !store || !["dry-run", "import"].includes(mode))
  throw new Error("Invalid session migration command.");
process.argv = [
  process.execPath,
  entry,
  "doctor",
  "--session-sqlite",
  mode,
  "--session-sqlite-store",
  store,
  "--json",
];
Promise.resolve()
  .then(() => createRequire(entry)(entry).runOpenClaw(process.argv))
  .catch((error) => {
    // The upstream CLI reports successful one-shot completion with ExitError(0).
    process.exitCode =
      error?.name === "ExitError" &&
      Number.isInteger(error.code) &&
      error.code >= 0 &&
      error.code <= 255
        ? error.code
        : 1;
    if (process.exitCode !== 0)
      console.error("OpenClaw session migration failed. Original migration archives are retained.");
  });
