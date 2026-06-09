// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  isHijackedDockerInternalUrl,
} = require("../../../dist/lib/inference/onboard-host-docker-internal");
const {
  isSandboxInternalUrl,
  probeOpenAiLikeEndpoint,
} = require("../../../dist/lib/inference/onboard-probes");

describe("host.docker.internal onboarding inference policy", () => {
  it("does not treat host.docker.internal as a usable sandbox URL", () => {
    expect(isSandboxInternalUrl("http://host.docker.internal:11434/v1")).toBe(false);
    expect(isHijackedDockerInternalUrl("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isHijackedDockerInternalUrl("http://host.openshell.internal:11435/v1")).toBe(false);
    expect(isHijackedDockerInternalUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("rejects host.docker.internal URLs with an actionable proxy hint (#3136)", () => {
    const result = probeOpenAiLikeEndpoint(
      "http://host.docker.internal:11434/v1",
      "openai/nemotron-mini",
      "",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.docker\.internal/);
    expect(result.message).toMatch(/host\.openshell\.internal:11435/);
    expect(result.failures).toEqual([
      expect.objectContaining({ name: "host.docker.internal reachability" }),
    ]);
  });

  it("rejects host.docker.internal even when strict chat-completions tool calling is required", () => {
    const result = probeOpenAiLikeEndpoint(
      "http://host.docker.internal:11434/v1",
      "openai/nemotron-mini",
      "",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/host\.docker\.internal/);
    expect(result.message).toMatch(/host\.openshell\.internal:11435/);
  });

  it("allows explicit Windows-host Ollama validation to probe host.docker.internal", () => {
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
        {
          skipResponsesProbe: true,
          requireChatCompletionsToolCalling: true,
          allowHostDockerInternal: true,
        },
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
});
