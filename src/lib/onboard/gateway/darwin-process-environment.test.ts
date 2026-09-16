// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readDarwinGatewayProcessEnvironment } from "./darwin-process-environment";

describe.skipIf(process.platform !== "darwin")("macOS gateway environment boundary", () => {
  it("reads complete ownership values without arguments or unrelated credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-python-path-"));
    const marker = join(directory, "executed");
    writeFileSync(join(directory, "python3"), '#!/bin/sh\nprintf substituted > "$PROBE_MARKER"\n', {
      mode: 0o755,
    });
    const databaseUrl = "sqlite:/Users/Nvidia User/state/openshell.db";
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "OPENSHELL_DB_URL=sqlite:/spoofed"],
      {
        env: {
          OPENSHELL_DB_URL: databaseUrl,
          NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "selected-gateway",
          UNRELATED_CREDENTIAL: "test-only-secret",
        },
        stdio: "ignore",
      },
    );
    try {
      await once(child, "spawn");
      let output = "";
      const environment = readDarwinGatewayProcessEnvironment(child.pid!, (args) => {
        const result = spawnSync(args[0], args.slice(1), {
          env: { ...process.env, PATH: directory, PROBE_MARKER: marker },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 64 * 1024,
        });
        output = result.stdout;
        return { stdout: output, exitCode: result.status, timedOut: false };
      });
      expect(environment).toEqual({
        OPENSHELL_DB_URL: databaseUrl,
        NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "selected-gateway",
      });
      expect(output).not.toContain("test-only-secret");
      expect(output).not.toContain("spoofed");
      expect(existsSync(marker)).toBe(false);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
