// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REDACT_GATEWAY_LOG = path.join(process.cwd(), "test/e2e/lib/redact-openclaw-gateway-log.sh");

describe("OpenClaw gateway log redaction", () => {
  it("redacts live-job secrets, auth headers, token URL fragments, and prompt text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-redact-"));
    const source = path.join(tmp, "gateway.log");
    const output = path.join(tmp, "gateway.redacted.log");
    const env = {
      ...process.env,
      NVIDIA_INFERENCE_API_KEY: "nvapi-live-secret-from-env",
      COMPATIBLE_API_KEY: "compatible-live-secret-from-env",
      GITHUB_TOKEN: "ghp_live_secret_from_env",
      OPENCLAW_GATEWAY_AUTH_TOKEN: "gateway-live-secret-from-env",
    };
    fs.writeFileSync(
      source,
      [
        "NVIDIA_INFERENCE_API_KEY=nvapi-live-secret-from-env",
        "COMPATIBLE_API_KEY=compatible-live-secret-from-env",
        "GITHUB_TOKEN=ghp_live_secret_from_env",
        "gateway token gateway-live-secret-from-env",
        "Authorization: Bearer bearer-secret-token",
        "api-key: raw-api-key-token",
        "GET /v1/chat?gateway_token=url-token-secret&other=1",
        'prompt: "show me sensitive prompt text"',
        "content=assistant reply text",
        "standalone fallback nvapi-pattern-secret ghp_pattern_secret",
      ].join("\n"),
      "utf8",
    );

    execFileSync("bash", [REDACT_GATEWAY_LOG, source, output], { env, stdio: "pipe" });

    const redacted = fs.readFileSync(output, "utf8");
    expect(redacted).toContain("[REDACTED_NVIDIA_INFERENCE_API_KEY]");
    expect(redacted).toContain("[REDACTED_COMPATIBLE_API_KEY]");
    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("[REDACTED_OPENCLAW_GATEWAY_AUTH_TOKEN]");
    expect(redacted).toContain("Authorization: [REDACTED_AUTHORIZATION]");
    expect(redacted).toContain("api-key: [REDACTED_API_KEY]");
    expect(redacted).toContain("gateway_token=[REDACTED_TOKEN]");
    expect(redacted).toContain("prompt: [REDACTED_TEXT]");
    expect(redacted).toContain("content=[REDACTED_TEXT]");

    for (const leaked of [
      "nvapi-live-secret-from-env",
      "compatible-live-secret-from-env",
      "ghp_live_secret_from_env",
      "gateway-live-secret-from-env",
      "bearer-secret-token",
      "raw-api-key-token",
      "url-token-secret",
      "sensitive prompt text",
      "assistant reply text",
      "nvapi-pattern-secret",
      "ghp_pattern_secret",
    ]) {
      expect(redacted).not.toContain(leaked);
    }
  });
});
