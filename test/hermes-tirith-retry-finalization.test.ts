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
const FINALIZER = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "finalize-tirith-marker.py",
);

function readRegularFileNoFollow(filePath: string) {
  try {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const openedKind = fs.fstatSync(fd);
      return openedKind.isFile() ? fs.readFileSync(fd, "utf-8") : "";
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    return ["ENOENT", "ELOOP", "EISDIR"].includes(code)
      ? ""
      : (() => {
          throw error;
        })();
  }
}

function runTirithFinalizer(commands: readonly string[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-finalize-"));
  try {
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
        extractShellFunction(source, "prepare_tirith_marker_retry"),
        extractShellFunction(source, "prepare_hermes_root_runtime"),
        extractShellFunction(source, "finalize_tirith_marker_retry"),
        `HERMES_DIR=${shellQuote(hermesHome)}`,
        `MARKER=${shellQuote(marker)}`,
        `TARGET=${shellQuote(target)}`,
        `_HERMES_PYTHON=${shellQuote(process.env.PYTHON || "python3")}`,
        `_HERMES_TIRITH_MARKER_FINALIZER=${shellQuote(FINALIZER)}`,
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
    const markerContent = readRegularFileNoFollow(marker);
    const targetContent = readRegularFileNoFollow(target);
    return { markerContent, markerKind, result, source, targetContent };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh Tirith retry finalization", () => {
  it("returns FAILED without a traceback when the marker parent is missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tirith-missing-parent-"));
    try {
      const marker = path.join(tmpDir, "missing", ".tirith-install-failed");
      const result = spawnSync(process.env.PYTHON || "python3", ["-I", FINALIZER, marker], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(result.status).toBe(12);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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

  it("resets handled state before a re-entered retry preparation", () => {
    const run = runTirithFinalizer([
      "retry_tirith_marker_if_needed",
      "prepare_tirith_marker_retry",
      'printf %s download_failed > "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isFile()).toBe(true);
    expect(run.markerContent).toBe("download_failed");
  });

  it("runs reset-aware retry preparation in the root startup path", () => {
    const run = runTirithFinalizer([
      "verify_hermes_config_integrity() { :; }",
      "ensure_hermes_config_root_mode() { :; }",
      "ensure_hermes_runtime_api_server_key() { :; }",
      "apply_shields_up_runtime_env() { :; }",
      "validate_hermes_env_secret_boundary() { :; }",
      "validate_hermes_runtime_env_secret_boundary() { :; }",
      "refresh_hermes_provider_placeholders() { :; }",
      "configure_messaging_channels() { :; }",
      "TIRITH_RETRY_MARKER_CLEARED=1",
      'rm -f "$MARKER"',
      "prepare_hermes_root_runtime",
      'printf %s download_failed > "$MARKER"',
      "finalize_tirith_marker_retry",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.markerKind?.isFile()).toBe(true);
    expect(run.markerContent).toBe("download_failed");
  });

  it("preserves a marker replaced by a symlink before descriptor revalidation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tirith-race-"));
    try {
      const marker = path.join(tmpDir, "marker");
      const target = path.join(tmpDir, "target");
      fs.writeFileSync(marker, "download_failed");
      fs.writeFileSync(target, "sensitive-target");
      const result = spawnSync(
        process.env.PYTHON || "python3",
        [
          "-I",
          "-c",
          `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("tirith_finalizer", ${JSON.stringify(FINALIZER)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
marker = Path(${JSON.stringify(marker)})
target = Path(${JSON.stringify(target)})
def replace_marker():
    marker.unlink()
    marker.symlink_to(target)
print(module.finalize_marker(marker, replace_marker))
`,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("11");
      expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf-8")).toBe("sensitive-target");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
