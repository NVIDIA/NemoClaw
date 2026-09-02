// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
const script = resolve(
  ".agents/skills/nemoclaw-maintainer-classify-ci-failure/scripts/classify-ci-failure.mts",
);
const roots: string[] = [];
const REDACTION_CASES = [
  [
    "Slack bot token",
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
  ],
  [
    "Slack app token",
    ["xapp", "1", "A1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-"),
    ["xapp", "1", "A1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-"),
  ],
  [
    "OpenAI API key",
    "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
    "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
  ],
  [
    "OpenAI project API key",
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
  ],
  [
    "NVIDIA API key",
    "nvapi-abcdefghijklmnopqrstuvwxyz0123456789",
    "nvapi-abcdefghijklmnopqrstuvwxyz0123456789",
  ],
  [
    "NVIDIA Cloud Functions key",
    "nvcf-abcdefghijklmnopqrstuvwxyz0123456789",
    "nvcf-abcdefghijklmnopqrstuvwxyz0123456789",
  ],
  [
    "npm access token",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  ],
  ["quoted JSON secret", '"client_secret": "json-secret-value"', "json-secret-value"],
  ["quoted JSON token", '"refresh-token": "json-token-value"', "json-token-value"],
  ["quoted JSON password", '"password": "json-password-value"', "json-password-value"],
  ["quoted JSON API key", '"api-key": "json-api-key-value"', "json-api-key-value"],
  [
    "quoted JSON authorization",
    '"authorization": "Basic json-authorization-value"',
    "json-authorization-value",
  ],
] as const;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(log: string, result?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "classify-ci-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const dir = join(root, "artifact");
  execFileSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "sample.result.json"), JSON.stringify(result ?? {}));
  const zip = join(root, "artifact.zip");
  execFileSync("zip", ["-q", zip, "sample.result.json"], { cwd: dir });
  const gh = join(bin, "gh");
  const fake = [
    "#!/usr/bin/env node",
    "const fs=require('fs');",
    "const a=process.argv.slice(2).join(' ');",
    "fs.appendFileSync(process.env.GH_CALLS,a+'\\n');",
    "if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123') console.log(JSON.stringify({id:123,run_id:456,name:'CLI tests',status:'completed',conclusion:'failure',html_url:'https://example.test/job'}));",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123/logs') process.stdout.write('discarded\\n'.repeat(Number(process.env.LOG_PREFIX_LINES||0))+process.env.TEST_LOG);",
    "else if(a==='api --include repos/NVIDIA/NemoClaw/actions/runs/456/artifacts?per_page=100&page=1') process.stdout.write('HTTP/2 200\\r\\n\\r\\n'+JSON.stringify({total_count:1,artifacts:[{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}]}));",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/artifacts/789/zip') process.stdout.write(fs.readFileSync(process.env.ZIP_PATH));",
    "else { console.error('unexpected '+a); process.exit(9); }",
  ].join("\n");
  writeFileSync(gh, fake);
  chmodSync(gh, 0o755);
  return {
    root,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      TMPDIR: root,
      GH_CALLS: join(root, "calls"),
      TEST_LOG: log,
      LOG_PREFIX_LINES: "0",
      ZIP_PATH: zip,
      ZIP_SIZE: String(execFileSync("stat", ["-c", "%s", zip], { encoding: "utf8" }).trim()),
    },
  };
}
function run(env: NodeJS.ProcessEnv, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", script, "--job-id", "123", ...extra],
    { encoding: "utf8", env },
  );
}
describe("CI failure classifier process", () => {
  test("classifies known failures, redacts secrets, and leaves unknown output unclassified", () => {
    const secrets = [
      "Authorization: Bearer full authorization value with spaces",
      "https://user:password@example.test/path",
      "AWS_ACCESS_KEY_ID=AKIAEXAMPLEVALUE",
      "BUILD_TOKEN=token-value",
      "CLIENT_SECRET: secret-value",
      "DB_PASSWORD=password-value",
      "SERVICE_API_KEY=api-key-value",
      "ghp_alpha gho_beta ghu_gamma ghs_delta ghr_epsilon github_pat_zeta",
    ].join("\n");
    const known = fixture(`${secrets}\nAssertionError: expected true`);
    const r = run(known.env);
    expect(r.status).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.result).toBe("classified");
    expect(v.categories).toContain("test-failure");
    expect(r.stdout).not.toMatch(
      /full authorization|user:password|AKIAEXAMPLE|token-value|secret-value|password-value|api-key-value|ghp_alpha|gho_beta|ghu_gamma|ghs_delta|ghr_epsilon|github_pat_zeta/,
    );
    expect(r.stdout.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
    const unknown = fixture("ordinary unrelated output");
    expect(JSON.parse(run(unknown.env).stdout).result).toBe("unclassified");
  });
  test.each(REDACTION_CASES)(
    "redacts a standalone %s from returned process logs",
    (_name, secret, exposed) => {
      const item = fixture(
        ["diagnostic before", secret, "AssertionError: expected true", "diagnostic after"].join(
          "\n",
        ),
      );
      const result = run(item.env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stdout).not.toContain(exposed ?? secret);
    },
  );
  test("rejects invalid input before invoking GitHub", () => {
    const item = fixture("unused");
    const r = run(item.env, ["--repo", "bad/repo/extra"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("repo must be owner/name");
    expect(readdirSync(item.root)).not.toContain("calls");
  });
  test("bounds streamed logs before filtering", () => {
    const item = fixture("AssertionError: retained tail");
    item.env.LOG_PREFIX_LINES = "500000";
    const r = run(item.env);
    expect(r.status, r.stderr).toBe(0);
    const value = JSON.parse(r.stdout);
    expect(value.log.truncated).toBe(true);
    expect(value.log.truncationReasons).toContain("source-log-bounded-before-filtering");
    expect(value.log.stdout).toContain("retained tail");
    expect(value.log.stdout.length).toBeLessThan(40000);
  });
  test.each([
    [["--unknown", "value"], "Unknown option --unknown"],
    [["--repo", "NVIDIA/NemoClaw", "--repo", "NVIDIA/NemoClaw"], "Duplicate option --repo"],
    [["--max-lines", "0"], "--max-lines must be an integer from 1 through 500"],
    [["--max-lines", "1.5"], "--max-lines must be an integer from 1 through 500"],
    [["--max-lines", "501"], "--max-lines must be an integer from 1 through 500"],
  ])("rejects invalid flags before invoking GitHub", (extra, message) => {
    const item = fixture("unused");
    const r = run(item.env, extra);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(readdirSync(item.root)).not.toContain("calls");
  });
  test("fails with bounded redacted diagnostics when log cleanup fails", () => {
    const exposed = REDACTION_CASES.map(([, input]) => input).join(" ");
    const item = fixture(exposed);
    const rm = join(item.root, "bin", "rm");
    writeFileSync(
      rm,
      "#!/usr/bin/env node\nprocess.stderr.write('x'.repeat(3000) + ' ' + process.env.TEST_LOG); process.exit(7);\n",
    );
    chmodSync(rm, 0o755);
    const r = run(item.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[REDACTED]");
    expect(r.stderr).not.toMatch(
      /xoxb-|xapp-|sk-|nvapi-|nvcf-|npm_|json-(?:secret|token|password|api-key|authorization)-value/,
    );
    expect(r.stderr.length).toBeLessThanOrEqual(2100);
  });
  test("reads a real ZIP artifact and removes private temporary directories", () => {
    const item = fixture("SIGKILL", {
      exitCode: 137,
      signal: "SIGKILL",
      command: "token=artifact-secret",
    });
    const r = run(item.env, ["--artifact-name", "results"]);
    expect(r.status, r.stderr).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.artifact.filesRead).toBe(1);
    expect(v.artifact.failures[0].signal).toBe("SIGKILL");
    expect(r.stdout).not.toContain("artifact-secret");
    expect(readdirSync(item.root).filter((name) => name.startsWith("nemoclaw-ci-"))).toEqual([]);
  });
});
