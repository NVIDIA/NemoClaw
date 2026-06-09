// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const BRAVE_VALIDATION_TEST_TIMEOUT_MS = testTimeout(60_000);

type ConfigureWebSearchOutcome = {
  result: { fetchEnabled: boolean } | null;
  exitCalls: number[];
  logs: string[];
  warnings: string[];
  errors: string[];
};

function setupBraveCurlShim(
  fakeBin: string,
  spec: { status: string; body: string; forbiddenArg?: string },
): void {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
outfile=""
forbidden=${JSON.stringify(spec.forbiddenArg ?? "")}
for arg in "$@"; do
  case "$arg" in
    *"$forbidden"*)
      if [ -n "$forbidden" ]; then
        echo "secret leaked through curl argv" >&2
        exit 66
      fi
      ;;
  esac
done
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' ${JSON.stringify(spec.body)} > "$outfile"
printf '%s' '${spec.status}'
`,
    { mode: 0o755 },
  );
}

function runConfigureWebSearch(spec: { status: string; body: string; apiKey: string }): {
  exitCode: number;
  payload: ConfigureWebSearchOutcome;
  stderr: string;
} {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "configure-web-search.js");
  const outputPath = path.join(tmpDir, "outcome.json");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const outputPathLiteral = JSON.stringify(outputPath);

  setupBraveCurlShim(fakeBin, {
    status: spec.status,
    body: spec.body,
    forbiddenArg: spec.apiKey,
  });

  const script = String.raw`
const fs = require("node:fs");
const { configureWebSearch } = require(${onboardPath});

const exitCalls = [];
const logs = [];
const warnings = [];
const errors = [];
const originalExit = process.exit;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
process.exit = ((code) => {
  exitCalls.push(typeof code === "number" ? code : 0);
});
console.log = (...args) => logs.push(args.join(" "));
console.warn = (...args) => warnings.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));

function restore() {
  process.exit = originalExit;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

(async () => {
  let result = null;
  try {
    result = await configureWebSearch(null);
  } finally {
    restore();
  }
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({ result, exitCalls, logs, warnings, errors }));
})().catch((error) => {
  restore();
  console.error("UNEXPECTED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_NON_INTERACTIVE: "1",
      BRAVE_API_KEY: spec.apiKey,
    },
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `Outcome file missing. exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as ConfigureWebSearchOutcome;
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    payload,
    stderr: result.stderr ?? "",
  };
}

function runInteractiveConfigureWebSearch(spec: { answers: string[] }): {
  exitCode: number;
  payload: {
    outcome: "completed" | "exit";
    result?: { fetchEnabled: boolean } | null;
    exitCode?: number;
    logs: string[];
    errors: string[];
    prompts: Array<{ message: string; secret: boolean }>;
    saved: Array<{ key: string; value: string }>;
    braveKey: string | null;
  };
  stderr: string;
} {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-interactive-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "configure-web-search-interactive.js");
  const outputPath = path.join(tmpDir, "outcome.json");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
  );
  const outputPathLiteral = JSON.stringify(outputPath);

  setupBraveCurlShim(fakeBin, { status: "200", body: '{"web":{"results":[]}}' });

  const script = String.raw`
const fs = require("node:fs");

const clearEnv = [
  "BRAVE_API_KEY",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_YES",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_EXPERIMENTAL",
];
for (const key of clearEnv) {
  delete process.env[key];
}

const credentials = require(${credentialsPath});
const answers = ${JSON.stringify(spec.answers)};
const logs = [];
const errors = [];
const prompts = [];
const saved = [];

credentials.prompt = async (message, opts = {}) => {
  prompts.push({ message, secret: opts.secret === true });
  return answers.shift() || "";
};
const originalSaveCredential = credentials.saveCredential;
credentials.saveCredential = (key, value) => {
  saved.push({ key, value });
  return originalSaveCredential(key, value);
};

const { configureWebSearch } = require(${onboardPath});
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
process.exit = (code) => {
  const error = new Error("process.exit:" + code);
  error.exitCode = code;
  throw error;
};
console.log = (...args) => logs.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));

function writePayload(payload) {
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({
    ...payload,
    logs,
    errors,
    prompts,
    saved,
    braveKey: process.env.BRAVE_API_KEY || null,
  }));
}

(async () => {
  try {
    const result = await configureWebSearch(null);
    writePayload({ outcome: "completed", result });
  } catch (error) {
    if (error && error.exitCode !== undefined) {
      writePayload({ outcome: "exit", exitCode: error.exitCode });
      return;
    }
    throw error;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  console.error("UNEXPECTED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
    },
    timeout: BRAVE_VALIDATION_TEST_TIMEOUT_MS,
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `Outcome file missing. exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    payload: JSON.parse(fs.readFileSync(outputPath, "utf-8")),
    stderr: result.stderr ?? "",
  };
}

describe("configureWebSearch (non-interactive)", () => {
  it("skips unsupported Hermes without prompting for Brave", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-web-search-prompt-"));
    const scriptPath = path.join(tmpDir, "web-search-prompt-check.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const agentDefsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "agent", "defs.js"));

    const script = `
let promptCalls = 0;
const actualCredentials = require(${credentialsPath});
const mockedCredentials = {
  ...actualCredentials,
  prompt: async () => {
    promptCalls += 1;
    throw new Error("prompt should not be called");
  },
};
require.cache[require.resolve(${credentialsPath})] = {
  id: require.resolve(${credentialsPath}),
  filename: require.resolve(${credentialsPath}),
  loaded: true,
  exports: mockedCredentials,
};
process.env.BRAVE_API_KEY = "brv-test-key";
const { configureWebSearch } = require(${onboardPath});
const { loadAgent } = require(${agentDefsPath});

(async () => {
  const result = await configureWebSearch(null, loadAgent("hermes"));
  console.log(JSON.stringify({ result, promptCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
        },
      });
      expect(result.status).toBe(0);
      const line = result.stdout.trim().split("\n").pop();
      expect(line).toBeTruthy();
      const payload = JSON.parse(line || "{}");
      expect(payload.result).toBeNull();
      expect(payload.promptCalls).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses a saved Brave credential in non-interactive mode", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-saved-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "configure-web-search-saved.js");
    const outputPath = path.join(tmpDir, "outcome.json");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    setupBraveCurlShim(fakeBin, { status: "200", body: '{"web":{"results":[]}}' });
    fs.writeFileSync(
      scriptPath,
      `
const fs = require("node:fs");
const actualCredentials = require(${credentialsPath});
const mockedCredentials = {
  ...actualCredentials,
  getCredential: (key) => (key === "BRAVE_API_KEY" ? "saved-brave-key" : actualCredentials.getCredential(key)),
};
require.cache[require.resolve(${credentialsPath})] = {
  id: require.resolve(${credentialsPath}),
  filename: require.resolve(${credentialsPath}),
  loaded: true,
  exports: mockedCredentials,
};
delete process.env.BRAVE_API_KEY;
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
const { configureWebSearch } = require(${onboardPath});
(async () => {
  const result = await configureWebSearch(null);
  fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ result, braveKey: process.env.BRAVE_API_KEY || null }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(payload.result).toEqual({ fetchEnabled: true });
      expect(payload.braveKey).toBe("saved-brave-key");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips Brave Web Search and returns null when key validation hits HTTP 429", () => {
    const { exitCode, payload } = runConfigureWebSearch({
      status: "429",
      body:
        '{"type":"ErrorResponse","error":{"id":"abc","status":429,' +
        '"detail":"Request rate limit exceeded for plan",' +
        '"meta":{"plan":"Free","rate_limit":1,"rate_current":1}}}',
      apiKey: "fake-rate-limited-key",
    });

    expect(exitCode).toBe(0);
    expect(payload.exitCalls).toEqual([]);
    expect(payload.result).toBeNull();
    expect(payload.errors).toEqual([]);
    expect(
      payload.warnings.some((line) => line.includes("Brave Search API key validation failed")),
    ).toBe(true);
    expect(payload.warnings.some((line) => line.includes("nemoclaw config web-search"))).toBe(true);
  });

  it("enables Brave Web Search when validation succeeds", () => {
    const { exitCode, payload } = runConfigureWebSearch({
      status: "200",
      body: '{"web":{"results":[]}}',
      apiKey: "fake-valid-key",
    });

    expect(exitCode).toBe(0);
    expect(payload.exitCalls).toEqual([]);
    expect(payload.result).toEqual({ fetchEnabled: true });
  });
});

describe("configureWebSearch (interactive)", () => {
  it("returns to the Brave Search enable prompt when backing out of the API key prompt", () => {
    const { exitCode, payload } = runInteractiveConfigureWebSearch({
      answers: ["y", "back", "n"],
    });

    expect(exitCode).toBe(0);
    expect(payload.outcome).toBe("completed");
    expect(payload.result).toBeNull();
    expect(payload.braveKey).toBeNull();
    expect(payload.errors).toEqual([]);
    expect(payload.saved.every((entry) => entry.value !== "back")).toBe(true);
    expect(
      payload.prompts.filter((entry) => /Enable Brave Web Search\?/.test(entry.message)),
    ).toHaveLength(2);
    expect(
      payload.prompts.some((entry) => /Brave Search API key: /.test(entry.message) && entry.secret),
    ).toBe(true);
  });

  it("exits from the Brave Search API key prompt", () => {
    const { exitCode, payload } = runInteractiveConfigureWebSearch({
      answers: ["y", "exit"],
    });

    expect(exitCode).toBe(0);
    expect(payload.outcome).toBe("exit");
    expect(payload.exitCode).toBe(1);
    expect(payload.braveKey).toBeNull();
    expect(payload.saved).toEqual([]);
    expect(payload.logs.some((line) => line.includes("Exiting onboarding."))).toBe(true);
  });
});
