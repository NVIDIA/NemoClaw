// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "langchain-deepagents-code",
  "start.sh",
);

// start.sh hardcodes this runtime-env path; clean it up so the test is hermetic.
const RUNTIME_ENV_FILE = "/tmp/nemoclaw-proxy-env.sh";
const tempDirs: string[] = [];

function makeStartFixture(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-keepalive-"));
  const scriptPath = path.join(tempDir, "start.sh");
  const hostFile = path.join(tempDir, "trusted-proxy-host");
  const portFile = path.join(tempDir, "trusted-proxy-port");
  const fixture = fs
    .readFileSync(START_SCRIPT, "utf8")
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${hostFile}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${portFile}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${process.getuid?.() ?? 0}`,
    );
  fs.writeFileSync(hostFile, "10.200.0.1\n");
  fs.writeFileSync(portFile, "3128\n");
  fs.chmodSync(hostFile, 0o444);
  fs.chmodSync(portFile, 0o444);
  fs.writeFileSync(scriptPath, fixture);
  fs.chmodSync(scriptPath, 0o755);
  tempDirs.push(tempDir);
  return scriptPath;
}

afterEach(() => {
  fs.rmSync(RUNTIME_ENV_FILE, { force: true });
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("Deep Agents Code sandbox entrypoint keep-alive (#5717)", () => {
  it("stays alive as a long-running process when invoked with no command", () => {
    // The terminal-runtime sandbox runs this entrypoint with no args as its
    // sole foreground process. It must NOT exit on its own — a self-exiting
    // entrypoint (e.g. a bare non-interactive /bin/bash) leaves the sandbox
    // with no persistent process, flapping it into OpenShell's Error phase and
    // breaking the Docker GPU-patch supervisor reconnect. Run with stdin closed
    // and a short timeout: a correct keep-alive is still running at the
    // deadline (killed by the timeout signal), not exited cleanly. Execute the
    // script directly (not via `bash`) so this also exercises the real ENTRYPOINT
    // contract — the image runs /usr/local/bin/nemoclaw-start directly, so a
    // broken shebang or execute bit would also be caught here.
    expect(fs.statSync(START_SCRIPT).mode & 0o111).not.toBe(0);
    const result = spawnSync(makeStartFixture(), [], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });

    // Killed by the timeout (still running) => signal set, status null.
    // A self-exiting entrypoint would return status 0 with no signal.
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    expect(result.stdout).toContain("Setting up NemoClaw Deep Agents Code runtime...");
  });

  it("execs an explicitly supplied command instead of idling", () => {
    const result = spawnSync(makeStartFixture(), ["printf", "RAN_CMD"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RAN_CMD");
  });
});
