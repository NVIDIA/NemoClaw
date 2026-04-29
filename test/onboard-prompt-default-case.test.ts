// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

type RunResult = {
  result: boolean;
  logs: string[];
  promptCalls: string[];
  exitCode: number;
};

function runYesNoPrompt(spec: {
  question: string;
  envVar: string | null;
  defaultIsYes: boolean;
  mode: "non-interactive" | "interactive";
  envOverrides?: Record<string, string | undefined>;
  reply?: string;
}): RunResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-yesno-"));
  const scriptPath = path.join(tmpDir, "yesno.js");
  const outputPath = path.join(tmpDir, "out.json");
  const outputPathLiteral = JSON.stringify(outputPath);
  const argsLiteral = JSON.stringify({
    question: spec.question,
    envVar: spec.envVar,
    defaultIsYes: spec.defaultIsYes,
    reply: spec.reply ?? "",
  });

  // For the interactive path we monkey-patch credentials.prompt BEFORE
  // requiring onboard, so onboard's top-level destructure picks up the
  // mocked function instead of the real readline-backed prompt.
  const script = String.raw`
const fs = require("node:fs");
const credentials = require(${credentialsPath});
const args = ${argsLiteral};

const promptCalls = [];
credentials.prompt = async (message) => {
  promptCalls.push(message);
  return args.reply;
};

const onboard = require(${onboardPath});

const logs = [];
const originalLog = console.log;
console.log = (...parts) => logs.push(parts.join(" "));

(async () => {
  let result;
  try {
    result = await onboard.promptYesNoOrDefault(args.question, args.envVar, args.defaultIsYes);
  } finally {
    console.log = originalLog;
  }
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({ result, logs, promptCalls }));
})().catch((error) => {
  console.log = originalLog;
  console.error("UNEXPECTED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
});
`;
  fs.writeFileSync(scriptPath, script);

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: tmpDir,
    ...(spec.envOverrides ?? {}),
  };
  if (spec.mode === "non-interactive") {
    env.NEMOCLAW_NON_INTERACTIVE = "1";
  } else {
    delete env.NEMOCLAW_NON_INTERACTIVE;
  }

  const out = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `outcome missing. exit=${out.status}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Omit<RunResult, "exitCode">;
  return {
    ...payload,
    exitCode: typeof out.status === "number" ? out.status : -1,
  };
}

describe("promptYesNoOrDefault (non-interactive)", () => {
  it("uses default-yes and echoes '→ Y' for a [Y/n] prompt", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: null,
      defaultIsYes: true,
      mode: "non-interactive",
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.logs.some((line) => line.includes("[Y/n]: → Y"))).toBe(true);
  });

  it("uses default-no and echoes '→ N' for a [y/N] prompt", () => {
    const out = runYesNoPrompt({
      question: "  Continue anyway?",
      envVar: null,
      defaultIsYes: false,
      mode: "non-interactive",
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(false);
    expect(out.logs.some((line) => line.includes("[y/N]: → N"))).toBe(true);
  });

  it("respects an env-var override of 'yes' regardless of the default", () => {
    const out = runYesNoPrompt({
      question: "  Continue anyway?",
      envVar: "NEMOCLAW_TEST_YESNO",
      defaultIsYes: false,
      mode: "non-interactive",
      envOverrides: { NEMOCLAW_TEST_YESNO: "yes" },
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.logs.some((line) => line.includes("→ Y"))).toBe(true);
  });

  it("respects an env-var override of 'n' regardless of the default", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: "NEMOCLAW_TEST_YESNO",
      defaultIsYes: true,
      mode: "non-interactive",
      envOverrides: { NEMOCLAW_TEST_YESNO: "n" },
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(false);
    expect(out.logs.some((line) => line.includes("→ N"))).toBe(true);
  });

  it("falls back to the default when the env var holds an empty string", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: "NEMOCLAW_TEST_YESNO",
      defaultIsYes: true,
      mode: "non-interactive",
      envOverrides: { NEMOCLAW_TEST_YESNO: "" },
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.logs.some((line) => line.includes("→ Y"))).toBe(true);
  });

  it("falls back to the default when the env var holds an unknown value", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: "NEMOCLAW_TEST_YESNO",
      defaultIsYes: true,
      mode: "non-interactive",
      envOverrides: { NEMOCLAW_TEST_YESNO: "maybe" },
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.logs.some((line) => line.includes("→ Y"))).toBe(true);
  });

  it("constructs the indicator from defaultIsYes (not from the question)", () => {
    // The same question with opposite defaults must show opposite indicators.
    const yesDefault = runYesNoPrompt({
      question: "  Proceed?",
      envVar: null,
      defaultIsYes: true,
      mode: "non-interactive",
    });
    const noDefault = runYesNoPrompt({
      question: "  Proceed?",
      envVar: null,
      defaultIsYes: false,
      mode: "non-interactive",
    });
    expect(yesDefault.logs.some((line) => line.includes("Proceed? [Y/n]: → Y"))).toBe(true);
    expect(noDefault.logs.some((line) => line.includes("Proceed? [y/N]: → N"))).toBe(true);
  });
});

describe("promptYesNoOrDefault (interactive)", () => {
  it("falls back to the default when the user just presses Enter", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: null,
      defaultIsYes: true,
      mode: "interactive",
      reply: "",
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.promptCalls).toEqual(["  Apply this configuration? [Y/n]: "]);
  });

  it("returns true when the user types 'y', overriding a default-no", () => {
    const out = runYesNoPrompt({
      question: "  Continue anyway?",
      envVar: null,
      defaultIsYes: false,
      mode: "interactive",
      reply: "y",
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(true);
    expect(out.promptCalls).toEqual(["  Continue anyway? [y/N]: "]);
  });

  it("returns false when the user types 'n', overriding a default-yes", () => {
    const out = runYesNoPrompt({
      question: "  Apply this configuration?",
      envVar: null,
      defaultIsYes: true,
      mode: "interactive",
      reply: "n",
    });
    expect(out.exitCode).toBe(0);
    expect(out.result).toBe(false);
    expect(out.promptCalls).toEqual(["  Apply this configuration? [Y/n]: "]);
  });
});
