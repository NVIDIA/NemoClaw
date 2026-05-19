// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in agents/hermes/start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function runTirithMarkerBootstrap(opts: {
  markerReason?: string;
  symlinkMarker?: boolean;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const marker = path.join(hermesHome, ".tirith-install-failed");
  const target = path.join(tmpDir, "marker-target");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  if (opts.symlinkMarker) {
    fs.writeFileSync(target, opts.markerReason ?? "download_failed");
    fs.symlinkSync(target, marker);
  } else if (opts.markerReason !== undefined) {
    fs.writeFileSync(marker, opts.markerReason);
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "retry_tirith_marker_if_needed"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      "retry_tirith_marker_if_needed",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      markerExists: fs.existsSync(marker),
      markerIsSymlink: fs.existsSync(marker) && fs.lstatSync(marker).isSymbolicLink(),
      markerContent: fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : "",
      targetContent: fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh Tirith marker bootstrap", () => {
  it("removes a retryable download_failed marker so Hermes runtime fallback can retry", () => {
    const run = runTirithMarkerBootstrap({ markerReason: "download_failed" });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(false);
    expect(run.result.stderr).toContain(
      "download_failed marker present; letting Hermes runtime fallback retry Tirith",
    );
  });

  it("leaves unknown marker reasons untouched", () => {
    const run = runTirithMarkerBootstrap({ markerReason: "checksum_failed" });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(true);
    expect(run.markerContent).toBe("checksum_failed");
    expect(run.result.stderr).toContain("is not retryable");
  });

  it("refuses to read or remove an unsafe symlink marker", () => {
    const run = runTirithMarkerBootstrap({
      markerReason: "download_failed",
      symlinkMarker: true,
    });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(true);
    expect(run.markerIsSymlink).toBe(true);
    expect(run.targetContent).toBe("download_failed");
    expect(run.result.stderr).toContain("unsafe Tirith install marker");
  });
});
