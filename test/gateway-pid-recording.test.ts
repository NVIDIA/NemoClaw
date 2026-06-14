// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Producer-side coverage for the #4952 HEALTHCHECK fix: nemoclaw-start must
// record the live gateway PID in /tmp/nemoclaw-gateway.pid so the Docker
// HEALTHCHECK can confirm the actual gateway process is alive (not merely some
// process named `openclaw`) when the in-container curl probe cannot reach the
// dashboard port. The consumer side (the HEALTHCHECK reading this file) is
// covered in test/sandbox-provisioning.test.ts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

/** Slice a brace-balanced (no nested braces) shell function out of the source. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  const end = src.indexOf("\n}", start);
  if (end === -1) throw new Error(`Expected closing brace for ${name}`);
  return src.slice(start, end + 2);
}

describe("nemoclaw-start gateway PID recording for HEALTHCHECK (#4952)", () => {
  it("record_gateway_pid writes the gateway PID to the file the HEALTHCHECK reads", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-pid-"));
    try {
      const pidPath = path.join(tmp, "nemoclaw-gateway.pid");
      const fn = extractFunction(src, "record_gateway_pid").replaceAll(
        "/tmp/nemoclaw-gateway.pid",
        pidPath,
      );
      const script = ["set -euo pipefail", fn, 'record_gateway_pid "12345"'].join("\n");

      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(pidPath, "utf-8").trim()).toBe("12345");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never fails startup when the PID file cannot be written (best-effort)", () => {
    // The writer must swallow errors: a failed write must never abort the
    // entrypoint. Point it at an unwritable path and assert success.
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const fn = extractFunction(src, "record_gateway_pid").replaceAll(
      "/tmp/nemoclaw-gateway.pid",
      "/nonexistent-dir/nemoclaw-gateway.pid",
    );
    const script = ["set -euo pipefail", fn, 'record_gateway_pid "12345"'].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
  });
});
