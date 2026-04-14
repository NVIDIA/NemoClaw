// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  getCurlTimingArgs,
  runCurlProbe,
  runStreamingEventProbe,
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

describe("runStreamingEventProbe", () => {
  /** Helper to build a spawnSyncImpl that writes SSE content to the -o file. */
  function mockStreaming(sseBody: string, exitCode = 0) {
    return (_command: string, args: readonly string[]) => {
      const oIdx = args.indexOf("-o");
      if (oIdx !== -1) {
        const outputPath = args[oIdx + 1] as string;
        fs.writeFileSync(outputPath, sseBody);
      }
      return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status: exitCode,
        signal: null,
      };
    };
  }

  it("passes when all required streaming events are present", () => {
    const sseBody = [
      "event: response.created",
      'data: {"id":"resp_1"}',
      "",
      "event: response.in_progress",
      'data: {"id":"resp_1"}',
      "",
      "event: response.output_item.added",
      'data: {"id":"resp_1"}',
      "",
      "event: response.content_part.added",
      'data: {"id":"resp_1"}',
      "",
      "event: response.output_text.delta",
      'data: {"delta":"OK"}',
      "",
      "event: response.output_text.done",
      'data: {"text":"OK"}',
      "",
      "event: response.content_part.done",
      'data: {"id":"resp_1"}',
      "",
      "event: response.completed",
      'data: {"id":"resp_1"}',
      "",
    ].join("\n");

    const result = runStreamingEventProbe(
      ["-sS", "--max-time", "15", "https://example.test/v1/responses"],
      { spawnSyncImpl: mockStreaming(sseBody) },
    );

    expect(result.ok).toBe(true);
    expect(result.missingEvents).toEqual([]);
  });

  it("fails when only basic lifecycle events are present (SGLang-like)", () => {
    const sseBody = [
      "event: response.created",
      'data: {"id":"resp_1"}',
      "",
      "event: response.in_progress",
      'data: {"id":"resp_1"}',
      "",
      "event: response.completed",
      'data: {"id":"resp_1","text":"OK"}',
      "",
    ].join("\n");

    const result = runStreamingEventProbe(
      ["-sS", "--max-time", "15", "https://example.test/v1/responses"],
      { spawnSyncImpl: mockStreaming(sseBody) },
    );

    expect(result.ok).toBe(false);
    expect(result.missingEvents).toContain("response.output_text.delta");
    expect(result.message).toContain("response.output_text.delta");
  });

  it("still passes if curl exits with 28 (timeout) but events were captured", () => {
    const sseBody = [
      "event: response.created",
      'data: {"id":"resp_1"}',
      "",
      "event: response.output_text.delta",
      'data: {"delta":"O"}',
      "",
    ].join("\n");

    const result = runStreamingEventProbe(
      ["-sS", "--max-time", "15", "https://example.test/v1/responses"],
      { spawnSyncImpl: mockStreaming(sseBody, 28) },
    );

    expect(result.ok).toBe(true);
    expect(result.missingEvents).toEqual([]);
  });

  it("fails on spawn error", () => {
    const result = runStreamingEventProbe(
      ["-sS", "https://example.test/v1/responses"],
      {
        spawnSyncImpl: () => {
          const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
          return {
            pid: 1,
            output: [],
            stdout: "",
            stderr: "",
            status: null,
            signal: null,
            error,
          };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Streaming probe failed");
  });

  it("cleans up temp files after probe", () => {
    let outputPath = "";
    runStreamingEventProbe(
      ["-sS", "--max-time", "15", "https://example.test/v1/responses"],
      {
        spawnSyncImpl: (_command, args) => {
          const oIdx = args.indexOf("-o");
          if (oIdx !== -1) {
            outputPath = args[oIdx + 1] as string;
            fs.writeFileSync(outputPath, "event: response.output_text.delta\ndata: {}\n");
          }
          return {
            pid: 1,
            output: [],
            stdout: "",
            stderr: "",
            status: 0,
            signal: null,
          };
        },
      },
    );

    expect(outputPath).not.toBe("");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });
});
