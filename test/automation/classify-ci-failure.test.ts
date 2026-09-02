// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { artifactZip, artifactZipEntryDataOffset } from "../helpers/artifact-zip";
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
function fixture(log: string, result?: Record<string, unknown>, archive?: Buffer) {
  const root = mkdtempSync(join(tmpdir(), "classify-ci-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const zip = join(root, "artifact.zip");
  writeFileSync(
    zip,
    archive ??
      artifactZip([{ name: "sample.result.json", contents: JSON.stringify(result ?? {}) }]),
  );
  const gh = join(bin, "gh");
  const fake = [
    "#!/usr/bin/env node",
    "const fs=require('fs');",
    "const a=process.argv.slice(2).join(' ');",
    "fs.appendFileSync(process.env.GH_CALLS,a+'\\n');",
    "if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123') console.log(JSON.stringify({id:123,run_id:456,name:process.env.JOB_NAME||'CLI tests',status:'completed',conclusion:'failure',html_url:process.env.JOB_URL||'https://example.test/job'}));",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123/logs') { if(process.env.FAIL_LOG) { console.error(process.env.FAIL_LOG); process.exit(8); } process.stdout.write('discarded\\n'.repeat(Number(process.env.LOG_PREFIX_LINES||0))+process.env.TEST_LOG); }",
    "else if(a==='api --include repos/NVIDIA/NemoClaw/actions/runs/456/artifacts?per_page=100&page=1') { const artifacts=process.env.DUPLICATE_ARTIFACTS ? [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)},{id:790,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}] : [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}]; process.stdout.write('HTTP/2 200\\r\\n\\r\\n'+JSON.stringify({total_count:artifacts.length,artifacts})); }",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/artifacts/789/zip') process.stdout.write(fs.readFileSync(process.env.ZIP_PATH));",
    "else { console.error('unexpected '+a); process.exit(9); }",
  ].join("\n");
  writeFileSync(gh, fake);
  chmodSync(gh, 0o755);
  const rm = join(bin, "rm");
  writeFileSync(
    rm,
    [
      "#!/usr/bin/env node",
      "const fs=require('fs'); const path=require('path');",
      "const target=process.argv.at(-1);",
      "if(path.basename(target).startsWith('nemoclaw-ci-')) {",
      " const observation={name:path.basename(target),mode:fs.statSync(target).mode&0o777};",
      " const log=path.join(target,'job.log'); if(fs.existsSync(log)) observation.logBytes=fs.statSync(log).size;",
      " fs.appendFileSync(process.env.CLEANUP_OBSERVATIONS,JSON.stringify(observation)+'\\n');",
      " if(process.env.FAIL_CLEANUP===observation.name.split('.')[0]) { console.error('cleanup BUILD_TOKEN=cleanup-secret failed at '+target); process.exit(7); }",
      "}",
      "fs.rmSync(target,{recursive:true,force:true});",
    ].join("\n"),
  );
  chmodSync(rm, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TMPDIR: root,
    GH_CALLS: join(root, "calls"),
    CLEANUP_OBSERVATIONS: join(root, "cleanup-observations.jsonl"),
    TEST_LOG: log,
    LOG_PREFIX_LINES: "0",
    ZIP_PATH: zip,
    ZIP_SIZE: String(statSync(zip).size),
  };
  return { root, env };
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
  test("redacts signed URL credentials in selected logs without changing other query fields", () => {
    const signedUrl =
      "https://storage.test/object?keep=visible&X-Amz-Credential=aws-credential&X-Amz-Signature=aws-signature&X-Amz-Security-Token=aws-session&X-Goog-Credential=google-credential&X-Goog-Signature=google-signature&sig=azure-signature&access_token=oauth-token&token=common-token&tail=retained#fragment";
    const item = fixture(`${signedUrl}\nAssertionError: expected true`);
    const result = run(item.env);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.log.stdout).toContain(
      "?keep=visible&X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Goog-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&sig=[REDACTED]&access_token=[REDACTED]&token=[REDACTED]&tail=retained#fragment",
    );
    expect(result.stdout).not.toMatch(
      /aws-credential|aws-signature|aws-session|google-credential|google-signature|azure-signature|oauth-token|common-token/,
    );
  });
  test("redacts signed URL credentials in artifact errors and commands", () => {
    const item = fixture("ordinary output", {
      exitCode: 1,
      error:
        "download failed https://storage.test/object?X-Amz-Credential=error-credential&X-Amz-Signature=error-signature&X-Amz-Security-Token=error-session&keep=error-visible",
      command:
        "curl 'https://storage.test/object?X-Goog-Credential=command-credential&X-Goog-Signature=command-google-signature&sig=command-signature&access_token=command-access&token=command-token&keep=command-visible'",
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const failure = JSON.parse(result.stdout).artifact.failures[0];
    expect(failure.error).toContain(
      "?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&keep=error-visible",
    );
    expect(failure.command).toContain(
      "?X-Goog-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&sig=[REDACTED]&access_token=[REDACTED]&token=[REDACTED]&keep=command-visible",
    );
    expect(result.stdout).not.toMatch(
      /error-credential|error-signature|error-session|command-credential|command-google-signature|command-signature|command-access|command-token/,
    );
  });
  test("redacts and bounds dynamic GitHub job metadata", () => {
    const item = fixture("ordinary output");
    const nameSecret = "metadata-name-secret";
    const urlSecret = "metadata-url-secret";
    item.env.JOB_NAME = `${"n".repeat(600)} BUILD_TOKEN=${nameSecret}`;
    item.env.JOB_URL = `https://example.test/job/${"u".repeat(2100)}?keep=visible&token=${urlSecret}`;
    const result = run(item.env);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.job.name).toContain("[REDACTED]");
    expect(value.job.name.length).toBeLessThanOrEqual(500);
    expect(value.job.url).toContain("token=[REDACTED]");
    expect(value.job.url.length).toBeLessThanOrEqual(2000);
    expect(result.stdout).not.toContain(nameSecret);
    expect(result.stdout).not.toContain(urlSecret);
  });
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
    const observations = readFileSync(item.env.CLEANUP_OBSERVATIONS!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations).toContainEqual(
      expect.objectContaining({ name: expect.stringMatching(/^nemoclaw-ci-log\./), mode: 0o700 }),
    );
    expect(
      observations.find((entry) => entry.logBytes !== undefined)?.logBytes,
    ).toBeLessThanOrEqual(4_000_000);
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
  test("preserves the primary log failure and an actionable redacted cleanup path", () => {
    const item = fixture("AssertionError: retained tail");
    const credential = "cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    item.env.FAIL_CLEANUP = "nemoclaw-ci-log";
    item.env.FAIL_LOG = "primary log download failure";
    const result = run(item.env);
    const observation = JSON.parse(readFileSync(item.env.CLEANUP_OBSERVATIONS!, "utf8").trim());
    const leakedDirectory = join(tempRoot, observation.name);
    const recoveryCommand = result.stderr.match(/Remove it directly with: (rm -rf -- .*)/u)?.[1];
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("primary log download failure");
    expect(result.stderr).toContain(`Cleanup failure for '${observation.name}'`);
    expect(recoveryCommand).toBe(`rm -rf -- "\${TMPDIR:-/tmp}/${observation.name}"`);
    expect(result.stderr).not.toContain(credential);
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr.length).toBeLessThanOrEqual(2100);
    expect(statSync(leakedDirectory).isDirectory()).toBe(true);
    const recovered = spawnSync("bash", ["-c", recoveryCommand!], {
      env: { ...process.env, TMPDIR: tempRoot },
      encoding: "utf8",
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readdirSync(tempRoot)).not.toContain(observation.name);
  });
  test.each([
    ["malformed", Buffer.from("not a zip")],
    [
      "symlink",
      (() => {
        const archive = artifactZip([{ name: "sample.result.json", contents: "{}" }]);
        archive.writeUInt32LE(0xa0000000, archive.readUInt32LE(archive.length - 6) + 38);
        return archive;
      })(),
    ],
    ["traversal", artifactZip([{ name: "../sample.result.json", contents: "{}" }])],
    ["option-like", artifactZip([{ name: "-sample.result.json", contents: "{}" }])],
    [
      "duplicate",
      artifactZip([
        { name: "sample.result.json", contents: "{}" },
        { name: "sample.result.json", contents: "{}" },
      ]),
    ],
  ])("rejects a %s artifact ZIP", (_name, archive) => {
    const item = fixture("SIGKILL", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
  });
  test("rejects artifact metadata that differs from downloaded bytes", () => {
    const item = fixture("SIGKILL");
    item.env.ZIP_SIZE = String(Number(item.env.ZIP_SIZE) + 1);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not download selected artifact");
  });
  test("rejects a corrupted unrelated entry beside a valid result", () => {
    const archive = artifactZip(
      [
        { name: "sample.result.json", contents: JSON.stringify({ exitCode: 1 }) },
        { name: "diagnostics/unrelated.txt", contents: "unrelated" },
      ],
      8,
    );
    archive[artifactZipEntryDataOffset(archive, 1)] ^= 0xff;
    const item = fixture("SIGKILL", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
  });

  test("rejects an artifact whose declared expanded size exceeds the aggregate bound", () => {
    const archive = artifactZip([{ name: "sample.result.json", contents: "{}" }]);
    const centralOffset = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt32LE(100_000_001, centralOffset + 24);
    const item = fixture("SIGKILL", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
  });
  test("rejects a result entry over the per-file expanded limit", () => {
    const archive = artifactZip(
      [{ name: "large.result.json", contents: "x".repeat(1_000_001) }],
      8,
    );
    const item = fixture("SIGKILL", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exceeds the 1,000,000-byte limit");
  });
  test("preserves an artifact validation failure when cleanup also fails", () => {
    const item = fixture("SIGKILL", undefined, Buffer.from("not a zip"));
    const credential = "artifact-cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    item.env.FAIL_CLEANUP = "nemoclaw-ci-classify";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
    const observation = JSON.parse(
      readFileSync(item.env.CLEANUP_OBSERVATIONS!, "utf8")
        .trim()
        .split("\n")
        .find((line) => JSON.parse(line).name.startsWith("nemoclaw-ci-classify"))!,
    );
    const leakedDirectory = join(tempRoot, observation.name);
    const recoveryCommand = result.stderr.match(/Remove it directly with: (rm -rf -- .*)/u)?.[1];
    expect(result.stderr).toContain(`Cleanup failure for '${observation.name}'`);
    expect(recoveryCommand).toBe(`rm -rf -- "\${TMPDIR:-/tmp}/${observation.name}"`);
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr).not.toContain(credential);
    expect(statSync(leakedDirectory).isDirectory()).toBe(true);
    const recovered = spawnSync("bash", ["-c", recoveryCommand!], {
      env: { ...process.env, TMPDIR: tempRoot, BUILD_TOKEN: undefined },
      encoding: "utf8",
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readdirSync(tempRoot)).not.toContain(observation.name);
  });
  test("reads a real ZIP artifact and removes private temporary directories", () => {
    const item = fixture("SIGKILL", {
      exitCode: 137,
      signal: "SIGKILL",
      command: "token=artifact-secret",
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.artifactId).toBe(789);
    expect(value.artifact.filesRead).toBe(1);
    expect(value.artifact.failures[0].signal).toBe("SIGKILL");
    expect(result.stdout).not.toContain("artifact-secret");
    const observations = readFileSync(item.env.CLEANUP_OBSERVATIONS!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations.map(({ name, mode }) => ({ name: name.split(".")[0], mode }))).toEqual([
      { name: "nemoclaw-ci-log", mode: 0o700 },
      { name: "nemoclaw-ci-classify", mode: 0o700 },
    ]);
    expect(readdirSync(item.root).filter((name) => name.startsWith("nemoclaw-ci-"))).toEqual([]);
  });
  test("skips malformed result JSON while retaining valid artifact failures", () => {
    const archive = artifactZip([
      { name: "truncated.result.json", contents: '{"exitCode":' },
      { name: "valid.result.json", contents: JSON.stringify({ exitCode: 1 }) },
    ]);
    const item = fixture("ordinary output", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.filesRead).toBe(2);
    expect(value.artifact.filesTruncated).toBe(false);
    expect(value.artifact.failures).toHaveLength(1);
    expect(value.artifact.failures[0].exitCode).toBe(1);
  });

  test("rejects ambiguous same-name artifacts before downloading a ZIP", () => {
    const item = fixture("SIGKILL");
    item.env.DUPLICATE_ARTIFACTS = "1";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact results is ambiguous for run 456");
    expect(result.stderr).toContain("789, 790");
    const calls = readFileSync(item.env.GH_CALLS!, "utf8");
    expect(calls).not.toContain("actions/artifacts/789/zip");
    expect(calls).not.toContain("actions/artifacts/790/zip");
  });

  test("does not return or use a credential-shaped artifact signal", () => {
    const secret = "artifact-signal-secret";
    const item = fixture("ordinary output", {
      exitCode: 1,
      signal: `BUILD_TOKEN=${secret}`,
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.failures[0].signal).toBeNull();
    expect(value.findings).not.toContainEqual(expect.objectContaining({ type: "process-signal" }));
    expect(result.stdout).not.toContain(secret);
  });

  test("redacts credential assignments in returned artifact paths", () => {
    const secret = "artifact-path-secret";
    const archive = artifactZip([
      {
        name: `BUILD_TOKEN=${secret}.result.json`,
        contents: JSON.stringify({ exitCode: 1 }),
      },
    ]);
    const item = fixture("SIGKILL", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.failures[0].path).toContain("[REDACTED]");
    expect(result.stdout).not.toContain(secret);
  });
});
