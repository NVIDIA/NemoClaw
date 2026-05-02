// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for issue #2376:
 *   Hermes Agent crashes on every keypress because HERMES_HOME is unset
 *   in interactive sandbox shells, so proxy settings and Hermes runtime
 *   configuration from /tmp/nemoclaw-proxy-env.sh are missing.
 *
 * Root cause:
 *   The OpenClaw base image (Dockerfile.base) pre-creates /sandbox/.bashrc
 *   and /sandbox/.profile that source /tmp/nemoclaw-proxy-env.sh — the file
 *   the entrypoint writes with HERMES_HOME (and proxy vars) at runtime.
 *   The Hermes base image (agents/hermes/Dockerfile.base) was missing the
 *   equivalent block, so the proxy-env file existed but was never sourced.
 *
 *   The regression slipped in via #2297 which moved the proxy/HERMES_HOME
 *   exports out of an inline .bashrc append into the standalone proxy-env
 *   file — without realising the Hermes base image had no .bashrc to source it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runRcFile(
  rcFileName: ".bashrc" | ".profile",
  proxyEnvContents?: string,
  command = `printf '%s' "\${HERMES_HOME:-}"`,
): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nc-2376-"));
  try {
    const childEnv = { ...process.env };
    delete childEnv.HERMES_HOME;

    const proxyEnv = path.join(tmp, "nemoclaw-proxy-env.sh");
    const rcFile = path.join(tmp, rcFileName);

    if (proxyEnvContents !== undefined) {
      fs.writeFileSync(proxyEnv, proxyEnvContents);
    }
    fs.writeFileSync(
      rcFile,
      [
        `[ -f ${proxyEnv} ] && . ${proxyEnv}`,
        'export PATH="/usr/local/bin:/opt/hermes/.venv/bin:${PATH}"',
        "",
      ].join("\n"),
    );

    return execFileSync("bash", ["-c", `. "${rcFile}"; ${command}`], {
      encoding: "utf-8",
      env: childEnv,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Issue #2376: Hermes rc files source HERMES_HOME from proxy-env", () => {
  for (const rcFileName of [".bashrc", ".profile"] as const) {
    it(`${rcFileName} exports HERMES_HOME when proxy-env exists`, () => {
      const out = runRcFile(rcFileName, "export HERMES_HOME=/sandbox/.hermes\n");
      expect(out).toBe("/sandbox/.hermes");
    });

    it(`${rcFileName} prepends Hermes command directories to PATH`, () => {
      const out = runRcFile(rcFileName, undefined, `printf '%s' "$PATH"`);
      expect(out.split(":").slice(0, 2)).toEqual(["/usr/local/bin", "/opt/hermes/.venv/bin"]);
    });
  }

  it("rc sourcing is a no-op when proxy-env is absent", () => {
    const out = runRcFile(".bashrc");
    expect(out).toBe("");
  });
});
