// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the NEMOCLAW_* env-var documentation gate (#3184).
 *
 * Covers AST extraction (property/element access, assignments excluded,
 * non-NEMOCLAW vars excluded), allowlist parsing/validation, doc cross-check,
 * and stale-allowlist detection.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditEnvVarDocs,
  findDocumentedVars,
  findEnvVarReads,
  loadAllowlist,
  walkSourceFiles,
} from "../scripts/check-env-var-docs";

describe("findEnvVarReads", () => {
  it.each([
    ["const x = process.env.NEMOCLAW_FOO;", ["NEMOCLAW_FOO"]],
    ['const x = process.env["NEMOCLAW_FOO"];', ["NEMOCLAW_FOO"]],
    ["if (!process.env.NEMOCLAW_BAR) {}", ["NEMOCLAW_BAR"]],
    [
      "const { NEMOCLAW_FOO, NEMOCLAW_BAR: bar, PATH: NEMOCLAW_NOT_REAL } = process.env;",
      ["NEMOCLAW_BAR", "NEMOCLAW_FOO"],
    ],
    ["const x = process.env.NEMOCLAW_FOO ?? process.env.NEMOCLAW_BAR;", ["NEMOCLAW_BAR", "NEMOCLAW_FOO"]],
  ])("extracts %s", (code, expected) => {
    expect([...findEnvVarReads(code)].sort()).toEqual(expected);
  });

  it.each([
    "process.env.NEMOCLAW_FOO = 'x';",
    "delete process.env.NEMOCLAW_FOO;",
    "process.env['NEMOCLAW_FOO'] = '1';",
  ])("ignores assignment/delete %s", (code) => {
    expect([...findEnvVarReads(code)]).toEqual([]);
  });

  it.each([
    "const x = process.env.PATH;",
    "const x = process.env.HOME;",
    "const x = process.env.NVIDIA_API_KEY;",
    "const x = process.env.BRAVE_API_KEY;",
    "const x = process.env.TELEGRAM_BOT_TOKEN;",
  ])("ignores non-NEMOCLAW var %s", (code) => {
    expect([...findEnvVarReads(code)]).toEqual([]);
  });

  it("ignores dynamic element access with identifiers", () => {
    expect([...findEnvVarReads("const x = process.env[someKey];")]).toEqual([]);
  });

  it("ignores reads inside comments", () => {
    const code = `
      // const x = process.env.NEMOCLAW_FAKE;
      /* process.env.NEMOCLAW_ALSO_FAKE */
      const real = process.env.NEMOCLAW_REAL;
    `;
    expect([...findEnvVarReads(code)]).toEqual(["NEMOCLAW_REAL"]);
  });
});

describe("findDocumentedVars", () => {
  it("extracts every NEMOCLAW_* mention from the doc", () => {
    const md = `
      | \`NEMOCLAW_GATEWAY_PORT\` | 8080 | Gateway |
      Set \`NEMOCLAW_DASHBOARD_PORT=19000\`.
      And NEMOCLAW_OLLAMA_PULL_TIMEOUT raises the wall-clock limit.
    `;
    expect([...findDocumentedVars(md)].sort()).toEqual([
      "NEMOCLAW_DASHBOARD_PORT",
      "NEMOCLAW_GATEWAY_PORT",
      "NEMOCLAW_OLLAMA_PULL_TIMEOUT",
    ]);
  });

  it("returns empty for a doc with no env vars", () => {
    expect([...findDocumentedVars("# Just headings, no vars")]).toEqual([]);
  });
});

describe("loadAllowlist", () => {
  it("parses valid entries", () => {
    const json = JSON.stringify([
      { name: "NEMOCLAW_TEST_VAR", reason: "test sentinel set by Vitest setup" },
    ]);
    expect(loadAllowlist(json)).toEqual([
      { name: "NEMOCLAW_TEST_VAR", reason: "test sentinel set by Vitest setup" },
    ]);
  });

  it("rejects non-array input", () => {
    expect(() => loadAllowlist("{}")).toThrow(/JSON array/);
  });

  it("rejects entries missing name or reason", () => {
    expect(() => loadAllowlist(JSON.stringify([{ name: "X" }]))).toThrow(/name.*reason/);
  });
});

describe("walkSourceFiles", () => {
  it("skips broken symlinks without crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "env-doc-walk-"));
    try {
      const srcDir = path.join(dir, "src");
      mkdirSync(srcDir);
      const sourceFile = path.join(srcDir, "a.ts");
      writeFileSync(sourceFile, "const x = process.env.NEMOCLAW_FOO;", "utf-8");
      symlinkSync(path.join(srcDir, "missing-target.ts"), path.join(srcDir, "broken-link.ts"));

      expect(walkSourceFiles([srcDir])).toEqual([sourceFile]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auditEnvVarDocs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "env-doc-audit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSource(filename: string, content: string): string {
    const filePath = path.join(dir, filename);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("passes when every read var is documented", () => {
    const file = writeSource(
      "a.ts",
      "const x = process.env.NEMOCLAW_FOO ?? process.env.NEMOCLAW_BAR;",
    );
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "`NEMOCLAW_FOO` and `NEMOCLAW_BAR` are documented.",
      allowlist: [],
    });
    expect(result.undocumented).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
    expect(result.invalidAllowlist).toEqual([]);
  });

  it("flags vars that are read but neither documented nor allowlisted", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_NEW_VAR;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "no env vars",
      allowlist: [],
    });
    expect(result.undocumented).toEqual(["NEMOCLAW_NEW_VAR"]);
  });

  it("treats allowlisted vars as covered", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_TEST_VAR;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "no env vars",
      allowlist: [{ name: "NEMOCLAW_TEST_VAR", reason: "test sentinel set by Vitest setup" }],
    });
    expect(result.undocumented).toEqual([]);
  });

  it("flags allowlist entries that no longer appear in src/ (stale)", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_FOO;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "`NEMOCLAW_FOO` documented.",
      allowlist: [{ name: "NEMOCLAW_REMOVED", reason: "no longer used" }],
    });
    expect(result.staleAllowlist).toEqual(["NEMOCLAW_REMOVED"]);
  });

  it("rejects allowlist reasons that are too short", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_TEST_VAR;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "no env vars",
      allowlist: [{ name: "NEMOCLAW_TEST_VAR", reason: "test" }],
    });
    expect(result.invalidAllowlist[0]).toMatch(/reason too short/);
  });

  it("rejects allowlist entries that are simultaneously documented", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_FOO;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "`NEMOCLAW_FOO` documented.",
      allowlist: [{ name: "NEMOCLAW_FOO", reason: "should not be allowlisted because documented" }],
    });
    expect(result.invalidAllowlist[0]).toMatch(/documented in commands.md AND in allowlist/);
  });

  it("rejects allowlist entries that don't match the env name pattern", () => {
    const file = writeSource("a.ts", "const x = process.env.NEMOCLAW_FOO;");
    const result = auditEnvVarDocs({
      sourceFiles: [file],
      commandsMdText: "`NEMOCLAW_FOO` documented.",
      allowlist: [{ name: "not_a_real_name", reason: "this should be rejected as malformed" }],
    });
    expect(result.invalidAllowlist[0]).toMatch(/not a valid NEMOCLAW_/);
  });
});
