// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawOnboardDiagnosticsCommand,
  captureOpenClawOnboardFailure,
} from "../fixtures/openclaw-onboard-diagnostics.ts";
import { redactString } from "../fixtures/redaction.ts";

const options = {
  sandboxName: "diagnostic-sandbox",
  artifactPrefix: "onboard",
  env: {
    OPENSHELL_GATEWAY: "recorded",
    OPENSHELL_WORKSPACE: "/isolated",
    OPENSHELL_LOCAL_TLS_DIR: "/tls",
  },
  redactionValues: ["fixture-secret"],
};

function clients() {
  return {
    openshell: vi.fn().mockResolvedValue({}),
    exec: vi.fn().mockResolvedValue({}),
  };
}

describe("OpenClaw onboarding failure diagnostics", () => {
  it("does not probe a successful installation", async () => {
    const sandbox = clients();
    await captureOpenClawOnboardFailure({ exitCode: 0 }, sandbox, options);
    expect(sandbox.openshell).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("bounds all commands and preserves the runtime environment and redaction values", async () => {
    const sandbox = clients();
    await captureOpenClawOnboardFailure({ exitCode: 1 }, sandbox, options);
    expect(sandbox.openshell).toHaveBeenCalledWith(
      ["sandbox", "get", options.sandboxName],
      expect.objectContaining({
        env: options.env,
        redactionValues: options.redactionValues,
        timeoutMs: 15000,
        killGraceMs: 1000,
        captureLimitBytes: 65536,
      }),
    );
    expect(sandbox.openshell).toHaveBeenCalledWith(
      ["logs", options.sandboxName, "-n", "120", "--source", "all"],
      expect.objectContaining({ env: options.env, timeoutMs: 15000 }),
    );
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    const bounded = expect.objectContaining({
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 15000,
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      1,
      options.sandboxName,
      expect.any(Array),
      bounded,
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      2,
      options.sandboxName,
      expect.any(Array),
      bounded,
    );
  });

  it("continues other captures when a probe throws or rejects", async () => {
    const sandbox = clients();
    sandbox.openshell.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    sandbox.exec.mockRejectedValue(new Error("sandbox unavailable"));
    await expect(
      captureOpenClawOnboardFailure({ exitCode: null }, sandbox, options),
    ).resolves.toBeUndefined();
    expect(sandbox.openshell).toHaveBeenCalledTimes(2);
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it("redacts JSON-escaped quotes, backslashes and newlines from log output", async () => {
    const sandbox = clients();
    const secret = 'short"value\\with\na-newline';
    await captureOpenClawOnboardFailure({ exitCode: 1 }, sandbox, {
      ...options,
      redactionValues: [secret],
    });
    const redactions = sandbox.exec.mock.calls[0][2].redactionValues;
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(redactions).toEqual([secret, escaped]);
    expect(redactString(JSON.stringify({ log: secret }), redactions)).not.toContain(escaped);
    expect(redactString(secret, redactions)).not.toContain(secret);
  });

  it("caps log reads, rejects links, and sends captured secrets through fixture redaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "onboard-diagnostics-"));
    try {
      const log = join(directory, "startup.log");
      const secret = join(directory, "credentials");
      const symlink = join(directory, "symlink.log");
      const hardlink = join(directory, "hardlink.log");
      writeFileSync(log, "x".repeat(20000) + "\nAuthorization: Bearer fixture-secret\n");
      writeFileSync(secret, "must-not-read-linked-credentials");
      symlinkSync(secret, symlink);
      linkSync(secret, hardlink);
      const [command, ...args] = buildOpenClawOnboardDiagnosticsCommand([
        log,
        symlink,
        hardlink,
        join(directory, "absent"),
      ]);
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      expect(result.status).toBe(0);
      const records = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(Buffer.byteLength(records[0].log)).toBe(16384);
      expect(records[0].truncated).toBe(true);
      expect(records.slice(1, 4).map((record) => record.readable)).toEqual([false, false, false]);
      expect(result.stdout).not.toContain("must-not-read-linked-credentials");
      expect(redactString(result.stdout, options.redactionValues)).not.toContain("fixture-secret");
      expect(records.slice(4).every((record) => !("log" in record))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
