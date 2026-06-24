// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

afterEach(() => {
  fs.rmSync(RUNTIME_ENV_FILE, { force: true });
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
    const result = spawnSync(START_SCRIPT, [], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });

    // Killed by the timeout (still running) => signal set, status null.
    // A self-exiting entrypoint would return status 0 with no signal.
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
  });

  it("execs an explicitly supplied command instead of idling", () => {
    const result = spawnSync(START_SCRIPT, ["printf", "RAN_CMD"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RAN_CMD");
  });
});
