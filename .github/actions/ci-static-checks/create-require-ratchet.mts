// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Enforce the createRequire allowlist ratchet from the base-trusted CI action.
 *
 * Pull requests execute this file and its locked parser dependency from the
 * action checked out at the immutable base SHA. Neither the PR's dependencies
 * nor its local checker implementation execute before this verification.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTrustedCreateRequireRatchet } from "./create-require-ratchet-core.mts";
import ts from "./node_modules/typescript/lib/typescript.js";

function main(): void {
  const repoRoot = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const failure = verifyTrustedCreateRequireRatchet(ts, repoRoot);
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log("Base-trusted createRequire allowlist ratchet passed.");
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(invokedPath))
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
