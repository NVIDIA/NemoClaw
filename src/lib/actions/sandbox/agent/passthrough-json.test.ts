// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

  it("preserves OpenClaw JSON stdout and appends failed-tool provenance to stderr", async () => {
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
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "openclaw warning\n",
      pid: 123,
      output: [null, payload, "openclaw warning\n"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        runDispatch,
      }),
    ).rejects.toThrow("__exit:0");

    expect(runDispatch).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      buildOpenshellExecArgs(
        "alpha",
        wrapOpenClawAgentCommandWithRuntimeEnv(["openclaw", "agent", "--json"]),
        { tty: false },
      ),
      { stdinIsTty: false },
    );
    expect(stdout.join("")).toBe(payload);
    expect(() => JSON.parse(stdout.join(""))).not.toThrow();
    expect(stderr.join("")).toContain("openclaw warning");
    expect(stderr.join("")).toContain("[openclaw provenance] failed tool result");
    expect(stderr.join("")).toContain("node-not-real");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("bounds the host transport when the turn requests a deadline (#8723)", async () => {
    const runDispatch = vi.fn(async (_binary: string, _args: readonly string[]) => ({
      status: 0,
      signal: null,
      stdout: "{}",
      stderr: "openclaw banner\n",
    }));
    const { proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json", "--timeout", "30"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        runDispatch,
      }),
    ).rejects.toThrow(/__exit:/);

    const argv = [...(runDispatch.mock.calls[0]?.[1] ?? [])];
    const transportFlags = argv.slice(0, argv.indexOf("--"));
    // Outlasts the requested deadline so the turn still reports its own timeout.
    expect(transportFlags).toContain("--timeout");
    expect(transportFlags[transportFlags.indexOf("--timeout") + 1]).toBe("60");
  });

  it("leaves the host transport unbounded when the turn requests no deadline (#8723)", async () => {
    const runDispatch = vi.fn(async (_binary: string, _args: readonly string[]) => ({
      status: 0,
      signal: null,
      stdout: "{}",
      stderr: "openclaw banner\n",
    }));
    const { proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        runDispatch,
      }),
    ).rejects.toThrow(/__exit:/);

    const argv = [...(runDispatch.mock.calls[0]?.[1] ?? [])];
    expect(argv.slice(0, argv.indexOf("--"))).not.toContain("--timeout");
  });

  it("surfaces spawn errors and exits with the computed transport failure code", async () => {
    const runDispatch = vi.fn(async () => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error("runDispatch openshell ENOENT"),
      pid: 0,
      output: [null, "", ""],
    }));
    const { exit, proc, stderr } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        stdinIsTty: () => false,
        runDispatch,
      }),
    ).rejects.toThrow("__exit:1");

    expect(stderr.join("")).toContain("Failed to invoke openshell");
    expect(stderr.join("")).toContain("runDispatch openshell ENOENT");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not treat stderr JSON diagnostics as agent provenance", async () => {
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
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: stdoutPayload,
      stderr: stderrPayload,
      pid: 123,
      output: [null, stdoutPayload, stderrPayload],
    }));
    const { proc, stderr } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        runDispatch,
      }),
    ).rejects.toThrow("__exit:0");

    expect(stderr.join("")).toContain("stderr-diagnostic");
    expect(stderr.join("")).not.toContain("[openclaw provenance]");
  });

  it("preserves forwarded output and remote exit code when provenance parsing fails", async () => {
    const stdoutPayload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const runDispatch = vi.fn(async () => ({
      status: 7,
      signal: null,
      stdout: stdoutPayload,
      stderr: "openclaw warning",
      pid: 123,
      output: [null, stdoutPayload, "openclaw warning"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        stdinIsTty: () => false,
        provenanceLines: () => {
          throw new SyntaxError("Unexpected token in OpenClaw JSON output");
        },
        runDispatch,
      }),
    ).rejects.toThrow("__exit:7");

    expect(stdout.join("")).toBe(stdoutPayload);
    expect(stderr.join("")).toContain("openclaw warning");
    expect(stderr.join("")).toContain(
      "[openclaw provenance] skipped provenance extraction after parser failure.",
    );
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("pins the sandbox's owning gateway in the dispatched argv", async () => {
    const payload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const runDispatch = vi.fn(
      async (
        _binary: string,
        _args: readonly string[],
        _options?: { maxBufferBytes?: number; stdinIsTty?: boolean },
      ) => ({
        status: 0,
        signal: null,
        stdout: payload,
        stderr: "openclaw warning\n",
        pid: 123,
        output: [null, payload, "openclaw warning\n"],
      }),
    );
    const { proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => "nemoclaw-8081",
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");

    expect(runDispatch.mock.calls[0]?.[1].slice(0, 6)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8081",
    ]);
  });

  it("withholds an interactive terminal from the non-interactive dispatch", async () => {
    const payload = JSON.stringify({ result: { payloads: [{ text: "OK" }] } });
    const runDispatch = vi.fn(
      async (_binary: string, _args: readonly string[], _options?: { stdinIsTty?: boolean }) => ({
        status: 0,
        signal: null,
        stdout: payload,
        stderr: "openclaw warning\n",
        pid: 123,
        output: [null, payload, "openclaw warning\n"],
      }),
    );
    const { proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => true,
      }),
    ).rejects.toThrow("__exit:0");

    expect(runDispatch.mock.calls[0]?.[2]).toEqual({ stdinIsTty: true });
  });

  it("exits non-zero for a turn the payload marks incomplete, after preserving the trace", async () => {
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
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "openclaw warning\n",
      pid: 123,
      output: [null, payload, "openclaw warning\n"],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:1");

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

  it("exits non-zero with deadline guidance for a turn the payload marks timed out (#8723)", async () => {
    // The shape measured on a real timed-out run: the envelope reports a
    // timeout, the payload holds the partial answer, and `livenessState` is
    // whatever the run happened to reach, so only `timeoutPhase` classifies it.
    const payload = JSON.stringify({
      status: "timeout",
      result: {
        payloads: [{ text: "1\n2\n3" }],
        meta: {
          replayInvalid: false,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      },
    });
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:1");

    expect(stdout.join("")).toBe(payload);
    const errText = stderr.join("");
    expect(errText).toContain("timed out in the provider phase before producing a result");
    expect(errText).toContain("nemoclaw 'alpha' sessions export <key>");
    expect(errText).toContain("models.providers.<id>.timeoutSeconds");
    // The generic incomplete-turn text is replaced, not appended.
    expect(errText).not.toContain("did not complete");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("recovers timeout guidance after an unclosed log fragment (#8723)", async () => {
    const response = JSON.stringify({
      status: "timeout",
      result: { payloads: [{ text: "partial" }], meta: { timeoutPhase: "provider" } },
    });
    const payload = `tool {"name":"read"\n${response}`;
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:1");

    expect(stdout.join("")).toBe(payload);
    expect(stderr.join("")).toContain("timed out in the provider phase");
    expect(stderr.join("")).toContain("Inspect the partial output and affected resources");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when an incomplete response omits optional payloads", async () => {
    const payload = JSON.stringify({
      status: "ok",
      result: { meta: { error: { kind: "incomplete_turn" } } },
    });
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:1");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps a completed turn at exit 0 so the incomplete-turn check does not misfire", async () => {
    const payload = JSON.stringify({
      status: "ok",
      summary: "completed",
      result: { payloads: [{ text: "PONG" }], meta: { livenessState: "working" } },
    });
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps a healthy response at exit 0 after a marker-bearing JSON log record", async () => {
    const payload = [
      JSON.stringify({ event: "progress", meta: { replayInvalid: true } }),
      JSON.stringify({
        status: "ok",
        result: { payloads: [{ text: "done" }], meta: { livenessState: "working" } },
      }),
    ].join("\n");
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps a completed turn at exit 0 when a tool result merely contains marker fields", async () => {
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
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");

    expect(stdout.join("")).toBe(payload);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("preserves an upstream non-zero code instead of relabelling an incomplete turn", async () => {
    const payload = JSON.stringify({ result: { meta: { error: { kind: "incomplete_turn" } } } });
    const runDispatch = vi.fn(async () => ({
      status: 7,
      signal: null,
      stdout: payload,
      stderr: "",
      pid: 123,
      output: [null, payload, ""],
    }));
    const { exit, proc } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:7");

    expect(exit).toHaveBeenCalledWith(7);
  });

  it("returns exit 143 after preserving output from a SIGTERM-interrupted dispatch (#8723)", async () => {
    const partial = JSON.stringify({ event: "progress", status: "running" });
    const runDispatch = vi.fn(async () => ({
      status: null,
      signal: "SIGTERM" as const,
      stdout: partial,
      stderr: "agent turn interrupted\n",
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        incompleteTurnSignal: () => null,
        provenanceLines: () => [],
        runDispatch,
      }),
    ).rejects.toThrow("__exit:143");

    expect(stdout.join("")).toBe(partial);
    expect(stderr.join("")).toContain("agent turn interrupted");
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("fails loud and keeps stdout empty when the dispatch delivers nothing", async () => {
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      pid: 123,
      output: [null, "", ""],
    }));
    const { exit, proc, stderr, stdout } = makeProc();

    await expect(
      runAgentJsonPassthrough("alpha", ["openclaw", "agent", "--json"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: () => "openshell",
        runDispatch,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:1");

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("exited 0 without producing any output");
    expect(stderr.join("")).not.toContain("[openclaw provenance]");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
