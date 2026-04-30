// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for staging a Docker build context and classifying sandbox
 * creation failures.
 */

import { CLI_NAME } from "./branding";
import fs from "node:fs";
import path from "node:path";

import { classifySandboxCreateFailure } from "./validation";

const EXCLUDED_SEGMENTS = new Set([
  ".venv",
  ".ruff_cache",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "node_modules",
  ".git",
]);

export function shouldIncludeBuildContextPath(sourceRoot: string, candidatePath: string): boolean {
  const relative = path.relative(sourceRoot, candidatePath);
  if (!relative || relative === "") return true;

  const segments = relative.split(path.sep);
  const basename = path.basename(candidatePath);

  if (basename === ".DS_Store" || basename.startsWith("._")) {
    return false;
  }

  return !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export function copyBuildContextDir(sourceDir: string, destinationDir: string): void {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (candidatePath) => shouldIncludeBuildContextPath(sourceDir, candidatePath),
  });
}

export function printSandboxCreateRecoveryHints(output = ""): void {
  const failure = classifySandboxCreateFailure(output);
  if (failure.kind === "image_transfer_timeout") {
    console.error("  Hint: image upload into the OpenShell gateway timed out.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    if (failure.uploadedToGateway) {
      console.error(
        "  Progress reached the gateway upload stage, so resume may be able to reuse existing gateway state.",
      );
    }
    console.error("  If this repeats, check Docker memory and retry on a host with more RAM.");
    return;
  }
  if (failure.kind === "image_transfer_reset") {
    console.error("  Hint: the image push/import stream was interrupted.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    if (failure.uploadedToGateway) {
      console.error("  The image appears to have reached the gateway before the stream failed.");
    }
    console.error("  If this repeats, restart Docker or the gateway and retry.");
    return;
  }
  if (failure.kind === "sandbox_create_incomplete") {
    console.error("  Hint: sandbox creation started but the create stream did not finish cleanly.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    console.error(
      "  Check: openshell sandbox list        # verify whether the sandbox became ready",
    );
    return;
  }
  if (failure.kind === "tls_cert_mismatch") {
    console.error(
      "  Hint: TLS certificate mismatch — the gateway certificate changed since the CLI last trusted it.",
    );
    console.error("  Fix:  openshell gateway trust -g nemoclaw");
    console.error(`  Then: ${CLI_NAME} onboard --resume`);
    return;
  }
  console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
  console.error(`  Or:      ${CLI_NAME} onboard`);
}
