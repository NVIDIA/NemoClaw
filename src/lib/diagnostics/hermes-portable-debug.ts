// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectPortableAgentReceiptAuthorityForClassification } from "../onboard/experimental/hermes-portable-receipt";
import { defaultPortableStateDir } from "../state/portable-uninstall-retirement";
import { redact, type DebugOptions } from "./debug";
import { createTarball } from "./tarball";

/** Read only the selected receipt's retained state; never probe a runtime or copy private authority. */
export function inspectHermesPortableDebugSummary(sandboxName: string) {
  const authority = inspectPortableAgentReceiptAuthorityForClassification(
    sandboxName,
    defaultPortableStateDir(process.env),
  );
  if (authority.kind !== "hermes") return null;
  const { receipt } = authority.snapshot;
  return {
    gatewayName: receipt.gatewayName,
    report: {
      schemaVersion: 1,
      sandboxName,
      agent: "hermes",
      savedLifecyclePhase: receipt.phase,
      runtimeHealth: "not-probed",
      agentHealth: "not-probed",
    },
  };
}

/** Emit a minimal offline Portable report through the existing debug output contract. */
export function runHermesPortableDebug(
  options: DebugOptions,
  summary: NonNullable<ReturnType<typeof inspectHermesPortableDebugSummary>>,
): void {
  const report = redact(JSON.stringify(summary.report, null, 2)) + "\n";
  console.log(
    "[debug] Offline Portable lifecycle diagnostics; runtime and agent health were not probed.",
  );
  console.log(report);
  if (!options.output) return;
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-portable-debug-"));
  try {
    writeFileSync(join(directory, "portable-lifecycle.json"), report, { mode: 0o600 });
    createTarball(directory, options.output, {
      info: (message) => console.log(message),
      warn: (message) => console.log(message),
      error: (message) => console.error(message),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
