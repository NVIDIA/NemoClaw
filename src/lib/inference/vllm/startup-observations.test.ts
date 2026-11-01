// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVllmStartupLogExcerpts } from "./startup-observations";

const mocks = { capture: vi.fn(), spawn: vi.fn() };

async function diagnosticText(): Promise<string> {
  const excerpts = await readVllmStartupLogExcerpts("nemoclaw-vllm", dockerEnv, {
    dockerCapture: mocks.capture,
    dockerSpawn: mocks.spawn,
  });
  return excerpts.flatMap(({ lines }) => lines).join("\n");
}

const startedAt = "2026-10-31T10:00:00.123456789Z";
const before = "2026-10-31T09:59:59.999999999Z";
const dockerEnv = { DOCKER_HOST: "unix:///selected-docker.sock", PATH: process.env.PATH ?? "" };

function logProcess(
  stdout: readonly (string | Buffer)[],
  stderr: readonly (string | Buffer)[],
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
  error?: Error,
) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    error && child.emit("error", error);
    stderr.forEach((chunk) => child.stderr.write(chunk));
    stdout.forEach((chunk) => child.stdout.write(chunk));
    child.emit("close", code, signal);
  });
  return child;
}

describe("managed vLLM startup diagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.capture.mockReturnValueOnce(startedAt).mockReturnValueOnce("current attempt\n");
    mocks.spawn.mockImplementation(() => logProcess([], []));
  });

  it("shows the failed attempt after 80 newer pip lines hide it (#14017)", async () => {
    const pip = Array.from({ length: 79 }, (_, index) => ({
      at: startedAt,
      text: `Requirement already satisfied: package-${String(index)}`,
    })).concat({ at: startedAt, text: "WARNING: Running pip as the 'root' user" });
    const history = [
      { at: before, text: "vllm: error: unrecognized arguments: --disable-log-requests" },
      ...pip,
    ];
    mocks.capture
      .mockReset()
      .mockReturnValueOnce(startedAt)
      .mockReturnValueOnce(pip.map(({ text }) => text).join("\n"));
    mocks.spawn.mockImplementation((args: readonly string[]) => {
      // Docker selects tail records before applying the timestamp filter.
      const tail = args[args.indexOf("--tail") + 1];
      const records = tail === "all" ? history : history.slice(-Number(tail));
      const logs = records
        .filter(({ at }) => at < startedAt)
        .map(({ at, text }) => `${at} ${text}\n`)
        .join("");
      return logProcess([], [logs]);
    });

    const printed = await diagnosticText();
    expect(printed).toContain("vllm: error: unrecognized arguments: --disable-log-requests");
    expect(printed).toContain("Requirement already satisfied: package-78");
    expect(mocks.spawn).toHaveBeenCalledWith(
      ["logs", "--timestamps", "--tail", "all", "--until", startedAt, "nemoclaw-vllm"],
      expect.objectContaining({ env: dockerEnv, timeout: 5_000, killSignal: "SIGKILL" }),
    );
  });

  it("bounds and orders both streams while preserving complete UTF-8 records", async () => {
    const old = Array.from({ length: 100 }, (_, index) => `${before} old-${String(index)}\n`).join(
      "",
    );
    const utf8 = Buffer.from(`${before} error: café\n`);
    const split = utf8.indexOf(Buffer.from("é")) + 1;
    mocks.spawn.mockImplementation(() =>
      logProcess(
        [old, utf8.subarray(0, split), utf8.subarray(split)],
        ["2026-10-31T10:00:00Z error: latest failure\n"],
      ),
    );

    const printed = await diagnosticText();
    expect(printed).toContain("error: café");
    expect(printed).toContain("error: latest failure");
    expect(printed).not.toMatch(/�|old-0\n/);
    expect(printed.indexOf("error: café")).toBeLessThan(printed.indexOf("error: latest failure"));
    expect(printed.split("\n").filter(Boolean)).toHaveLength(81);
  });

  it("omits oversized records without exposing a truncated credential value", async () => {
    mocks.spawn.mockImplementation(() =>
      logProcess(
        [],
        [`${before} OPENAI_API_KEY=${"x".repeat(20_000)}secret-suffix\n${before} error: failed\n`],
      ),
    );

    const printed = await diagnosticText();
    expect(printed).toContain("error: failed");
    expect(printed).not.toContain("secret-suffix");
    expect(printed).not.toContain("leading characters omitted");
  });

  it.each([
    [1, null],
    [null, "SIGKILL"],
  ] as const)(
    "discards incomplete history when the log process closes with %j",
    async (code, signal) => {
      mocks.spawn.mockImplementation(() =>
        logProcess([], [`${before} partial history\n`], code, signal),
      );

      const printed = await diagnosticText();
      expect(printed).toContain("current attempt");
      expect(printed).not.toContain("partial history");
    },
  );

  it("discards historical output after an asynchronous process error", async () => {
    mocks.spawn.mockImplementation(() =>
      logProcess([], [`${before} partial history\n`], 0, null, new Error("read failed")),
    );

    const printed = await diagnosticText();
    expect(printed).toContain("current attempt");
    expect(printed).not.toContain("partial history");
  });

  it("keeps the current tail when the historical log process cannot start", async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(await diagnosticText()).toContain("current attempt");
  });

  it.each(["", "invalid timestamp"])(
    "keeps the current tail when the restart timestamp is %j",
    async (timestamp) => {
      mocks.capture
        .mockReset()
        .mockReturnValueOnce(timestamp)
        .mockReturnValueOnce("current attempt");

      expect(await diagnosticText()).toContain("current attempt");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );
});
