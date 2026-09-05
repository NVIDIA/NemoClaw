// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { HARNESS_COUNTER, HARNESS_TMPDIR, withFakeCurlProbe } from "./onboard-probes-curl-harness";

const { probeOpenAiLikeEndpoint } = require("./onboard-probes");

// Strict tool-call probe retry ladder and diagnostic codes for reasoning-heavy
// models. Split from onboard-probes.test.ts to stay inside the test-file size
// budget. Refs #8714.
describe("strict tool-call probe reasoning retry ladder", () => {
  it("escalates the reasoning-only retry to a 4096-token budget (#8714)", () => {
    const script = `#!/usr/bin/env bash
outfile=""
payload=""
maxtime=""
connecttimeout=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    --max-time) maxtime="$2"; shift 2 ;;
    --connect-timeout) connecttimeout="$2"; shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
printf '%s' "$payload" > "${HARNESS_TMPDIR}/request-$n.json"
printf '%s' "$maxtime" > "${HARNESS_TMPDIR}/maxtime-$n"
printf '%s' "$connecttimeout" > "${HARNESS_TMPDIR}/connect-$n"
if [ -n "$outfile" ]; then
  if [ "$n" -le 2 ]; then
    cat <<'JSON' > "$outfile"
{"choices":[{"finish_reason":"length","message":{"content":"","reasoning":"Planning the tool call.","tool_calls":null}}]}
JSON
  else
    cat <<'JSON' > "$outfile"
{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}
JSON
  fi
fi
printf '200'
exit 0
`;
    withFakeCurlProbe(
      { script, dirPrefix: "nemoclaw-reasoning-ladder-probe-" },
      ({ counter, tmpDir }) => {
        const result = probeOpenAiLikeEndpoint(
          "http://127.0.0.1:11434/v1",
          "nemotron-3-nano:30b",
          "",
          {
            skipResponsesProbe: true,
            requireChatCompletionsToolCalling: true,
          },
        );

        expect(result).toMatchObject({ ok: true, api: "openai-completions" });
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
        const payloads = [1, 2, 3].map((n) =>
          JSON.parse(fs.readFileSync(path.join(tmpDir, `request-${n}.json`), "utf8")),
        );
        expect(payloads.map((payload) => payload.max_tokens)).toEqual([256, 1024, 4096]);
        payloads.forEach((payload) => {
          expect(payload).toMatchObject({ tool_choice: "required" });
        });
        const maxTimes = [1, 2, 3].map((n) =>
          Number(fs.readFileSync(path.join(tmpDir, `maxtime-${n}`), "utf8")),
        );
        expect(maxTimes[0]).toBeGreaterThan(0);
        expect(maxTimes[1]).toBe(maxTimes[0]);
        expect(maxTimes[2]).toBe(maxTimes[0] * 2);
        const connectTimeouts = [1, 2, 3].map((n) =>
          Number(fs.readFileSync(path.join(tmpDir, `connect-${n}`), "utf8")),
        );
        expect(connectTimeouts[0]).toBeGreaterThan(0);
        expect(connectTimeouts[1]).toBe(connectTimeouts[0]);
        expect(connectTimeouts[2]).toBe(connectTimeouts[0]);
      },
    );
  });

  it("caps the legacy strict-tool reasoning retry and watchdog", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "600");
    const calls: Array<{ args: readonly string[]; timeout?: number }> = [];
    const reasoningReply =
      '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning":"Planning the tool call.","tool_calls":null}}]}';
    const toolCallReply =
      '{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}';
    const replies = [reasoningReply, reasoningReply, toolCallReply];
    const spawnSyncImpl = vi.fn(
      (_command: string, args: readonly string[], options: { timeout?: number }) => {
        const outputPath = args[args.indexOf("-o") + 1];
        fs.writeFileSync(outputPath, replies[calls.length]);
        calls.push({ args, timeout: options.timeout });
        return { pid: 1, output: [], stdout: "200", stderr: "", status: 0, signal: null };
      },
    );

    try {
      const result = probeOpenAiLikeEndpoint(
        "http://127.0.0.1:11434/v1",
        "nemotron-3-nano:30b",
        "",
        {
          skipResponsesProbe: true,
          requireChatCompletionsToolCalling: true,
          isWsl: false,
          spawnSyncImpl,
        },
      );
      const argValues = (flag: string) =>
        calls.map(({ args }) => Number(args[args.indexOf(flag) + 1]));
      const payloads = calls.map(({ args }) => JSON.parse(args[args.indexOf("-d") + 1]));

      expect({
        result,
        replyBudgets: payloads.map((payload) => payload.max_tokens),
        connectTimes: argValues("--connect-timeout"),
        maxTimes: argValues("--max-time"),
        processTimeouts: calls.map(({ timeout }) => timeout),
      }).toEqual({
        result: expect.objectContaining({ ok: true, api: "openai-completions" }),
        replyBudgets: [256, 1024, 4096],
        connectTimes: [600, 600, 600],
        maxTimes: [600, 600, 600],
        processTimeouts: [605_000, 605_000, 605_000],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a reasoning-budget diagnostic when the full retry ladder is exhausted (#8714)", () => {
    const script = `#!/usr/bin/env bash
outfile=""
payload=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
printf '%s' "$payload" > "${HARNESS_TMPDIR}/request-$n.json"
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"finish_reason":"length","message":{"content":"","reasoning":"Planning the tool call.","tool_calls":null}}]}
JSON
fi
printf '200'
exit 0
`;
    withFakeCurlProbe(
      { script, dirPrefix: "nemoclaw-reasoning-exhausted-probe-" },
      ({ counter }) => {
        const result = probeOpenAiLikeEndpoint(
          "http://127.0.0.1:11434/v1",
          "nemotron-3-nano:30b",
          "",
          {
            skipResponsesProbe: true,
            requireChatCompletionsToolCalling: true,
          },
        );

        expect(result).toMatchObject({ ok: false });
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
        expect(result.failures).toEqual([
          expect.objectContaining({
            diagnosticCodes: [
              "openai-chat-missing-structured-tool-call",
              "openai-chat-reasoning-budget-exhausted",
            ],
          }),
        ]);
      },
    );
  });

  it("marks a leaked plain-text tool call with a credential-free diagnostic code (#8714)", () => {
    const script = `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"role":"assistant","content":"{\\"arguments\\":{\\"message\\":\\"hello?\\"},\\"name\\":\\"sessions_send\\"}","tool_calls":null}}]}
JSON
fi
printf '200'
exit 0
`;
    withFakeCurlProbe({ script, dirPrefix: "nemoclaw-tool-leak-probe-" }, () => {
      const result = probeOpenAiLikeEndpoint("http://127.0.0.1:11434/v1", "qwen3-vl:4b", "", {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
      });

      expect(result).toMatchObject({ ok: false });
      expect(result.failures).toEqual([
        expect.objectContaining({
          diagnosticCodes: ["openai-chat-tool-call-leak"],
        }),
      ]);
    });
  });

  it("keeps diagnostic codes on the doubled-timeout retry failure (#8714)", () => {
    const script = `#!/usr/bin/env bash
outfile=""
payload=""
maxtime=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    --max-time) maxtime="$2"; shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
printf '%s' "$payload" > "${HARNESS_TMPDIR}/request-$n.json"
printf '%s' "$maxtime" > "${HARNESS_TMPDIR}/maxtime-$n"
if [ "$n" -eq 3 ]; then
  : > "$outfile"
  printf '000'
  exit 28
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"finish_reason":"length","message":{"content":"","reasoning":"Planning the tool call.","tool_calls":null}}]}
JSON
fi
printf '200'
exit 0
`;
    withFakeCurlProbe({ script, dirPrefix: "nemoclaw-doubled-retry-codes-" }, ({ tmpDir }) => {
      const result = probeOpenAiLikeEndpoint("http://127.0.0.1:11434/v1", "qwen3-vl:4b", "", {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
      });

      expect(result).toMatchObject({ ok: false });
      const payloads = [1, 2, 3].map((n) =>
        JSON.parse(fs.readFileSync(path.join(tmpDir, `request-${n}.json`), "utf8")),
      );
      expect(payloads.map((payload) => payload.max_tokens)).toEqual([256, 1024, 4096]);
      const maxTimes = [1, 2, 3].map((n) =>
        Number(fs.readFileSync(path.join(tmpDir, `maxtime-${n}`), "utf8")),
      );
      expect(maxTimes[0]).toBeGreaterThan(0);
      expect(maxTimes[2]).toBe(maxTimes[0] * 2);
      const ladderFailure = result.failures.find(
        (failure: { reasoningRetryAttempted?: boolean }) =>
          failure.reasoningRetryAttempted === true,
      );
      expect(ladderFailure).toMatchObject({
        diagnosticCodes: ["openai-chat-missing-structured-tool-call"],
      });
    });
  });
});
