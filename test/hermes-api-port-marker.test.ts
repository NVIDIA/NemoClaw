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

function runHermesApiPortMarkerPublication(options: {
  publicPort: number;
  publishable?: boolean;
  staleMarkerPort?: number;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-port-marker-"));
  const runtimeParent = path.join(tmpDir, "run");
  if (options.publishable === false) {
    fs.writeFileSync(runtimeParent, "");
  } else {
    fs.mkdirSync(runtimeParent);
  }
  const runtimeDir = path.join(runtimeParent, "nemoclaw");
  const markerPath = path.join(runtimeDir, "hermes-api-port");
  if (options.staleMarkerPort !== undefined) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(markerPath, `${options.staleMarkerPort}\n`);
    fs.chmodSync(markerPath, 0o444);
  }

  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "HERMES_DEFAULT_API_PORT=8642",
      `HERMES_RUNTIME_DIR=${shellQuote(runtimeDir)}`,
      `HERMES_API_PORT_MARKER=${shellQuote(markerPath)}`,
      `PUBLIC_PORT=${options.publicPort}`,
      extractShellFunction(src, "publish_hermes_api_port_marker_current_user"),
      "publish_hermes_api_port_marker_current_user",
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8" });
  const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf-8").trim() : null;
  const mode = marker === null ? null : (fs.statSync(markerPath).mode & 0o777).toString(8);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return { result, marker, mode };
}

describe("agents/hermes/start.sh same-uid API port marker", () => {
  it("publishes the allocated port as a read-only marker (#8543)", () => {
    const run = runHermesApiPortMarkerPublication({ publicPort: 8645 });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.marker).toBe("8645");
    expect(run.mode).toBe("444");
  });

  it("replaces a read-only marker left by an earlier start (#8543)", () => {
    const run = runHermesApiPortMarkerPublication({ publicPort: 8645, staleMarkerPort: 8642 });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.marker).toBe("8645");
  });

  it("refuses to start when an allocated port cannot be published (#8543)", () => {
    const run = runHermesApiPortMarkerPublication({ publicPort: 8645, publishable: false });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("allocated API port 8645 could not be published");
    expect(run.marker).toBeNull();
  });

  it("starts on the default port when the marker cannot be published (#8543)", () => {
    const run = runHermesApiPortMarkerPublication({ publicPort: 8642, publishable: false });

    expect(run.result.status).toBe(0);
    expect(run.result.stderr).toContain("helpers fall back to port 8642");
    expect(run.marker).toBeNull();
  });
});
