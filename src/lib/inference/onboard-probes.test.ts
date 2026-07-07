// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { captureAuthConfigPath } from "../adapters/http/auth-config-test-helpers";
import {
  HARNESS_COUNTER,
  HARNESS_TMPDIR,
  makeFakeCurlScript,
  withFakeCurlProbe,
} from "./onboard-probes-curl-harness";

const {
  getChatCompletionsProbeCurlArgs,
  getChatCompletionsProbePayload,
  getDeepSeekV4ProValidationProbeCurlArgs,
  getKimiK26ValidationProbeCurlArgs,
  getValidationProbeCurlArgs,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  hasResponsesToolCall,
  isSandboxInternalUrl,
  probeOpenAiLikeEndpoint,
  RETRIABLE_HTTP_PROBE_STATUSES,
} = require("./onboard-probes");

// Restore an env var to its pre-test value without branching at the call
// site. Centralizing the conditional keeps test bodies linear and keeps the
// codebase-growth-guardrails "if count" steady; see PR #5975 review.
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

const FAKE_CONFIG_PATH = "/tmp/nemoclaw-test-credential.conf";
const FAKE_CREDENTIAL_ARGS = ["--config", FAKE_CONFIG_PATH] as const;

describe("OpenAI-compatible inference probe response parsing", () => {
  it("detects tool-calling responses payloads conservatively", () => {
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "emit_ok",
              arguments: '{"value":"OK"}',
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "function_call",
                  name: "emit_ok",
                  arguments: '{"value":"OK"}',
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(hasResponsesToolCall("{")).toBe(false);
  });

  it("detects structured chat-completions tool_calls", () => {
    expect(
      hasChatCompletionsToolCall(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "sessions_send", arguments: '{"message":"hello"}' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasChatCompletionsToolCall(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK", tool_calls: [] } }],
        }),
      ),
    ).toBe(false);
    expect(
      hasChatCompletionsToolCall(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "sessions_send" },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      hasChatCompletionsToolCall(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    type: "text",
                    function: { name: "sessions_send", arguments: '{"message":"hello"}' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(hasChatCompletionsToolCall("{")).toBe(false);
  });

  it("detects leaked stringified tool-call JSON in chat-completions content", () => {
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: '{\n  "arguments":{"message":"hello?"},\n  "name":"sessions_send"\n}',
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  type: "function",
                  function: {
                    name: "sessions_send",
                    arguments: JSON.stringify({ message: "hello?" }),
                  },
                }),
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  tool_calls: [
                    {
                      type: "function",
                      function: {
                        name: "sessions_send",
                        arguments: JSON.stringify({ message: "hello?" }),
                      },
                    },
                  ],
                }),
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: '{"arguments":{"message":"hello?"},"name":"sessions_send"}',
                  },
                ],
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Regular assistant text response.",
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: '{"type":"function","function":{"name":"sessions_send"}}',
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      hasChatCompletionsToolCallLeak(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Regular assistant text response." }],
                tool_calls: null,
              },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(hasChatCompletionsToolCallLeak("{")).toBe(false);
  });
});

describe("OpenAI-compatible inference probes", () => {
  it("uses the NVIDIA Build request shape for DeepSeek V4 Pro", () => {
    expect(getChatCompletionsProbePayload("deepseek-ai/deepseek-v4-pro")).toEqual({
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      temperature: 1,
      top_p: 0.95,
      max_tokens: 8192,
      chat_template_kwargs: { thinking: false },
      stream: true,
    });
  });

  it("keeps the default chat-completions probe bounded for other models", () => {
    expect(getChatCompletionsProbePayload("nvidia/nemotron-3-super-120b-a12b")).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
    });
  });

  it("bounds the hosted compatible inference probe for the served Nemotron model", () => {
    expect(getChatCompletionsProbePayload("nvidia/nvidia/nemotron-3-ultra")).toEqual({
      model: "nvidia/nvidia/nemotron-3-ultra",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
    });
  });

  it("allows onboard validation max-time to be raised from the environment", () => {
    const original = process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS;
    process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS = "300";
    try {
      expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
      ]);
      expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
      ]);
    } finally {
      restoreEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", original);
    }
  });

  it("uses an extended validation budget for slow NVIDIA Build models", () => {
    for (const model of ["qwen/qwen3.5-397b-a17b", "deepseek-ai/deepseek-v4-flash"]) {
      const args = getChatCompletionsProbeCurlArgs({
        credentialArgs: FAKE_CREDENTIAL_ARGS,
        model,
        url: "https://integrate.api.nvidia.com/v1/chat/completions",
        isWsl: false,
      });
      expect(args[args.indexOf("--connect-timeout") + 1]).toBe("10");
      expect(args[args.indexOf("--max-time") + 1]).toBe("300");
    }

    const wslArgs = getChatCompletionsProbeCurlArgs({
      credentialArgs: FAKE_CREDENTIAL_ARGS,
      model: "qwen/qwen3.5-397b-a17b",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: true,
    });
    expect(wslArgs[wslArgs.indexOf("--connect-timeout") + 1]).toBe("30");
    expect(wslArgs[wslArgs.indexOf("--max-time") + 1]).toBe("300");
  });

  it("caps Kimi K2.6 probe output and gives it a slower validation budget", () => {
    expect(getChatCompletionsProbePayload("moonshotai/kimi-k2.6")).toEqual({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
      chat_template_kwargs: { thinking: false },
    });

    expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
    ]);
    expect(getKimiK26ValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "20",
      "--max-time",
      "90",
    ]);

    const args = getChatCompletionsProbeCurlArgs({
      credentialArgs: FAKE_CREDENTIAL_ARGS,
      model: "moonshotai/kimi-k2.6",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: false,
    });

    expect(args).toContain("--max-time");
    expect(args[args.indexOf("--max-time") + 1]).toBe("60");
    expect(args).toContain(JSON.stringify(getChatCompletionsProbePayload("moonshotai/kimi-k2.6")));
  });

  it("uses an extended streaming validation budget for DeepSeek V4 Pro", () => {
    expect(getDeepSeekV4ProValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "20",
      "--max-time",
      "120",
    ]);
    expect(getDeepSeekV4ProValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "30",
      "--max-time",
      "150",
    ]);

    const args = getChatCompletionsProbeCurlArgs({
      credentialArgs: FAKE_CREDENTIAL_ARGS,
      model: "deepseek-ai/deepseek-v4-pro",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: false,
    });

    expect(args).toContain("--max-time");
    expect(args[args.indexOf("--max-time") + 1]).toBe("120");
    // The credentialArgs slice must appear verbatim in the generated argv so
    // production probe call sites can route credentials via --config without
    // the helper rewriting or dropping them.
    expect(args).toContain("--config");
    expect(args).toContain(FAKE_CONFIG_PATH);
  });

  describe("sandbox-internal URL handling", () => {
    it("identifies host.openshell.internal as sandbox-internal", () => {
      expect(isSandboxInternalUrl("http://host.openshell.internal:8001/v1")).toBe(true);
    });

    it("does not treat normal hostnames as sandbox-internal", () => {
      expect(isSandboxInternalUrl("http://localhost:8001/v1")).toBe(false);
      expect(isSandboxInternalUrl("https://api.openai.com/v1")).toBe(false);
      expect(isSandboxInternalUrl("http://127.0.0.1:8001/v1")).toBe(false);
    });

    it("skips the curl probe for sandbox-internal URLs and returns ok with a note", () => {
      const result = probeOpenAiLikeEndpoint(
        "http://host.openshell.internal:8001/v1",
        "openai/local-model",
        "dummy",
      );
      expect(result).toMatchObject({
        ok: true,
        api: null,
        note: expect.stringContaining("host.openshell.internal"),
      });
      expect(result.note).toMatch(/only resolves inside the sandbox/);
    });

    it("fails closed for unprobeable sandbox-internal URLs when strict tool calling is required", () => {
      const result = probeOpenAiLikeEndpoint(
        "http://host.openshell.internal:8001/v1",
        "openai/local-model",
        "dummy",
        { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.message).toMatch(
        /cannot be validated.*structured Chat Completions tool calls/i,
      );
    });
  });

  describe("retriable HTTP statuses (#2980, #3033)", () => {
    it("retries 429 (rate limit)", () => {
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(429)).toBe(true);
    });

    it("retries 502/503/504 (upstream gateway flakes)", () => {
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(502)).toBe(true);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(503)).toBe(true);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(504)).toBe(true);
    });

    it("does not retry on client-side or non-transient statuses", () => {
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(400)).toBe(false);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(401)).toBe(false);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(403)).toBe(false);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(404)).toBe(false);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(500)).toBe(false);
      expect(RETRIABLE_HTTP_PROBE_STATUSES.has(200)).toBe(false);
    });

    it("recovers when an upstream 502 clears on retry (#2980)", () => {
      const body = `n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
if [ "$n" -lt 2 ]; then
  if [ -n "$outfile" ]; then
    printf '<html>502 Bad Gateway</html>' > "$outfile"
  fi
  printf '502'
  exit 0
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
      withFakeCurlProbe(
        {
          script: makeFakeCurlScript(body),
          dirPrefix: "nemoclaw-502-probe-",
        },
        ({ lines, counter }) => {
          const result = probeOpenAiLikeEndpoint(
            "https://integrate.api.nvidia.com/v1",
            "nvidia/nemotron-3-super-120b-a12b",
            "nvapi-test",
            { skipResponsesProbe: true },
          );

          expect(result).toMatchObject({ ok: true, api: "openai-completions" });
          expect(lines.join("\n")).toContain("HTTP 502");
          expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
        },
      );
    });

    it("retries chat-completions when /responses errors then chat-completions times out", () => {
      const script = `#!/usr/bin/env bash
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
if echo "$url" | grep -q '/responses'; then
  if [ -n "$outfile" ]; then
    printf '404 page not found' > "$outfile"
  fi
  printf '404'
  exit 0
fi
if [ "$n" -le 2 ]; then
  if [ -n "$outfile" ]; then
    : > "$outfile"
  fi
  printf '000'
  exit 28
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
      withFakeCurlProbe({ script, dirPrefix: "nemoclaw-mixed-probe-" }, ({ counter }) => {
        const result = probeOpenAiLikeEndpoint(
          "https://api.example.com/v1",
          "test-model",
          "sk-test",
        );

        expect(result).toMatchObject({ ok: true, api: "openai-completions" });
        // /responses (404) + /chat/completions (28) + chat-completions retry (200)
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
      });
    });

    it("preserves query-param auth on doubled-timeout chat-completions retry", () => {
      const script = `#!/usr/bin/env bash
outfile=""
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
printf '%s\\n' "$@" > "${HARNESS_TMPDIR}/args-$n.txt"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ "$n" -eq 1 ]; then
  if [ -n "$outfile" ]; then
    : > "$outfile"
  fi
  printf '000'
  exit 28
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
      withFakeCurlProbe(
        { script, dirPrefix: "nemoclaw-query-retry-probe-" },
        ({ counter, tmpDir }) => {
          const result = probeOpenAiLikeEndpoint(
            "https://api.example.com/v1",
            "test-model",
            "secret key",
            { skipResponsesProbe: true, authMode: "query-param" },
          );

          expect(result).toMatchObject({ ok: true, api: "openai-completions" });
          expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
          const observedConfigPaths = new Set<string>();
          for (const call of ["1", "2"]) {
            const args = fs.readFileSync(path.join(tmpDir, `args-${call}.txt`), "utf8");
            expect(args).toContain("https://api.example.com/v1/chat/completions");
            expect(args).not.toContain("?key=");
            expect(args).not.toContain("Authorization: Bearer");
            expect(args).not.toContain("secret key");
            observedConfigPaths.add(captureAuthConfigPath(args.split("\n")));
          }
          // Both calls must reuse the same auth config tmpfile so a doubled-
          // timeout retry never spawns a second config write that could race
          // with cleanup. PR #5975 review note PRA-9 / CodeRabbit "assert
          // --config has a path value".
          expect(observedConfigPaths.size).toBe(1);
        },
      );
    });

    it("keeps timeout retries strict when chat-completions tool calling is required", () => {
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
if [ "$n" -eq 1 ]; then
  if [ -n "$outfile" ]; then
    : > "$outfile"
  fi
  printf '000'
  exit 28
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
      withFakeCurlProbe(
        { script, dirPrefix: "nemoclaw-strict-retry-probe-" },
        ({ counter, tmpDir }) => {
          const result = probeOpenAiLikeEndpoint(
            "https://api.example.com/v1",
            "test-model",
            "sk-test",
            { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
          );

          expect(result).toMatchObject({ ok: false });
          expect(result.message).toContain("did not return a tool call");
          expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
          const retryPayload = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "request-2.json"), "utf8"),
          );
          expect(retryPayload).toMatchObject({
            tool_choice: "required",
            max_tokens: 256,
            stream: false,
          });
        },
      );
    });

    it("keeps retrying when initial timeout is followed by a transient 502", () => {
      const body = `n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
if [ "$n" -eq 1 ]; then
  if [ -n "$outfile" ]; then
    : > "$outfile"
  fi
  printf '000'
  exit 28
fi
if [ "$n" -eq 2 ]; then
  if [ -n "$outfile" ]; then
    printf '<html>502 Bad Gateway</html>' > "$outfile"
  fi
  printf '502'
  exit 0
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
      withFakeCurlProbe(
        {
          script: makeFakeCurlScript(body),
          dirPrefix: "nemoclaw-timeout-502-probe-",
        },
        ({ lines, counter }) => {
          const result = probeOpenAiLikeEndpoint(
            "https://integrate.api.nvidia.com/v1",
            "nvidia/nemotron-3-super-120b-a12b",
            "nvapi-test",
            { skipResponsesProbe: true },
          );

          expect(result).toMatchObject({ ok: true, api: "openai-completions" });
          expect(lines.join("\n")).toContain("HTTP 502");
          expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
        },
      );
    });
  });

  it("continues with openai-completions when DeepSeek V4 Pro stream validation times out", () => {
    const body = `if [ -n "$outfile" ]; then
  : > "$outfile"
fi
printf '000'
exit 28
`;
    withFakeCurlProbe(
      {
        script: makeFakeCurlScript(body),
        dirPrefix: "nemoclaw-deepseek-probe-",
      },
      ({ lines }) => {
        const result = probeOpenAiLikeEndpoint(
          "https://integrate.api.nvidia.com/v1",
          "deepseek-ai/deepseek-v4-pro",
          "nvapi-test",
          { skipResponsesProbe: true },
        );

        expect(result).toMatchObject({
          ok: true,
          api: "openai-completions",
          label: "Chat Completions API",
          validated: false,
        });
        expect(lines.join("\n")).toContain("DeepSeek V4 Pro validation timed out");
      },
    );
  });

  // PR #5975 review note PRA-14 (Nemotron). Pins the silent fallback so a
  // future SGLang fix that removes the workaround stays observable.
  it("falls back to chat-completions when /responses streaming lacks required events", () => {
    const script = `#!/usr/bin/env bash
outfile=""
url=""
payload=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
if echo "$url" | grep -q '/responses'; then
  if printf '%s' "$payload" | grep -q '"stream":true'; then
    if [ -n "$outfile" ]; then
      cat <<'SSE' > "$outfile"
event: response.created
data: {}

event: response.in_progress
data: {}

event: response.completed
data: {}

SSE
    fi
    printf '200'
    exit 0
  fi
  if [ -n "$outfile" ]; then
    printf '{"output":[]}' > "$outfile"
  fi
  printf '200'
  exit 0
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
    withFakeCurlProbe({ script, dirPrefix: "nemoclaw-stream-fallback-" }, ({ lines }) => {
      const result = probeOpenAiLikeEndpoint(
        "https://api.example.com/v1",
        "test-model",
        "sk-test",
        { probeStreaming: true },
      );

      expect(result).toMatchObject({ ok: true, api: "openai-completions" });
      expect(lines.join("\n")).toMatch(/missing required events/i);
    });
  });

  // PR #5975 review notes PRA-3 (Standard) and PRA-2 (Required). The unit
  // tests assert that constructed argv arrays do not contain the API key.
  // This integration test makes the same guarantee at the live curl process
  // boundary by recording both /proc/<pid>/cmdline and /proc/<pid>/environ
  // inside a fake curl and asserting the key is absent from each while
  // --config is present in argv. An ambient credential-shaped env var is set
  // before the probe to prove the spawn-env scrubber strips it from the
  // child. Runs only on Linux because /proc is not generally available
  // elsewhere.
  it.runIf(process.platform === "linux")(
    "keeps the API key out of the running curl argv and environment",
    () => {
      const apiKey = "nvapi-process-list-secret";
      const ambientSecret = "nvapi-environ-leak-canary";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proc-cmdline-"));
      const fakeBin = path.join(tmpDir, "bin");
      const cmdlinePath = path.join(tmpDir, "cmdline.txt");
      const environPath = path.join(tmpDir, "environ.txt");
      const psPath = path.join(tmpDir, "ps.txt");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
# Capture the running shell's own /proc/<pid>/cmdline and environ, and the
# live process table via the exact tool issue #5966 names (ps auxww), so the
# test asserts on what a host process-list inspector would see for the still
# running curl. The probe is synchronous, so the shell captures its own live
# process rather than a racy parent-side snapshot. Use $$ rather than
# /proc/self because /proc/self resolves relative to whatever subprocess
# opens the file, not this script.
if [ -r /proc/$$/cmdline ]; then
  tr '\\0' ' ' < /proc/$$/cmdline > "${cmdlinePath}"
fi
if [ -r /proc/$$/environ ]; then
  tr '\\0' '\\n' < /proc/$$/environ > "${environPath}"
fi
ps auxww > "${psPath}" 2>/dev/null || true
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      const originalAmbient = process.env.NEMOCLAW_PROBE_ENVIRON_SECRET;
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      process.env.NEMOCLAW_PROBE_ENVIRON_SECRET = ambientSecret;
      try {
        probeOpenAiLikeEndpoint(
          "https://integrate.api.nvidia.com/v1",
          "nvidia/nemotron-3-super-120b-a12b",
          apiKey,
          { skipResponsesProbe: true },
        );

        const recordedCmdline = fs.readFileSync(cmdlinePath, "utf8");
        expect(recordedCmdline).not.toContain(apiKey);
        expect(recordedCmdline).not.toContain("Authorization: Bearer");
        expect(recordedCmdline).toContain("--config");

        const recordedEnviron = fs.readFileSync(environPath, "utf8");
        expect(recordedEnviron).not.toContain(apiKey);
        expect(recordedEnviron).not.toContain(ambientSecret);
        expect(recordedEnviron).not.toContain("Authorization: Bearer");

        const recordedPs = fs.readFileSync(psPath, "utf8");
        expect(recordedPs).toContain("--config");
        expect(recordedPs).not.toContain(apiKey);
        expect(recordedPs).not.toContain("Authorization: Bearer");
      } finally {
        process.env.PATH = originalPath;
        if (originalAmbient === undefined) {
          delete process.env.NEMOCLAW_PROBE_ENVIRON_SECRET;
        } else {
          process.env.NEMOCLAW_PROBE_ENVIRON_SECRET = originalAmbient;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
