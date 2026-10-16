// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import {
  captureMigrationHistory,
  verifyMigrationHistory,
} from "./native-openclaw-migration-verification.mts";

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
  .then(async () => {
    const history = mode === "import" ? captureMigrationHistory(store) : undefined;
    try {
      await createRequire(entry)(entry).runOpenClaw(process.argv);
    } catch (error) {
      // Successful one-shot upstream commands can throw instead of returning.
      if (
        !(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "ExitError" &&
          "code" in error &&
          error.code === 0
        )
      )
        throw error;
    }
    if (history) verifyMigrationHistory(history);
  })
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
