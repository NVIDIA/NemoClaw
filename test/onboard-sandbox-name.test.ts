// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAgent } from "../dist/lib/agent/defs.js";
import {
  getNameValidationGuidance,
  NAME_ALLOWED_FORMAT,
  suggestNameSlug,
} from "../dist/lib/name-validation.js";

const {
  getDefaultSandboxNameForAgent,
  getRequestedSandboxAgentName,
  getSandboxPromptDefault,
  normalizeSandboxAgentName,
} = require("../dist/lib/onboard") as {
  getDefaultSandboxNameForAgent: (agent?: { name: string } | null) => string;
  getRequestedSandboxAgentName: (agent?: { name: string } | null) => string;
  getSandboxPromptDefault: (agent?: { name: string } | null) => string;
  normalizeSandboxAgentName: (agentName?: string | null) => string;
};

describe("onboard sandbox naming helpers", () => {
  it("uses Hermes-oriented sandbox defaults when NemoHermes selects Hermes", () => {
    const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
      const hermes = loadAgent("hermes");
      expect(getRequestedSandboxAgentName(null)).toBe("openclaw");
      expect(normalizeSandboxAgentName(null)).toBe("openclaw");
      expect(getDefaultSandboxNameForAgent(null)).toBe("my-assistant");
      expect(getDefaultSandboxNameForAgent(hermes)).toBe("hermes");
      expect(getSandboxPromptDefault(hermes)).toBe("hermes");

      process.env.NEMOCLAW_SANDBOX_NAME = "custom-hermes";
      expect(getSandboxPromptDefault(hermes)).toBe("custom-hermes");
    } finally {
      if (previousSandboxName === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previousSandboxName;
      }
    }
  });

  it("uses NEMOCLAW_SANDBOX_NAME as the interactive prompt default", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "mythos";
      expect(getSandboxPromptDefault(null)).toBe("mythos");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("falls back to agent default when NEMOCLAW_SANDBOX_NAME is invalid", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "123-leading-digit-invalid";
      expect(getSandboxPromptDefault(null)).toBe("my-assistant");

      process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
      expect(getSandboxPromptDefault(null)).toBe("my-assistant");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("exposes the full allowed sandbox name format", () => {
    expect(NAME_ALLOWED_FORMAT).toBe(
      "1-63 characters, lowercase, starts with a letter, letters/numbers/internal hyphens only, ends with letter/number",
    );
  });

  it("explains sandbox name length and allowed format violations", () => {
    expect(getNameValidationGuidance("sandbox name", "a".repeat(64))).toEqual([
      "Sandbox names must be 63 characters or fewer.",
      `Allowed format: ${NAME_ALLOWED_FORMAT}.`,
      `Try: ${"a".repeat(63)}`,
    ]);
    expect(
      getNameValidationGuidance("sandbox name", "bad name", { includeAllowedFormat: false }),
    ).toEqual(["Sandbox names cannot contain spaces.", "Try: bad-name"]);
  });

  describe("suggestNameSlug", () => {
    it("lowercases mixed-case input", () => {
      expect(suggestNameSlug("MyAssistant")).toBe("myassistant");
    });

    it("replaces spaces and other illegal characters with hyphens", () => {
      expect(suggestNameSlug("bad name")).toBe("bad-name");
      expect(suggestNameSlug("My Project Sandbox")).toBe("my-project-sandbox");
      expect(suggestNameSlug("agent_007")).toBe("agent-007");
    });

    it("collapses runs of hyphens and trims terminal hyphens", () => {
      expect(suggestNameSlug("--legacy--")).toBe("legacy");
      expect(suggestNameSlug("foo  bar")).toBe("foo-bar");
    });

    it("returns null for inputs that are already valid even with internal hyphen runs", () => {
      expect(suggestNameSlug("a---b")).toBeNull();
    });

    it("prefixes 's-' when the slug would otherwise start with a digit", () => {
      expect(suggestNameSlug("123-leading")).toBe("s-123-leading");
      expect(suggestNameSlug("9lives")).toBe("s-9lives");
    });

    it("truncates over-length inputs to the max name length", () => {
      const slug = suggestNameSlug("a".repeat(80));
      expect(slug).toBe("a".repeat(63));
      expect(slug!.length).toBe(63);
    });

    it("returns null when the input is already a valid name", () => {
      expect(suggestNameSlug("my-assistant")).toBeNull();
      expect(suggestNameSlug("openclaw")).toBeNull();
    });

    it("returns null when no recoverable slug can be derived", () => {
      expect(suggestNameSlug("")).toBeNull();
      expect(suggestNameSlug("---")).toBeNull();
      expect(suggestNameSlug("!!!")).toBeNull();
    });
  });

  it("rejects --name MyAssistant at the onboard boundary and prints Try: myassistant", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-bad-name-"));
    const scriptPath = path.join(tmpDir, "onboard-bad-name.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    const script = String.raw`
const onboardModule = require(${onboardPath});

(async () => {
  const lines = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = (...args) => lines.push(args.join(" "));
  process.exit = (code) => {
    const error = new Error("process.exit:" + code);
    error.exitCode = code;
    throw error;
  };
  let exitCode = null;
  try {
    await onboardModule.onboard({ sandboxName: "MyAssistant", nonInteractive: true });
    process.stdout.write(JSON.stringify({ completed: true, exitCode, lines }));
  } catch (error) {
    exitCode = error.exitCode ?? null;
    process.stdout.write(
      JSON.stringify({ completed: false, exitCode, lines, message: error.message }),
    );
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
})().catch((error) => {
  process.stderr.write(error.stack || String(error));
  process.exit(2);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.completed, false);
    assert.equal(payload.exitCode, 1);
    assert.ok(
      payload.lines.some((line: string) => line.includes("Invalid sandbox name: 'MyAssistant'.")),
      `expected 'Invalid sandbox name' line, got ${JSON.stringify(payload.lines)}`,
    );
    assert.ok(
      payload.lines.some((line: string) => line.trim() === "Try: myassistant"),
      `expected standalone 'Try: myassistant' line, got ${JSON.stringify(payload.lines)}`,
    );
  });
});
