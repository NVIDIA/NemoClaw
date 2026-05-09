// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  getChatCompletionsProbeCurlArgs,
  getChatCompletionsProbePayload,
  getDeepSeekV4ProValidationProbeCurlArgs,
  getKimiK26ValidationProbeCurlArgs,
  isSandboxInternalUrl,
  probeOpenAiLikeEndpoint,
  RETRIABLE_HTTP_PROBE_STATUSES,
} = require("../../../dist/lib/inference/onboard-probes");

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

  it("keeps the default chat-completions probe minimal for other models", () => {
    expect(getChatCompletionsProbePayload("nvidia/nemotron-3-super-120b-a12b")).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
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
      authHeader: ["-H", "Authorization: Bearer nvapi-test"],
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
      authHeader: ["-H", "Authorization: Bearer nvapi-test"],
      model: "deepseek-ai/deepseek-v4-pro",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: false,
    });

    expect(args).toContain("--max-time");
    expect(args[args.indexOf("--max-time") + 1]).toBe("120");
    expect(args).toContain("Authorization: Bearer nvapi-test");
  });

  describe("sandbox-internal URL handling", () => {
    it("identifies host.openshell.internal and host.docker.internal as sandbox-internal", () => {
      expect(isSandboxInternalUrl("http://host.openshell.internal:8001/v1")).toBe(true);
      expect(isSandboxInternalUrl("http://host.docker.internal:11434/v1")).toBe(true);
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

    it("skips the curl probe for host.docker.internal and returns ok with a note", () => {
      const result = probeOpenAiLikeEndpoint(
        "http://host.docker.internal:11434/v1",
        "openai/nemotron-mini",
        "",
      );
      expect(result).toMatchObject({ ok: true, api: null });
      expect(result.note).toMatch(/host\.docker\.internal/);
    });

    it("probes host.docker.internal when strict chat-completions tool calling is required", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-docker-probe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const seenUrl = path.join(tmpDir, "url");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s' "$url" > "${seenUrl}"
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"sessions_send","arguments":"{\\"message\\":\\"hello\\"}"}}]}}]}
JSON
fi
printf '200'
exit 0
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      try {
        const result = probeOpenAiLikeEndpoint(
          "http://host.docker.internal:11434/v1",
          "openai/nemotron-mini",
          "",
          { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
        );

        expect(result).toMatchObject({
          ok: true,
          api: "openai-completions",
          label: "Chat Completions API",
        });
        expect(fs.readFileSync(seenUrl, "utf8")).toBe(
          "http://host.docker.internal:11434/v1/chat/completions",
        );
      } finally {
        process.env.PATH = originalPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails closed for unprobeable sandbox-internal URLs when strict tool calling is required", () => {
      const result = probeOpenAiLikeEndpoint(
        "http://host.openshell.internal:8001/v1",
        "openai/local-model",
        "dummy",
        { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.message).toMatch(/cannot be validated.*structured Chat Completions tool calls/i);
    });
  });

  describe("retriable HTTP statuses (issues #2980, #3033)", () => {
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

    it("recovers when an upstream 502 clears on retry (regression #2980)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-502-probe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const counter = path.join(tmpDir, "counter");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(counter, "0");
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
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
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      const originalNoSleep = process.env.NEMOCLAW_TEST_NO_SLEEP;
      const originalLog = console.log;
      const lines: string[] = [];
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = probeOpenAiLikeEndpoint(
          "https://integrate.api.nvidia.com/v1",
          "nvidia/nemotron-3-super-120b-a12b",
          "nvapi-test",
          { skipResponsesProbe: true },
        );

        expect(result).toMatchObject({ ok: true, api: "openai-completions" });
        expect(lines.join("\n")).toContain("HTTP 502");
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
      } finally {
        console.log = originalLog;
        process.env.PATH = originalPath;
        if (originalNoSleep === undefined) {
          delete process.env.NEMOCLAW_TEST_NO_SLEEP;
        } else {
          process.env.NEMOCLAW_TEST_NO_SLEEP = originalNoSleep;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("retries chat-completions when /responses errors then chat-completions times out", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mixed-probe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const counter = path.join(tmpDir, "counter");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(counter, "0");
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
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
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      const originalNoSleep = process.env.NEMOCLAW_TEST_NO_SLEEP;
      const originalLog = console.log;
      const lines: string[] = [];
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = probeOpenAiLikeEndpoint(
          "https://api.example.com/v1",
          "test-model",
          "sk-test",
        );

        expect(result).toMatchObject({ ok: true, api: "openai-completions" });
        // /responses (404) + /chat/completions (28) + chat-completions retry (200)
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
      } finally {
        console.log = originalLog;
        process.env.PATH = originalPath;
        if (originalNoSleep === undefined) {
          delete process.env.NEMOCLAW_TEST_NO_SLEEP;
        } else {
          process.env.NEMOCLAW_TEST_NO_SLEEP = originalNoSleep;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("keeps timeout retries strict when chat-completions tool calling is required", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-strict-retry-probe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const counter = path.join(tmpDir, "counter");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(counter, "0");
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
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
n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
printf '%s' "$payload" > "${tmpDir}/request-$n.json"
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
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      try {
        const result = probeOpenAiLikeEndpoint(
          "https://api.example.com/v1",
          "test-model",
          "sk-test",
          { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
        );

        expect(result).toMatchObject({ ok: false });
        expect(result.message).toContain("did not return a tool call");
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
        expect(fs.readFileSync(path.join(tmpDir, "request-2.json"), "utf8")).toContain(
          '"tool_choice":"required"',
        );
      } finally {
        process.env.PATH = originalPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("keeps retrying when initial timeout is followed by a transient 502", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-timeout-502-probe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const counter = path.join(tmpDir, "counter");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(counter, "0");
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
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
`,
        { mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      const originalNoSleep = process.env.NEMOCLAW_TEST_NO_SLEEP;
      const originalLog = console.log;
      const lines: string[] = [];
      process.env.PATH = `${fakeBin}:${originalPath || ""}`;
      process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = probeOpenAiLikeEndpoint(
          "https://integrate.api.nvidia.com/v1",
          "nvidia/nemotron-3-super-120b-a12b",
          "nvapi-test",
          { skipResponsesProbe: true },
        );

        expect(result).toMatchObject({ ok: true, api: "openai-completions" });
        expect(lines.join("\n")).toContain("HTTP 502");
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("3");
      } finally {
        console.log = originalLog;
        process.env.PATH = originalPath;
        if (originalNoSleep === undefined) {
          delete process.env.NEMOCLAW_TEST_NO_SLEEP;
        } else {
          process.env.NEMOCLAW_TEST_NO_SLEEP = originalNoSleep;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it("continues with openai-completions when DeepSeek V4 Pro stream validation times out", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepseek-probe-"));
    const fakeBin = path.join(tmpDir, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  : > "$outfile"
fi
printf '000'
exit 28
`,
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = console.log;
    const lines: string[] = [];
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    console.log = (...args) => lines.push(args.join(" "));
    try {
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
    } finally {
      console.log = originalLog;
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
