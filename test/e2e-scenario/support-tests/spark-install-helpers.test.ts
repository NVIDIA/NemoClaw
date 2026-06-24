// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRequiredInstallerEnv,
  assertSparkInstallSandboxName,
  buildInstallerInvocation,
  DEFAULT_INSTALL_URL,
  exitDetail,
  writeRedactedInstallLog,
} from "../live/spark-install-helpers.ts";

const SENTINEL = "sentinel-nvidia-api-key";
const RESULT_WITH_SECRET = {
  stdout: `install stdout ${SENTINEL}`,
  stderr: `install stderr ${SENTINEL}`,
};

describe("spark install live test helpers", () => {
  it("writes and reports only redacted install logs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-install-helpers-"));
    const installLog = path.join(tmp, "install.log");

    try {
      writeRedactedInstallLog(installLog, RESULT_WITH_SECRET, [SENTINEL]);
      const log = fs.readFileSync(installLog, "utf8");
      const detail = exitDetail(RESULT_WITH_SECRET, installLog, [SENTINEL]);

      expect(log).toContain("[REDACTED]");
      expect(log).not.toContain(SENTINEL);
      expect(detail).toContain("[REDACTED]");
      expect(detail).not.toContain(SENTINEL);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects public installer URL overrides outside the documented origin", () => {
    const unsafeUrls = [
      "http://www.nvidia.com/nemoclaw.sh",
      "file:///tmp/nemoclaw.sh",
      "https://user:pass@www.nvidia.com/nemoclaw.sh",
      "https://localhost/nemoclaw.sh",
      "https://127.0.0.1/nemoclaw.sh",
      "https://10.0.0.1/nemoclaw.sh",
      "https://example.com/nemoclaw.sh",
      "https://www.nvidia.com/other.sh",
      "https://www.nvidia.com/nemoclaw.sh?token=leak",
    ];

    for (const installUrl of unsafeUrls) {
      expect(() =>
        buildInstallerInvocation({
          repoRoot: "/repo",
          env: {
            NEMOCLAW_E2E_PUBLIC_INSTALL: "1",
            NEMOCLAW_INSTALL_SCRIPT_URL: installUrl,
          },
        }),
      ).toThrow();
    }
  });

  it("defaults public curl-pipe mode to the allowlisted installer URL", () => {
    const invocation = buildInstallerInvocation({
      repoRoot: "/repo",
      env: { NEMOCLAW_E2E_PUBLIC_INSTALL: "1" },
    });

    expect(invocation.mode).toBe("public");
    expect(invocation.installUrl).toBe(DEFAULT_INSTALL_URL);
    expect(invocation.script).toContain(`curl -fsSL '${DEFAULT_INSTALL_URL}'`);
  });

  it("keeps public curl-pipe mode on the allowlisted installer and enables pipefail", () => {
    const invocation = buildInstallerInvocation({
      repoRoot: "/repo",
      env: {
        NEMOCLAW_E2E_PUBLIC_INSTALL: "1",
        NEMOCLAW_INSTALL_SCRIPT_URL: DEFAULT_INSTALL_URL,
      },
    });

    expect(invocation.mode).toBe("public");
    expect(invocation.installUrl).toBe(DEFAULT_INSTALL_URL);
    expect(invocation.script).toContain("set -euo pipefail && curl -fsSL");
    expect(invocation.script).toContain("| NEMOCLAW_NON_INTERACTIVE=1");
  });

  it("rejects non-test-owned sandbox names before destructive cleanup can use them", () => {
    expect(assertSparkInstallSandboxName("e2e-spark-install-vitest")).toBe(
      "e2e-spark-install-vitest",
    );
    expect(assertSparkInstallSandboxName("e2e-spark-install-local-1")).toBe(
      "e2e-spark-install-local-1",
    );
    expect(() => assertSparkInstallSandboxName("personal-dev")).toThrow(/e2e-spark-install-/);
    expect(() => assertSparkInstallSandboxName("bad name")).toThrow(/sandbox name is invalid/);
  });

  it("requires the real non-interactive installer environment", () => {
    expect(() =>
      assertRequiredInstallerEnv({
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      }),
    ).not.toThrow();
    expect(() => assertRequiredInstallerEnv({ NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" })).toThrow(
      /NEMOCLAW_NON_INTERACTIVE=1/,
    );
    expect(() => assertRequiredInstallerEnv({ NEMOCLAW_NON_INTERACTIVE: "1" })).toThrow(
      /NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1/,
    );
  });
});
