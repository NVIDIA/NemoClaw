// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { flushTrace, resetTraceForTests, TRACE_FILE_ENV, type TraceArtifact } from "../../trace";
import {
  getCurlTimingArgs,
  runChatCompletionsStreamingProbe,
  runCurlProbe,
  runStreamingEventProbe,
  summarizeCurlFailure,
  summarizeProbeError,
  summarizeProbeFailure,
} from "./probe";

function withTraceFile<T>(fn: (traceFile: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-probe-trace-test-"));
  const traceFile = path.join(tmpDir, "trace.json");
  process.env[TRACE_FILE_ENV] = traceFile;
  resetTraceForTests();
  return fn(traceFile);
}

afterEach(() => {
  delete process.env[TRACE_FILE_ENV];
  resetTraceForTests();
});

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
    expect(summarizeCurlFailure(28, "", "")).toBe("curl failed (exit 28)");
    expect(summarizeCurlFailure(0, "", "")).toBe("curl failed (exit 0)");
  });

  it("summarizes JSON and text HTTP probe failures", () => {
    expect(summarizeProbeError('{"error":{"message":"bad key"}}', 401)).toBe("HTTP 401: bad key");
    expect(
      summarizeProbeError('{"error":{"details":{"reason":"bad key","retry":false}}}', 401),
    ).toBe('HTTP 401: {"reason":"bad key","retry":false}');
    expect(summarizeProbeError(" plain  text   body ", 500)).toBe("HTTP 500: plain text body");
    expect(summarizeProbeFailure("", 0, 28, "timeout")).toBe("curl failed (exit 28): timeout");
    expect(summarizeProbeFailure("body", 500, 7, "Connection refused")).toBe(
      "curl failed (exit 7): Connection refused",
    );
    expect(summarizeProbeFailure("Not Found", 404, 0, "")).toBe("HTTP 404: Not Found");
    expect(summarizeProbeFailure("", 0, 0, "")).toBe("HTTP 0 with no response body");
    expect(summarizeProbeFailure("  Service  Unavailable  ", 503, 0, "")).toBe(
      "HTTP 503: Service Unavailable",
    );
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

  it("lets the process wrapper outlive curl --max-time", () => {
    let timeout: number | undefined;
    const result = runCurlProbe(["-sS", "--max-time", "60", "https://example.test/models"], {
      spawnSyncImpl: (_command, args, options) => {
        timeout = options.timeout;
        const outputPath = args[args.indexOf("-o") + 1];
        if (typeof outputPath === "string") {
          fs.writeFileSync(outputPath, "{}");
        }
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

    expect(result.ok).toBe(true);
    expect(timeout).toBe(65_000);
  });

  it("uses the last curl --max-time when the flag is repeated", () => {
    let timeout: number | undefined;
    runCurlProbe(
      ["-sS", "--max-time", "15", "--max-time", "120", "https://example.test/models"],
      {
        spawnSyncImpl: (_command, args, options) => {
          timeout = options.timeout;
          const outputPath = args[args.indexOf("-o") + 1];
          if (typeof outputPath === "string") {
            fs.writeFileSync(outputPath, "{}");
          }
          return {
            pid: 1,
            output: [],
            stdout: "200",
            stderr: "",
            status: 0,
            signal: null,
          };
        },
      },
    );

    expect(timeout).toBe(125_000);
  });

  it("honors an explicit process timeout over inferred curl --max-time", () => {
    let timeout: number | undefined;
    runCurlProbe(["-sS", "--max-time", "60", "https://example.test/models"], {
      timeoutMs: 12_345,
      spawnSyncImpl: (_command, args, options) => {
        timeout = options.timeout;
        const outputPath = args[args.indexOf("-o") + 1];
        if (typeof outputPath === "string") {
          fs.writeFileSync(outputPath, "{}");
        }
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

    expect(timeout).toBe(12_345);
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

  it("reports spawnSync ETIMEDOUT as a timeout status", () => {
    const result = runCurlProbe(["-sS", "https://example.test/models"], {
      spawnSyncImpl: () => {
        const error = Object.assign(new Error("spawnSync curl ETIMEDOUT"), {
          code: "ETIMEDOUT",
          errno: -60,
        });
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
    });

    expect(result.ok).toBe(false);
    expect(result.curlStatus).toBe(-110);
    expect(result.message).toContain("ETIMEDOUT");
  });

  it("rejects non-http probe URLs before spawning curl", () => {
    let spawned = false;
    const result = runCurlProbe(["-sS", "file:///etc/passwd"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("curl probe URL must use http or https");
  });

  it("rejects curl probe request bodies that read from local files", () => {
    let spawned = false;
    const result = runCurlProbe(["-sS", "--data-binary", "@/etc/passwd", "https://example.test/models"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("must not read request data from a file");
  });

  it.each([
    ["--upload-file", ["--upload-file", "/etc/passwd"]],
    ["-T", ["-T/etc/passwd"]],
    ["--netrc", ["--netrc"]],
    ["--data-urlencode", ["--data-urlencode", "payload@/etc/passwd"]],
    ["-K", ["-K/etc/passwd"]],
    ["-b", ["-b/etc/passwd"]],
    ["--cert", ["--cert", "/tmp/client.pem"]],
    ["--key", ["--key=/tmp/client.key"]],
    ["--proxy-cert", ["--proxy-cert", "/tmp/proxy.pem"]],
    ["--proxy-key", ["--proxy-key=/tmp/proxy.key"]],
  ])("rejects file-reading curl option %s before spawning", (_label, args) => {
    let spawned = false;
    const result = runCurlProbe(["-sS", ...args, "https://example.test/models"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["-H", ["-H", "@/etc/passwd"]],
    ["-H inline", ["-H@/etc/passwd"]],
    ["--header", ["--header=@/etc/passwd"]],
  ])("rejects file-backed curl header option %s before spawning", (_label, args) => {
    let spawned = false;
    const result = runCurlProbe(["-sS", ...args, "https://example.test/models"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("must not read headers from a file");
  });

  it("applies file-read validation to streaming probe wrappers", () => {
    let spawned = false;
    const spawnSyncImpl = () => {
      spawned = true;
      throw new Error("should not spawn");
    };

    const chat = runChatCompletionsStreamingProbe(
      ["-sS", "--header", "@/etc/passwd", "https://example.test/v1/chat/completions"],
      { spawnSyncImpl },
    );
    const responses = runStreamingEventProbe(
      ["-sS", "--cert", "/tmp/client.pem", "https://example.test/v1/responses"],
      { spawnSyncImpl },
    );

    expect(spawned).toBe(false);
    expect(chat.ok).toBe(false);
    expect(responses.ok).toBe(false);
  });

  it.each([
    ["extra URL", ["https://evil.example/steal"]],
    ["multi-transfer --next", ["--next"]],
  ])("rejects %s before spawning", (_label, args) => {
    let spawned = false;
    const result = runCurlProbe(["-sS", ...args, "https://example.test/models"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["--data", ["--data"]],
    ["-H", ["-H"]],
    ["--max-time", ["--max-time"]],
    ["--config", ["--config"]],
  ])("rejects missing value for curl option %s before spawning", (_label, args) => {
    let spawned = false;
    const result = runCurlProbe(["-sS", ...args, "https://example.test/models"], {
      spawnSyncImpl: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("allows explicit trusted curl config files", () => {
    const configPath = path.join(os.tmpdir(), "nemoclaw-trusted-curl.conf");
    let spawnedArgs: readonly string[] = [];
    const result = runCurlProbe(["-sS", "--config", configPath, "https://example.test/models"], {
      trustedConfigFiles: [configPath],
      spawnSyncImpl: (_command, args) => {
        spawnedArgs = args;
        const outputPath = args[args.indexOf("-o") + 1];
        if (typeof outputPath === "string") {
          fs.writeFileSync(outputPath, "{}");
        }
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

    expect(result.ok).toBe(true);
    expect(spawnedArgs).toContain(configPath);
  });
});

describe("runChatCompletionsStreamingProbe", () => {
  function mockStreaming(sseBody: string, exitCode = 0, stdout = "200", stderr = "") {
    return (_command: string, args: readonly string[]) => {
      const oIdx = args.indexOf("-o");
      if (oIdx !== -1) {
        const outputPath = args[oIdx + 1];
        if (typeof outputPath === "string") {
          fs.writeFileSync(outputPath, sseBody);
        }
      }
      return {
        pid: 1,
        output: [],
        stdout,
        stderr,
        status: exitCode,
        signal: null,
      };
    };
  }

  it("passes when chat-completions SSE data arrives before curl max-time", () => {
    const sseBody = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"OK"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = runChatCompletionsStreamingProbe(
      ["-sS", "--max-time", "120", "https://example.test/v1/chat/completions"],
      { spawnSyncImpl: mockStreaming(sseBody, 28) },
    );

    expect(result.ok).toBe(true);
    expect(result.curlStatus).toBe(28);
    expect(result.body).toContain("chatcmpl-1");
  });

  it("fails when the stream has no chat-completions SSE data", () => {
    const result = runChatCompletionsStreamingProbe(
      ["-sS", "--max-time", "120", "https://example.test/v1/chat/completions"],
      { spawnSyncImpl: mockStreaming("", 28, "000") },
    );

    expect(result.ok).toBe(false);
    expect(result.curlStatus).toBe(28);
  });

  it("reports chat streaming spawnSync ETIMEDOUT as a timeout status", () => {
    const result = runChatCompletionsStreamingProbe(
      ["-sS", "--max-time", "120", "https://example.test/v1/chat/completions"],
      {
        spawnSyncImpl: () => {
          const error = Object.assign(new Error("spawnSync curl ETIMEDOUT"), {
            code: "ETIMEDOUT",
            errno: -60,
          });
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
    expect(result.curlStatus).toBe(-110);
    expect(result.message).toContain("ETIMEDOUT");
  });

  it("does not treat a lone DONE frame as successful streaming data", () => {
    const result = runChatCompletionsStreamingProbe(
      ["-sS", "--max-time", "120", "https://example.test/v1/chat/completions"],
      { spawnSyncImpl: mockStreaming("data: [DONE]\n\n") },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not return SSE data");
  });

  it("records curl_result metadata for chat streaming probes", () => {
    withTraceFile((traceFile) => {
      const result = runChatCompletionsStreamingProbe(
        ["-sS", "--max-time", "120", "https://example.test/v1/chat/completions"],
        { spawnSyncImpl: mockStreaming("", 28, "200") },
      );

      expect(result.ok).toBe(false);
      flushTrace();
      const artifact = JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans.find(
        (entry) => entry.name === "nemoclaw.inference.curl_streaming_probe",
      );
      expect(span?.events[0].attributes).toMatchObject({
        ok: false,
        http_status: 200,
        curl_status: 28,
      });
    });
  });
});

describe("runStreamingEventProbe", () => {
  /** Helper to build a spawnSyncImpl that writes SSE content to the -o file. */
  function mockStreaming(sseBody: string, exitCode = 0) {
    return (_command: string, args: readonly string[]) => {
      const oIdx = args.indexOf("-o");
      if (oIdx !== -1) {
        const outputPath = args[oIdx + 1];
        if (typeof outputPath === "string") {
          fs.writeFileSync(outputPath, sseBody);
        }
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
    const result = runStreamingEventProbe(["-sS", "https://example.test/v1/responses"], {
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
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Streaming probe failed");
  });

  it("records normalized timeout status for responses streaming spawnSync ETIMEDOUT", () => {
    withTraceFile((traceFile) => {
      const result = runStreamingEventProbe(["-sS", "https://example.test/v1/responses"], {
        spawnSyncImpl: () => {
          const error = Object.assign(new Error("spawnSync curl ETIMEDOUT"), {
            code: "ETIMEDOUT",
            errno: -60,
          });
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
      });

      expect(result.ok).toBe(false);
      flushTrace();
      const artifact = JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans.find(
        (entry) => entry.name === "nemoclaw.inference.curl_streaming_event_probe",
      );
      expect(span?.events[0].attributes).toMatchObject({
        ok: false,
        curl_status: -110,
      });
    });
  });

  it("cleans up temp files after probe", () => {
    let outputPath = "";
    runStreamingEventProbe(["-sS", "--max-time", "15", "https://example.test/v1/responses"], {
      spawnSyncImpl: (_command, args) => {
        const oIdx = args.indexOf("-o");
        if (oIdx !== -1) {
          const nextArg = args[oIdx + 1];
          if (typeof nextArg === "string") {
            outputPath = nextArg;
            fs.writeFileSync(outputPath, "event: response.output_text.delta\ndata: {}\n");
          }
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
    });

    expect(outputPath).not.toBe("");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it("records curl_result metadata for responses streaming probes", () => {
    withTraceFile((traceFile) => {
      const result = runStreamingEventProbe(
        ["-sS", "--max-time", "15", "https://example.test/v1/responses"],
        { spawnSyncImpl: mockStreaming("event: response.created\ndata: {}\n") },
      );

      expect(result.ok).toBe(false);
      flushTrace();
      const artifact = JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans.find(
        (entry) => entry.name === "nemoclaw.inference.curl_streaming_event_probe",
      );
      expect(span?.events[0].attributes).toMatchObject({
        ok: false,
        missing_events_count: 1,
        curl_status: 0,
      });
    });
  });
});
