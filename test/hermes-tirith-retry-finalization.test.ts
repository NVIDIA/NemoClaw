// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";
import { extractShellFunction } from "./support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function runTirithFinalizer(commands: readonly string[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-finalize-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const marker = path.join(hermesHome, ".tirith-install-failed");
  const target = path.join(tmpDir, "symlink-target");
  const scriptPath = path.join(tmpDir, "run.sh");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(marker, "download_failed");

  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "retry_tirith_marker_if_needed"),
      extractShellFunction(source, "finalize_tirith_marker_retry"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `MARKER=${shellQuote(marker)}`,
      `TARGET=${shellQuote(target)}`,
      "TIRITH_RETRY_MARKER_CLEARED=0",
      ...commands,
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    timeout: 5000,
    env: process.env,
  });
  const markerKind = fs.lstatSync(marker, { throwIfNoEntry: false });
  const markerContent = markerKind?.isFile() ? fs.readFileSync(marker, "utf-8") : "";
  const targetContent = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { markerContent, markerKind, result, source, targetContent };
}

describe("agents/hermes/start.sh Tirith retry finalization", () => {
  it("clears a download_failed marker recreated by the handled startup retry", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      'printf %s download_failed > "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind).toBeUndefined();
    expect(run.result.stderr).toContain(
      "Tirith retry completed with download_failed; clearing the handled retry marker",
    );
  });

  it("preserves a recreated symlink and never reads or removes its target", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      'printf %s sensitive-target > "$TARGET"',
      'ln -s "$TARGET" "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isSymbolicLink()).toBe(true);
    expect(run.targetContent).toBe("sensitive-target");
    expect(run.result.stderr).toContain("unsafe Tirith install marker recreated during retry");
    expect(run.result.stderr).not.toContain("sensitive-target");
  });

  it("preserves a recreated non-regular marker", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      'mkdir "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isDirectory()).toBe(true);
    expect(run.result.stderr).toContain("unsafe Tirith install marker recreated during retry");
  });

  it("preserves a recreated marker with a non-retryable reason", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      'printf %s checksum_failed > "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isFile()).toBe(true);
    expect(run.markerContent).toBe("checksum_failed");
  });

  it("resets handled state before a re-entered non-root bootstrap", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      "TIRITH_RETRY_MARKER_CLEARED=0",
      'printf %s download_failed > "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isFile()).toBe(true);
    expect(run.markerContent).toBe("download_failed");
    expect(run.source).toMatch(
      /bootstrap_hermes_gateway_current_user\(\) \{\n  TIRITH_RETRY_MARKER_CLEARED=0/,
    );
  });
});
