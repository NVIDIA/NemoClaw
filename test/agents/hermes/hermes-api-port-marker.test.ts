// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

interface MarkerSetup {
  shellPrelude: string[];
  targetPath: string | null;
}

type MarkerSetupFn = (
  runtimeParent: string,
  runtimeDir: string,
  markerPath: string,
  targetPath: string,
) => MarkerSetup;

const trustedRuntimePrelude = ['stat() { printf "%s\\n" "0:0:755"; }', "chown() { return 0; }"];

function setupWritableRuntime(
  _runtimeParent: string,
  runtimeDir: string,
  _markerPath: string,
  _targetPath: string,
): MarkerSetup {
  fs.mkdirSync(runtimeDir, { recursive: true });
  return { shellPrelude: trustedRuntimePrelude, targetPath: null };
}

function setupUntrustedRuntime(
  _runtimeParent: string,
  runtimeDir: string,
  _markerPath: string,
  _targetPath: string,
): MarkerSetup {
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    shellPrelude: ['stat() { printf "%s\\n" "1000:1000:755"; }', "chown() { return 0; }"],
    targetPath: null,
  };
}

function setupStaleMarker(
  _runtimeParent: string,
  runtimeDir: string,
  markerPath: string,
  _targetPath: string,
): MarkerSetup {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(markerPath, "8642\n");
  fs.chmodSync(markerPath, 0o444);
  return { shellPrelude: trustedRuntimePrelude, targetPath: null };
}

function setupMarkerSymlink(
  _runtimeParent: string,
  runtimeDir: string,
  markerPath: string,
  targetPath: string,
): MarkerSetup {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetPath, "attacker-target\n");
  fs.symlinkSync(targetPath, markerPath);
  return { shellPrelude: trustedRuntimePrelude, targetPath };
}

function setupBlockedRuntime(
  runtimeParent: string,
  _runtimeDir: string,
  _markerPath: string,
  _targetPath: string,
): MarkerSetup {
  fs.writeFileSync(runtimeParent, "");
  return { shellPrelude: trustedRuntimePrelude, targetPath: null };
}

function setupPublicationFailure(
  _runtimeParent: string,
  runtimeDir: string,
  markerPath: string,
  _targetPath: string,
): MarkerSetup {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(markerPath, "8643\n");
  fs.chmodSync(markerPath, 0o444);
  return {
    shellPrelude: [...trustedRuntimePrelude, "mktemp() { return 1; }"],
    targetPath: null,
  };
}

function runHermesApiPortMarkerPublication(publicPort: number, setup: MarkerSetupFn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-port-marker-"));
  try {
    const runtimeParent = path.join(tmpDir, "run");
    const runtimeDir = path.join(runtimeParent, "nemoclaw");
    const markerPath = path.join(runtimeDir, "hermes-api-port");
    const targetPath = path.join(tmpDir, "attacker-target");
    const fixture = setup(runtimeParent, runtimeDir, markerPath, targetPath);

    const scriptPath = path.join(tmpDir, "run.sh");
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        "HERMES_DEFAULT_API_PORT=8642",
        "HERMES_API_PORT_RANGE_END=8652",
        `HERMES_RUNTIME_DIR=${shellQuote(runtimeDir)}`,
        `HERMES_API_PORT_MARKER=${shellQuote(markerPath)}`,
        `PUBLIC_PORT=${publicPort}`,
        ...fixture.shellPrelude,
        extractShellFunction(src, "prepare_hermes_root_runtime_dir"),
        extractShellFunction(src, "publish_hermes_root_runtime_marker"),
        'publish_hermes_root_runtime_marker hermes-api-port "$PUBLIC_PORT"',
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8" });
    const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf-8").trim() : null;
    const mode = marker === null ? null : (fs.statSync(markerPath).mode & 0o777).toString(8);
    const target =
      fixture.targetPath === null ? null : fs.readFileSync(fixture.targetPath, "utf-8").trim();
    return { result, marker, mode, target };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh root-owned API port marker", () => {
  it("publishes the allocated port atomically with its final mode (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8645, setupWritableRuntime);

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.marker).toBe("8645");
    expect(run.mode).toBe("444");
  });

  it("atomically replaces a read-only marker left by an earlier start (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8645, setupStaleMarker);

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.marker).toBe("8645");
  });

  it("replaces a planted marker symlink without writing through it (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8645, setupMarkerSymlink);

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.marker).toBe("8645");
    expect(run.target).toBe("attacker-target");
  });

  it("refuses a runtime directory outside the root-owned trust boundary (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8645, setupUntrustedRuntime);

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("must be root-owned with mode 0755");
    expect(run.marker).toBeNull();
  });

  it("refuses a runtime path that cannot become a trusted directory (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8645, setupBlockedRuntime);

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("could not be created safely");
    expect(run.marker).toBeNull();
  });

  it("fails closed without replacing a stale marker after publication failure (#8543)", () => {
    const run = runHermesApiPortMarkerPublication(8642, setupPublicationFailure);

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("could not be prepared");
    expect(run.marker).toBe("8643");
  });
});
