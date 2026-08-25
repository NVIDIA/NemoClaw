// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WRAPPER = path.join(import.meta.dirname, "../../..", "agents", "hermes", "hermes-wrapper.py");
const ADAPTER = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "hermes-cli-adapter-v1.json",
);
const PYTHON_AVAILABLE = spawnSync("python3", ["--version"], { timeout: 5_000 }).status === 0;
const GENERATED_KEY = "a".repeat(64);

let tmpDir: string;

function runDashboard(sourcePath: string) {
  const wrapperPath = path.join(tmpDir, "hermes");
  const capturePath = path.join(tmpDir, "captured-key");
  const argvPath = path.join(tmpDir, "captured-argv");
  const markerPath = path.join(tmpDir, "real-invoked");
  fs.copyFileSync(WRAPPER, wrapperPath);
  fs.copyFileSync(ADAPTER, path.join(tmpDir, "hermes-cli-adapter-v1.json"));
  fs.writeFileSync(
    path.join(tmpDir, "hermes.real"),
    [
      "#!/usr/bin/env bash",
      'test -z "${NEMOCLAW_HERMES_DASHBOARD_API_SERVER_ENV:-}" || exit 9',
      'printf "%s" "${API_SERVER_KEY:-}" > "${CAPTURE_PATH}"',
      'printf "%s\\n" "$@" > "${ARGV_PATH}"',
      'touch "${MARKER_PATH}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync("python3", ["-I", wrapperPath, "dashboard", "--no-open"], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmpDir,
      CAPTURE_PATH: capturePath,
      ARGV_PATH: argvPath,
      MARKER_PATH: markerPath,
      NEMOCLAW_HERMES_DASHBOARD_API_SERVER_ENV: sourcePath,
    },
  });
  return { result, capturePath, argvPath, markerPath };
}

describe.skipIf(!PYTHON_AVAILABLE)("Hermes dashboard credential launch", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-credential-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supplies API_SERVER_KEY through process environment without copying it into argv or output (#8008)", () => {
    const sourcePath = path.join(tmpDir, "gateway.env");
    fs.writeFileSync(sourcePath, `export API_SERVER_KEY='${GENERATED_KEY}'\n`);

    const { result, capturePath, argvPath, markerPath } = runDashboard(sourcePath);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(capturePath, "utf8")).toBe(GENERATED_KEY);
    expect(fs.readFileSync(argvPath, "utf8")).toBe("dashboard\n--no-open\n");
    expect(result.stdout).not.toContain(GENERATED_KEY);
    expect(result.stderr).not.toContain(GENERATED_KEY);
  });

  it("preserves upstream optional authentication for a direct unmanaged dashboard launch", () => {
    const { result, capturePath, markerPath } = runDashboard("");

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(capturePath, "utf8")).toBe("");
  });

  it.each([
    ["weak", "API_SERVER_KEY=weak\n"],
    ["duplicate", `API_SERVER_KEY=${GENERATED_KEY}\nAPI_SERVER_KEY=${"b".repeat(64)}\n`],
  ])("refuses a %s API server credential source without launching Hermes (#8008)", (_label, source) => {
    const sourcePath = path.join(tmpDir, "gateway.env");
    fs.writeFileSync(sourcePath, source);

    const { result, markerPath } = runDashboard(sourcePath);

    expect(result.status).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.stderr).toContain("[SECURITY]");
    expect(result.stderr).not.toContain("weak");
    expect(result.stderr).not.toContain(GENERATED_KEY);
  });

  it("refuses a symlinked API server credential source without launching Hermes (#8008)", () => {
    const realPath = path.join(tmpDir, "real-gateway.env");
    const sourcePath = path.join(tmpDir, "gateway.env");
    fs.writeFileSync(realPath, `API_SERVER_KEY=${GENERATED_KEY}\n`);
    fs.symlinkSync(realPath, sourcePath);

    const { result, markerPath } = runDashboard(sourcePath);

    expect(result.status).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.stderr).toContain("[SECURITY]");
    expect(result.stderr).not.toContain(GENERATED_KEY);
  });
});
