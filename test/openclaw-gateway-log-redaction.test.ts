// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REDACT_GATEWAY_LOG = path.join(process.cwd(), "test/e2e/lib/redact-openclaw-gateway-log.sh");
const EXPORT_REDACTED_GATEWAY_LOG = path.join(
  process.cwd(),
  "test/e2e/lib/export-redacted-openclaw-gateway-log.sh",
);

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

  it("redacts structured JSON authorization, api-key, token, and message fields", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-json-redact-"));
    const source = path.join(tmp, "gateway.jsonl");
    const output = path.join(tmp, "gateway.redacted.jsonl");
    fs.writeFileSync(
      source,
      JSON.stringify({
        Authorization: "Bearer bearer-secret-token",
        "api-key": "raw-api-key-token",
        gateway_token: "url-token-secret",
        message: "sensitive prompt text",
        content: "assistant reply text",
      }),
      "utf8",
    );

    execFileSync("bash", [REDACT_GATEWAY_LOG, source, output], { stdio: "pipe" });

    const redacted = fs.readFileSync(output, "utf8");
    expect(redacted).toContain('"Authorization":"[REDACTED_AUTHORIZATION]"');
    expect(redacted).toContain('"api-key":"[REDACTED_API_KEY]"');
    expect(redacted).toContain('"gateway_token":"[REDACTED_TOKEN]"');
    expect(redacted).toContain('"message":"[REDACTED_TEXT]"');
    expect(redacted).toContain('"content":"[REDACTED_TEXT]"');

    for (const leaked of [
      "bearer-secret-token",
      "raw-api-key-token",
      "url-token-secret",
      "sensitive prompt text",
      "assistant reply text",
    ]) {
      expect(redacted).not.toContain(leaked);
    }
  });

  it("redacts JSON message/content/text strings containing escaped quotes and trailing sensitive text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-escaped-redact-"));
    const source = path.join(tmp, "gateway.jsonl");
    const output = path.join(tmp, "gateway.redacted.jsonl");
    fs.writeFileSync(
      source,
      JSON.stringify({
        message: 'secret before "quoted" secret after',
        text: 'nested text before "quoted" nested text after',
      }),
      "utf8",
    );

    execFileSync("bash", [REDACT_GATEWAY_LOG, source, output], { stdio: "pipe" });

    const redacted = fs.readFileSync(output, "utf8");
    expect(redacted).toContain('"message":"[REDACTED_TEXT]"');
    expect(redacted).toContain('"text":"[REDACTED_TEXT]"');
    for (const leaked of [
      "secret before",
      "quoted",
      "secret after",
      "nested text before",
      "nested text after",
    ]) {
      expect(redacted).not.toContain(leaked);
    }
  });

  it("redacts nested OpenClaw message.content text before gateway log upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-nested-redact-"));
    const source = path.join(tmp, "gateway.jsonl");
    const output = path.join(tmp, "gateway.redacted.jsonl");
    fs.writeFileSync(
      source,
      JSON.stringify({
        event: "chat",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "nested sensitive prompt text" }],
        },
      }),
      "utf8",
    );

    execFileSync("bash", [REDACT_GATEWAY_LOG, source, output], { stdio: "pipe" });

    const redacted = fs.readFileSync(output, "utf8");
    expect(redacted).toContain('"text":"[REDACTED_TEXT]"');
    expect(redacted).not.toContain("nested sensitive prompt text");
  });

  it("real redactor exits non-zero and removes destination artifact on internal failures", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-real-fail-"));
    const source = path.join(tmp, "gateway.log");
    const outputDir = path.join(tmp, "missing-output-dir");
    const output = path.join(outputDir, "gateway.redacted.log");
    fs.writeFileSync(source, "Authorization: Bearer raw-token\n", "utf8");

    const result = spawnSync("bash", [REDACT_GATEWAY_LOG, source, output], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("passes the in-sandbox gateway auth token into the redactor before upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-sandbox-token-"));
    const output = path.join(tmp, "gateway.redacted.log");
    const sandboxToken = "sandbox-gateway-token-from-openclaw-json";

    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [[ "$*" == *"openclaw.json"* ]]; then
  printf '%s' '${sandboxToken}'
else
  printf 'free-form sandbox gateway token: ${sandboxToken}\\n'
fi
`,
      "utf8",
    );
    fs.chmodSync(path.join(fakeBin, "openshell"), 0o755);

    const result = spawnSync("bash", [EXPORT_REDACTED_GATEWAY_LOG, "sandbox", output], {
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_AUTH_TOKEN: "",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const redacted = fs.readFileSync(output, "utf8");
    expect(redacted).toContain("[REDACTED_OPENCLAW_GATEWAY_AUTH_TOKEN]");
    expect(redacted).not.toContain(sandboxToken);
  });

  it("clears stale upload artifacts before early pre-Vitest wrapper failures", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-clear-"));
    const output = path.join(tmp, "gateway.redacted.log");
    const staleRaw = path.join(tmp, "gateway.redacted.log.raw.ABCDEF");
    const staleTmp = path.join(tmp, "gateway.redacted.log.tmp.ABCDEF");
    fs.writeFileSync(output, "stale raw secret artifact", "utf8");
    fs.writeFileSync(staleRaw, "stale raw sandbox log", "utf8");
    fs.writeFileSync(staleTmp, "stale partially redacted log", "utf8");

    const result = spawnSync("bash", [EXPORT_REDACTED_GATEWAY_LOG, "--clear", output], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(staleRaw)).toBe(false);
    expect(fs.existsSync(staleTmp)).toBe(false);
  });

  it("removes stale output and raw logs when redaction fails", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-log-fail-closed-"));
    const output = path.join(tmp, "gateway.redacted.log");
    const redactor = path.join(tmp, "failing-redactor.sh");
    fs.writeFileSync(output, "stale secret artifact", "utf8");
    fs.writeFileSync(
      redactor,
      "#!/usr/bin/env bash\ncat >\"$2\" <<'EOF'\nraw leaked diagnostic\nEOF\nexit 1\n",
      "utf8",
    );
    fs.chmodSync(redactor, 0o755);

    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      "#!/usr/bin/env bash\nprintf 'Authorization: Bearer raw-token-from-sandbox\\n'\n",
      "utf8",
    );
    fs.chmodSync(path.join(fakeBin, "openshell"), 0o755);

    const result = spawnSync("bash", [EXPORT_REDACTED_GATEWAY_LOG, "sandbox", output, redactor], {
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
    expect(
      fs.readdirSync(tmp).filter((entry) => entry.includes("gateway.redacted.log.raw")),
    ).toEqual([]);
  });
});
