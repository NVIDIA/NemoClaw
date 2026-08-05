// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cleanupLocalModelRuntimes } from "./cleanup";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--delete-models", "--keep-models"].includes(args[0]!)) {
    throw new Error("host-local model cleanup requires --delete-models or --keep-models");
  }
  const result = cleanupLocalModelRuntimes({ deleteModels: args[0] === "--delete-models" });
  for (const resource of result.removed) console.log(`Removed ${resource}`);
  for (const resource of result.preserved) console.log(`Preserved ${resource}`);
  if (!result.ok) throw new Error(result.reason);
} catch (error) {
  console.error(
    `Refusing uninstall before host-local model cleanup: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
