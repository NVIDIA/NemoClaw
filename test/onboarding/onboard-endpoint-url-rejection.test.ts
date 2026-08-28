// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

describe("custom endpoint URL component rejection", () => {
  it("rejects a query-bearing NEMOCLAW_ENDPOINT_URL instead of silently stripping it (#9106)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-endpoint-url-rejection-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
printf '000'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

Object.assign(process.env, {
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_PROVIDER: "custom",
  NEMOCLAW_ENDPOINT_URL: "http://127.0.0.1:8000/v1/custom-path?param=value",
  NEMOCLAW_MODEL: "mock-model",
  NEMOCLAW_COMPATIBLE_AUTH_MODE: "none",
  NEMOCLAW_PREFERRED_API: "chat-completions",
});

const originalLog = console.log;
console.log = () => {};
process.exit = (code) => {
  throw Object.assign(new Error("exit"), { code });
};

setupNim(null).then(
  () => {
    originalLog(JSON.stringify({ resolved: true }));
  },
  (error) => {
    originalLog(JSON.stringify({ exitCode: error.code }));
  },
);
`,
    );

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { exitCode: 1 });
      assert.match(
        result.stderr,
        /Endpoint URL must not contain userinfo, query, or fragment components\./,
      );
      assert.match(result.stderr, /Use: http:\/\/127\.0\.0\.1:8000\/v1\/custom-path/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "shell metacharacters",
      "http://127.0.0.1:8000/v1$(id)",
      /Endpoint URL must contain only URL-safe ASCII characters\./,
    ],
    [
      "percent-encoded control characters",
      "http://127.0.0.1:8000/v1%0ainjected",
      /Endpoint URL must not contain percent-encoded control characters\./,
    ],
    [
      "a leading tab",
      "\thttp://127.0.0.1:8000/v1",
      /Endpoint URL must not contain control characters\./,
    ],
    [
      "a trailing tab",
      "http://127.0.0.1:8000/v1\t",
      /Endpoint URL must not contain control characters\./,
    ],
    [
      "a leading newline",
      "\nhttp://127.0.0.1:8000/v1",
      /Endpoint URL must not contain control characters\./,
    ],
    [
      "a trailing newline",
      "http://127.0.0.1:8000/v1\n",
      /Endpoint URL must not contain control characters\./,
    ],
    [
      "a leading no-break space",
      "\u00a0http://127.0.0.1:8000/v1",
      /Endpoint URL must contain only URL-safe ASCII characters\./,
    ],
    [
      "a trailing paragraph separator",
      "http://127.0.0.1:8000/v1\u2029",
      /Endpoint URL must contain only URL-safe ASCII characters\./,
    ],
  ] as const)(
    "rejects an unsafe NEMOCLAW_ENDPOINT_URL with %s before any network request or state write (#9301)",
    (_label, endpointUrl, expectedMessage) => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-endpoint-url-unsafe-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "check.js");
      const curlMarkerPath = path.join(tmpDir, "curl-invoked");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
touch "${curlMarkerPath}"
printf '000'
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        scriptPath,
        String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

Object.assign(process.env, {
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_PROVIDER: "custom",
  NEMOCLAW_ENDPOINT_URL: ${JSON.stringify(endpointUrl)},
  NEMOCLAW_MODEL: "mock-model",
  NEMOCLAW_COMPATIBLE_AUTH_MODE: "none",
  NEMOCLAW_PREFERRED_API: "chat-completions",
});

const originalLog = console.log;
console.log = () => {};
process.exit = (code) => {
  throw Object.assign(new Error("exit"), { code });
};

setupNim(null).then(
  () => {
    originalLog(JSON.stringify({ resolved: true }));
  },
  (error) => {
    originalLog(JSON.stringify({ exitCode: error.code }));
  },
);
`,
      );

      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout.trim()), { exitCode: 1 });
        assert.match(result.stderr, expectedMessage);
        // The rejection must not echo the unsafe input back to the terminal,
        // including through JSON-style escaping of control characters.
        assert.ok(!result.stderr.includes(endpointUrl));
        assert.ok(!result.stderr.includes(JSON.stringify(endpointUrl).slice(1, -1)));
        // The QA contract (#9301): rejection fires before any network request
        // or persistent state write, so the environment stays unchanged.
        assert.ok(!fs.existsSync(curlMarkerPath));
        const writtenStateFiles = (
          fs.readdirSync(tmpDir, { recursive: true }) as string[]
        ).filter((entry) => /onboard-session\.json|sandboxes\.json/.test(String(entry)));
        assert.deepEqual(writtenStateFiles, []);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("re-prompts after rejecting a query-bearing endpoint URL in interactive mode (#9106)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-endpoint-url-reprompt-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reprompt-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
printf '000'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      scriptPath,
      String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["4", "https://proxy.example.com/v1/custom-path?param=value#frag", "4", "exit"];
const messages = [];
credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

const originalLog = console.log;
const originalError = console.error;
const lines = [];
console.log = (...args) => lines.push(args.join(" "));
console.error = (...args) => lines.push(args.join(" "));
process.exit = (code) => {
  throw Object.assign(new Error("exit"), { code });
};

setupNim(null).then(
  () => {
    originalLog(JSON.stringify({ resolved: true, lines, messages }));
  },
  (error) => {
    originalLog(JSON.stringify({ exitCode: error.code, lines, messages }));
  },
);
`,
    );

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      });
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.exitCode, 1);
      assert.ok(
        payload.lines.some((line: string) =>
          line.includes("Endpoint URL must not contain userinfo, query, or fragment components."),
        ),
      );
      assert.ok(
        payload.lines.some((line: string) =>
          line.includes("Use: https://proxy.example.com/v1/custom-path"),
        ),
      );
      assert.ok(payload.lines.every((line: string) => !line.includes("param=value")));
      assert.ok(payload.lines.every((line: string) => !line.includes("#frag")));
      assert.equal(
        payload.messages.filter((message: string) => /OpenAI-compatible base URL/.test(message))
          .length,
        2,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
