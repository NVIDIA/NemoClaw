// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  getCurlTimingArgs,
  runCurlProbe,
  summarizeCurlFailure,
  summarizeProbeError,
  summarizeProbeFailure,
} from "./http-probe";

describe("http-probe helpers", () => {
  it("returns explicit curl timeouts", () => {
    expect(getCurlTimingArgs()).toEqual(["--connect-timeout", "10", "--max-time", "60"]);
  });

  it("summarizes curl failures from stderr or body", () => {
    expect(summarizeCurlFailure(28, "  timed out   while connecting  ")).toBe(
      "curl failed (exit 28): timed out while connecting",
    );
    expect(summarizeCurlFailure(7, "", " connection refused ")).toBe(
      "curl failed (exit 7): connection refused",
    );
  });

  it("summarizes JSON and text HTTP probe failures", () => {
    expect(summarizeProbeError('{"error":{"message":"bad key"}}', 401)).toBe(
      "HTTP 401: bad key",
    );
    expect(summarizeProbeError(" plain  text   body ", 500)).toBe("HTTP 500: plain text body");
    expect(summarizeProbeFailure("", 0, 28, "timeout")).toBe("curl failed (exit 28): timeout");
  });

  it("captures successful curl output and cleans up the temp file", () => {
    let outputPath = "";
    const result = runCurlProbe(["-sS", "https://example.test/models"], {
      spawnSyncImpl: (_command, args) => {
        outputPath = args[args.indexOf("-o") + 1];
        fs.writeFileSync(outputPath, JSON.stringify({ data: [{ id: "foo" }] }));
        return {
          pid: 1,
          output: [],
          stdout: "200",
          stderr: "",
          status: 0,
          signal: null,
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: '{"data":[{"id":"foo"}]}',
    });
    expect(outputPath).not.toBe("");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it("reports spawn errors as curl failures", () => {
    const result = runCurlProbe(["-sS", "https://example.test/models"], {
      spawnSyncImpl: () => {
        const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        return {
          pid: 1,
          output: [],
          stdout: "",
          stderr: "curl missing",
          status: null,
          signal: null,
          error,
        };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.curlStatus).toBe(1);
    expect(result.message).toContain("curl failed");
    expect(result.stderr).toContain("spawn ENOENT");
  });
});
