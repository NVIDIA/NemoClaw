// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { buildOpenshellExecArgs, wrapOpenClawAgentCommandWithRuntimeEnv } from "../exec";
import { runAgentJsonPassthrough } from "./passthrough-json";

describe("runAgentJsonPassthrough", () => {
  function makeProc() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    return {
      exit,
      proc: {
        exit: exit as unknown as (code: number) => never,
        stdout: { write: (value: string) => stdout.push(value) },
        stderr: { write: (value: string) => stderr.push(value) },
      },
      stderr,
      stdout,
    };
  }

  it("preserves OpenClaw JSON stdout and appends failed-tool provenance to stderr", () => {
    const payload = JSON.stringify({
      result: {
        messages: [
          {
            role: "toolResult",
            type: "toolResult",
            toolName: "exec",
            toolCallId: "call_missing",
            isError: true,
            text: "exec failed: node-not-real: not found",
          },
        ],
        payloads: [{ text: "Saved successfully." }],
      },
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "openclaw warning\n",
      pid: 123,
      output: [null, payload, "openclaw warning\n"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        spawnSync,
      }),
    ).toThrow("__exit:0");

    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      buildOpenshellExecArgs(
        "alpha",
        wrapOpenClawAgentCommandWithRuntimeEnv(["openclaw", "agent", "--json"]),
        { tty: false },
      ),
      expect.objectContaining({
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["inherit", "pipe", "pipe"],
      }),
    );
    expect(stdout.join("")).toBe(payload);
    expect(() => JSON.parse(stdout.join(""))).not.toThrow();
    expect(stderr.join("")).toContain("openclaw warning");
    expect(stderr.join("")).toContain("[openclaw provenance] failed tool result");
    expect(stderr.join("")).toContain("node-not-real");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("surfaces spawn errors and exits with the computed transport failure code", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync openshell ENOENT"),
      pid: 0,
      output: [null, "", ""],
    }));
    const { exit, proc, stderr } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        stdinIsTty: () => false,
        spawnSync,
      }),
    ).toThrow("__exit:1");

    expect(stderr.join("")).toContain("Failed to invoke openshell");
    expect(stderr.join("")).toContain("spawnSync openshell ENOENT");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not treat stderr JSON diagnostics as agent provenance", () => {
    const stdoutPayload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const stderrPayload = JSON.stringify({
      messages: [
        {
          role: "toolResult",
          type: "toolResult",
          toolName: "stderr-diagnostic",
          toolCallId: "call_stderr",
          isError: true,
          text: "this was not part of stdout JSON",
        },
      ],
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: stdoutPayload,
      stderr: stderrPayload,
      pid: 123,
      output: [null, stdoutPayload, stderrPayload],
    }));
    const { proc, stderr } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        spawnSync,
      }),
    ).toThrow("__exit:0");

    expect(stderr.join("")).toContain("stderr-diagnostic");
    expect(stderr.join("")).not.toContain("[openclaw provenance]");
  });

  it("preserves forwarded output and remote exit code when provenance parsing fails", () => {
    const stdoutPayload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const spawnSync = vi.fn(() => ({
      status: 7,
      signal: null,
      stdout: stdoutPayload,
      stderr: "openclaw warning",
      pid: 123,
      output: [null, stdoutPayload, "openclaw warning"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        provenanceLines: () => {
          throw new SyntaxError("Unexpected token in OpenClaw JSON output");
        },
        spawnSync,
      }),
    ).toThrow("__exit:7");

    expect(stdout.join("")).toBe(stdoutPayload);
    expect(stderr.join("")).toContain("openclaw warning");
    expect(stderr.join("")).toContain(
      "[openclaw provenance] skipped provenance extraction after parser failure.",
    );
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("pins the sandbox's owning gateway in the dispatched argv", () => {
    const payload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const spawnSync = vi.fn((_binary: string, _args: readonly string[], _options: object) => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "openclaw warning\n",
      pid: 123,
      output: [null, payload, "openclaw warning\n"],
    }));
    const { proc } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => "nemoclaw-8081",
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:0");

    expect(spawnSync.mock.calls[0]?.[1].slice(0, 6)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8081",
    ]);
  });

  it("withholds an interactive terminal from the non-interactive dispatch", () => {
    const payload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const spawnSync = vi.fn(
      (_binary: string, _args: readonly string[], _options: SpawnSyncOptions) => ({
        status: 0,
        signal: null,
        stdout: payload,
        stderr: "openclaw warning\n",
        pid: 123,
        output: [null, payload, "openclaw warning\n"],
      }),
    );
    const { proc } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => true,
      }),
    ).toThrow("__exit:0");

    expect(spawnSync.mock.calls[0]?.[2].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("exits non-zero for a turn the payload marks incomplete, after preserving the trace", () => {
    const payload = JSON.stringify({
      status: "ok",
      summary: "completed",
      result: {
        messages: [{ role: "toolResult", toolName: "write_file", toolCallId: "c1" }],
        payloads: [],
        meta: {
          error: { kind: "incomplete_turn" },
          livenessState: "abandoned",
          replayInvalid: true,
        },
      },
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "openclaw warning\n",
      pid: 123,
      output: [null, payload, "openclaw warning\n"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:1");

    expect(stdout.join("")).toBe(payload);
    expect(stderr.join("")).toContain("did not complete");
    expect(stderr.join("")).toContain("error.kind=incomplete_turn");
    expect(stderr.join("")).toContain("livenessState=abandoned");
    expect(stderr.join("")).toContain("replayInvalid=true");
    expect(stderr.join("")).toContain("nemoclaw 'alpha' sessions list");
    expect(stderr.join("")).toContain("nemoclaw 'alpha' sessions export <key>");
    expect(stderr.join("")).toContain(
      "Inspect the partial JSON trace, exported transcript, and affected resources before retrying",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when an incomplete response omits optional payloads", () => {
    const payload = JSON.stringify({
      status: "ok",
      result: { meta: { error: { kind: "incomplete_turn" } } },
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:1");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps a completed turn at exit 0 so the incomplete-turn check does not misfire", () => {
    const payload = JSON.stringify({
      status: "ok",
      summary: "completed",
      result: { payloads: [{ text: "PONG" }], meta: { livenessState: "working" } },
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:0");

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps a healthy response at exit 0 after a marker-bearing JSON log record", () => {
    const payload = [
      JSON.stringify({ event: "progress", meta: { replayInvalid: true } }),
      JSON.stringify({
        status: "ok",
        result: { payloads: [{ text: "done" }], meta: { livenessState: "working" } },
      }),
    ].join("\n");
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:0");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps a completed turn at exit 0 when a tool result merely contains marker fields", () => {
    const payload = JSON.stringify({
      status: "ok",
      result: {
        messages: [
          {
            role: "toolResult",
            content: {
              replayInvalid: true,
              livenessState: "abandoned",
              error: { kind: "incomplete_turn" },
            },
          },
        ],
        payloads: [{ text: "done" }],
      },
    });
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:0");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("preserves an upstream non-zero code instead of relabelling an incomplete turn", () => {
    const payload = JSON.stringify({ result: { meta: { error: { kind: "incomplete_turn" } } } });
    const spawnSync = vi.fn(() => ({
      status: 7,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:7");

    expect(exit).toHaveBeenCalledWith(7);
  });

  it("fails loud and keeps stdout empty when the dispatch delivers nothing", () => {
    const spawnSync = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      pid: 123,
      output: [null, "", ""],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    expect(() =>
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        spawnSync,
        stdinIsTty: () => false,
      }),
    ).toThrow("__exit:1");

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("exited 0 without producing any output");
    expect(stderr.join("")).not.toContain("[openclaw provenance]");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
