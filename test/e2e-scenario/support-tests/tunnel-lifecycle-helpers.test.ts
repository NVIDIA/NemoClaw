// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyCloudflaredLog,
  getCloudflaredLogPath,
  publicTunnelProbeCurlArgs,
} from "../live/tunnel-lifecycle-helpers.ts";

describe("tunnel lifecycle cloudflared log attribution", () => {
  it("does not follow redirects from the public trycloudflare probe", () => {
    expect(publicTunnelProbeCurlArgs("https://current.trycloudflare.com/")).toEqual([
      "-sS",
      "--max-time",
      "30",
      "-w",
      "\n__HTTP_CODE:%{http_code}\n",
      "https://current.trycloudflare.com/",
    ]);
  });

  it("does not attribute an unrelated newer cloudflared log to the current sandbox", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const unrelatedDir = path.join(logRoot, "nemoclaw-services-other-sandbox");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(unrelatedDir, "cloudflared.log"),
      "https://unrelated.trycloudflare.com captured by another run\n",
    );

    try {
      expect(getCloudflaredLogPath(logRoot, "e2e-tunnel-lifecycle-current")).toBeUndefined();
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_no_spawn",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies only the sandbox-specific cloudflared log", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    const sandboxLog = path.join(sandboxDir, "cloudflared.log");
    fs.writeFileSync(sandboxLog, "https://current.trycloudflare.com\n");

    try {
      expect(getCloudflaredLogPath(logRoot, "e2e-tunnel-lifecycle-current")).toBe(sandboxLog);
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_capture_bug",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies localhost/origin-refused logs as a NemoClaw local-origin fault", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "cloudflared.log"),
      'ERR Request failed error="Unable to reach the origin service. dial tcp 127.0.0.1:18789: connect: connection refused"\n',
    );

    try {
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe(
        "nemoclaw_local",
      );
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies representative quick-tunnel registration failures as Cloudflare faults", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lifecycle-logs-"));
    const sandboxDir = path.join(logRoot, "nemoclaw-services-e2e-tunnel-lifecycle-current");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "cloudflared.log"),
      "ERR failed to unmarshal quick Tunnel response: tunnel server returned 503 bad gateway\n",
    );

    try {
      expect(classifyCloudflaredLog(logRoot, "e2e-tunnel-lifecycle-current")).toBe("cloudflare");
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });
});
