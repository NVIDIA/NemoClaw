// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cleanupHuggingFaceCacheData, cleanupLocalModelRuntimes } from "./cleanup";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--clean-runtimes", "--delete-cache-data"].includes(args[0]!)) {
    throw new Error("host model cleanup requires --clean-runtimes or --delete-cache-data");
  }
  const result =
    args[0] === "--clean-runtimes" ? cleanupLocalModelRuntimes({}) : cleanupHuggingFaceCacheData();
  for (const resource of result.removed) console.log(`Removed ${resource}`);
  for (const resource of result.preserved) console.log(`Preserved ${resource}`);
  if (!result.ok) throw new Error(result.reason);
} catch (error) {
  const operation =
    process.argv.at(-1) === "--delete-cache-data"
      ? "Hugging Face cache-data cleanup"
      : "Host-local model runtime cleanup";
  console.error(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
