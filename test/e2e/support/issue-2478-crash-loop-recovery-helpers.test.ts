// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProxyEnvRestoreInvocation,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
} from "../live/issue-2478-crash-loop-recovery-helpers.ts";

describe("issue-2478 crash-loop recovery helpers", () => {
  it("restores a large proxy environment byte-for-byte below the OpenShell argument limit", () => {
    const proxyEnv = [
      "#!/bin/sh",
      "export NEMOCLAW_PROXY_ENV_MARKER='round trip value'",
      `# ${"x".repeat(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES * 2)}`,
      "",
    ].join("\n");
    const encodedProxyEnv = Buffer.from(proxyEnv, "utf8").toString("base64");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue-2478-"));
    const targetPath = path.join(tempDir, "nemoclaw-proxy-env.sh");

    try {
      const invocation = buildProxyEnvRestoreInvocation(encodedProxyEnv, targetPath);
      expect(invocation.length).toBeGreaterThan(8);
      expect(
        Math.max(...invocation.map((argument) => Buffer.byteLength(argument, "utf8"))),
      ).toBeLessThan(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES);
      expect(invocation.filter((argument) => /[\r\n]/u.test(argument))).toEqual([]);

      const [command, ...args] = invocation;
      const result = spawnSync(command, args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(Number(result.stdout.trim())).toBe(Buffer.byteLength(proxyEnv, "utf8"));
      expect(fs.readFileSync(targetPath, "utf8")).toBe(proxyEnv);
      expect(fs.statSync(targetPath).mode & 0o777).toBe(0o444);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
