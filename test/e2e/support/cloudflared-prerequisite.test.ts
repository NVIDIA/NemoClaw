// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  readInferenceRoutingCloudflaredPin,
  resolveVerifiedCloudflaredBinary,
} from "../live/cloudflared-prerequisite.ts";

describe("inference-routing cloudflared prerequisite (#6141)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the reviewed version and digest from the exact workflow", () => {
    expect(readInferenceRoutingCloudflaredPin()).toEqual({
      version: "2026.6.1",
      debSha256: "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
    });
  });

  it("rejects a workflow without an immutable digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-pin-"));
    const workflow = path.join(root, "e2e.yaml");
    fs.writeFileSync(
      workflow,
      [
        "jobs:",
        "  inference-routing:",
        "    steps:",
        "      - name: Install and verify cloudflared prerequisite",
        "        env:",
        '          CLOUDFLARED_VERSION: "2026.6.1"',
        '          CLOUDFLARED_DEB_SHA256: "mutable"',
        "",
      ].join("\n"),
    );
    try {
      expect(() => readInferenceRoutingCloudflaredPin(workflow)).toThrow(
        "inference-routing cloudflared SHA256 pin is missing or invalid",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a PATH-injected binary and starts the verified package flow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-path-"));
    const injected = path.join(root, "cloudflared");
    fs.writeFileSync(injected, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    const command = vi.fn(async (name: string, args: string[]) => ({
      command: [name, ...args],
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "download blocked by test",
      artifacts: { stdout: "", stderr: "", result: "" },
    }));
    const cleanup = new CleanupRegistry();

    try {
      await expect(
        resolveVerifiedCloudflaredBinary(cleanup, { command } as unknown as HostCliClient, {
          platform: "linux",
          arch: "x64",
        }),
      ).rejects.toThrow("curl failed while preparing cloudflared");
      expect(command).toHaveBeenCalledTimes(1);
      expect(command.mock.calls[0]?.[0]).toBe("curl");
      expect(command.mock.calls.flat().join(" ")).not.toContain(injected);
    } finally {
      await cleanup.runAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
