// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("non-interactive error classification patch", () => {
  it("injects classification infrastructure into non_interactive.py", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    expect(source).toContain("_NEMOCLAW_KNOWN_PROVIDER_ERRORS");
    expect(source).toContain("_nemoclaw_classify_non_interactive_error");
    expect(source).toContain("nemoclaw.managed.non_interactive");
  });

  it("produces valid Python syntax after patching", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const result = spawnSync("python3", ["-c", `compile(${JSON.stringify(source)}, "<test>", "exec")`], {
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
  });

  it("classifies known provider errors correctly", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const driver = [
      source,
      "",
      "# Test driver: exercise classifier against sample exceptions",
      "cases = [",
      "    (RuntimeError('ResourceExhausted: Worker local total request limit reached'), 'upstream_provider_capacity', True),",
      "    (RuntimeError('RateLimitError: 429 Too Many Requests'), 'upstream_rate_limit', True),",
      "    (RuntimeError('request timeout after 30s'), 'upstream_timeout', True),",
      "    (RuntimeError('DeadlineExceeded'), 'upstream_timeout', True),",
      "    (ConnectionError('connection refused'), 'upstream_connection', True),",
      "    (RuntimeError('unknown kaboom'), None, None),",
      "]",
      "for exc, expected_cat, expected_retry in cases:",
      "    result = _nemoclaw_classify_non_interactive_error(exc)",
      "    if expected_cat is None:",
      "        assert result is None, f'Expected None for {exc!r}, got {result}'",
      "    else:",
      "        assert result is not None, f'Expected classification for {exc!r}, got None'",
      "        cat, retry = result",
      "        assert cat == expected_cat, f'Expected {expected_cat}, got {cat} for {exc!r}'",
      "        assert retry == expected_retry, f'Expected {expected_retry}, got {retry} for {exc!r}'",
      "print('All classifier tests passed')",
    ].join("\n");

    const result = spawnSync("python3", ["-c", driver], { timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("All classifier tests passed");
  });

  it("classifies chained exceptions via __cause__ and __context__", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const driver = [
      source,
      "",
      "# Test chained exceptions: outer generic, inner has provider cause",
      "class RemoteException(Exception): pass",
      "",
      "# __cause__ chain (explicit chaining via 'raise X from Y')",
      "inner = RuntimeError('ResourceExhausted: Worker local total request limit reached (32/32)')",
      "outer = RemoteException(\"{'error': 'APIError', 'message': 'An internal error occurred'}\")",
      "outer.__cause__ = inner",
      "result = _nemoclaw_classify_non_interactive_error(outer)",
      "assert result is not None, f'Expected classification for chained __cause__, got None'",
      "assert result[0] == 'upstream_provider_capacity', f'Expected upstream_provider_capacity, got {result[0]}'",
      "assert result[1] is True, f'Expected retryable=True, got {result[1]}'",
      "",
      "# __context__ chain (implicit chaining via 'raise X' inside except)",
      "inner2 = RuntimeError('RateLimitError: 429')",
      "outer2 = RemoteException('generic error')",
      "outer2.__context__ = inner2",
      "result2 = _nemoclaw_classify_non_interactive_error(outer2)",
      "assert result2 is not None, f'Expected classification for chained __context__, got None'",
      "assert result2[0] == 'upstream_rate_limit', f'Expected upstream_rate_limit, got {result2[0]}'",
      "",
      "# No cause chain — generic exception stays unknown",
      "generic = RemoteException(\"{'error': 'APIError', 'message': 'An internal error occurred'}\")",
      "result3 = _nemoclaw_classify_non_interactive_error(generic)",
      "assert result3 is None, f'Expected None for generic without chain, got {result3}'",
      "",
      "print('All chain classification tests passed')",
    ].join("\n");

    const result = spawnSync("python3", ["-c", driver], { timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("All chain classification tests passed");
  });

  it("recovers provider cause from persisted checkpoint errors", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const driver = [
      source,
      "",
      "import tempfile, sqlite3, os",
      "",
      "# Create a temporary checkpoint DB with persisted error entries",
      "db_dir = tempfile.mkdtemp()",
      "db_path = os.path.join(db_dir, 'sessions.db')",
      "_NEMOCLAW_MANAGED_STATE_DB = db_path",
      "",
      "conn = sqlite3.connect(db_path)",
      "conn.execute('CREATE TABLE checkpoint_writes (channel TEXT, value TEXT)')",
      "conn.execute(",
      "    \"INSERT INTO checkpoint_writes (channel, value) VALUES \"",
      "    \"('__error__', 'APIError(\\\"ResourceExhausted: Worker local total request limit reached (32/32)\\\")')\"\n",
      ")",
      "conn.commit()",
      "conn.close()",
      "",
      "# Classify from persisted errors",
      "result = _nemoclaw_classify_from_persisted_errors()",
      "assert result is not None, f'Expected classification from persisted DB, got None'",
      "assert result[0] == 'upstream_provider_capacity', f'Expected upstream_provider_capacity, got {result[0]}'",
      "assert result[1] is True, f'Expected retryable=True, got {result[1]}'",
      "",
      "# Test with no matching errors",
      "db_path2 = os.path.join(db_dir, 'sessions2.db')",
      "_NEMOCLAW_MANAGED_STATE_DB = db_path2",
      "conn2 = sqlite3.connect(db_path2)",
      "conn2.execute('CREATE TABLE checkpoint_writes (channel TEXT, value TEXT)')",
      "conn2.execute(\"INSERT INTO checkpoint_writes (channel, value) VALUES ('__error__', 'SomeOtherError')\")",
      "conn2.commit()",
      "conn2.close()",
      "result2 = _nemoclaw_classify_from_persisted_errors()",
      "assert result2 is None, f'Expected None for unrecognized error, got {result2}'",
      "",
      "# Test with missing DB",
      "_NEMOCLAW_MANAGED_STATE_DB = '/nonexistent/path/sessions.db'",
      "result3 = _nemoclaw_classify_from_persisted_errors()",
      "assert result3 is None, f'Expected None for missing DB, got {result3}'",
      "",
      "# Cleanup",
      "import shutil",
      "shutil.rmtree(db_dir)",
      "",
      "print('All persisted error tests passed')",
    ].join("\n");

    const result = spawnSync("python3", ["-c", driver], { timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("All persisted error tests passed");
  });

  it("uses uuid correlation ID instead of object address", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    // Verify the patched source uses correlation_id and uuid, not hex(id())
    expect(source).toContain("correlation_id");
    expect(source).toContain("_nemoclaw_uuid");
    expect(source).not.toContain("hex(id(exc))");
    expect(source).not.toContain("exc_id");
  });

  it("classification results contain only fixed category fields, not exception content", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const driver = [
      source,
      "",
      "# Verify classifier returns only fixed category fields",
      "# even when exception text contains sensitive content",
      "sensitive_exc = RuntimeError(",
      "    'ResourceExhausted: token=sk-secret-123 body={\"model\":\"gpt-4\",\"messages\":[{\"role\":\"user\",\"content\":\"secret\"}]}'",
      ")",
      "result = _nemoclaw_classify_non_interactive_error(sensitive_exc)",
      "assert result is not None, 'Expected classification'",
      "cat, retry = result",
      "assert cat == 'upstream_provider_capacity', f'Expected category, got {cat}'",
      "assert retry is True",
      "# Result tuple contains only the fixed category string and boolean",
      "assert 'sk-secret' not in str(result), 'Sensitive token leaked in result'",
      "assert 'gpt-4' not in str(result), 'Model name leaked in result'",
      "assert 'secret' not in str(result), 'Message content leaked in result'",
      "",
      "print('All non-disclosure tests passed')",
    ].join("\n");

    const result = spawnSync("python3", ["-c", driver], { timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("All non-disclosure tests passed");
  });
});
