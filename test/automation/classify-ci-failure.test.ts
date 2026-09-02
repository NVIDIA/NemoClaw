// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  execute,
  type GhResolverFilesystem,
  resolveProductionGhExecutableForTest,
} from "../../.agents/skills/nemoclaw-maintainer-classify-ci-failure/scripts/classify-ci-failure.mts";
import { artifactZip, artifactZipEntryDataOffset } from "../helpers/artifact-zip";
const script = resolve(
  ".agents/skills/nemoclaw-maintainer-classify-ci-failure/scripts/classify-ci-failure.mts",
);
const roots: string[] = [];
const uid = process.getuid?.() ?? "unknown";
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
    `#!${process.execPath}`,
    "const fs=require('fs');",
    "const {spawn}=require('node:child_process');",
    "const block=()=>{ if(process.env.BLOCK_DESCENDANT_MARKER) { process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); } if(process.env.BLOCK_GROUP_MARKER) fs.writeFileSync(process.env.BLOCK_GROUP_MARKER,String(process.pid)); if(process.env.BLOCK_DESCENDANT_MARKER) { const child=spawn(process.execPath,['-e',\"process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:process.env.EXIT_GROUP_LEADER ? ['ignore',process.stdout,process.stderr] : 'ignore'}); fs.writeFileSync(process.env.BLOCK_DESCENDANT_MARKER,String(child.pid)); if(process.env.EXIT_GROUP_LEADER) { fs.writeFileSync(process.env.BLOCK_MARKER,'ready'); process.exit(0); } } fs.writeFileSync(process.env.BLOCK_MARKER,'ready'); setInterval(()=>{},1000); };",
    "const a=process.argv.slice(2).join(' ');",
    "fs.appendFileSync(process.env.GH_CALLS,a+'\\n');",
    "if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123') { if(process.env.BLOCK_METADATA) { block(); } else console.log(JSON.stringify({id:123,run_id:456,name:process.env.JOB_NAME||'CLI tests',status:'completed',conclusion:'failure',html_url:process.env.JOB_URL||'https://example.test/job'})); }",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/jobs/123/logs') { if(process.env.BLOCK_LOG) { block(); } else if(process.env.FAIL_LOG) { console.error(process.env.FAIL_LOG); process.exit(8); } else process.stdout.write('discarded\\n'.repeat(Number(process.env.LOG_PREFIX_LINES||0))+process.env.TEST_LOG); }",
    "else if(a==='api --include repos/NVIDIA/NemoClaw/actions/runs/456/artifacts?per_page=100&page=1') { const artifacts=process.env.DUPLICATE_ARTIFACTS ? [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)},{id:790,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}] : [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}]; process.stdout.write('HTTP/2 200\\r\\n\\r\\n'+JSON.stringify({total_count:artifacts.length,artifacts})); }",
    "else if(a==='api repos/NVIDIA/NemoClaw/actions/artifacts/789/zip') { if(process.env.BLOCK_ARTIFACT) { block(); } else process.stdout.write(fs.readFileSync(process.env.ZIP_PATH)); }",
    "else { console.error('unexpected '+a); process.exit(9); }",
  ].join("\n");
  writeFileSync(gh, fake);
  chmodSync(gh, 0o755);
  const rm = join(bin, "rm");
  writeFileSync(
    rm,
    [
      `#!${process.execPath}`,
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
    TEST_GH: gh,
    CLEANUP_OBSERVATIONS: join(root, "cleanup-observations.jsonl"),
    TEST_LOG: log,
    LOG_PREFIX_LINES: "0",
    ZIP_PATH: zip,
    ZIP_SIZE: String(statSync(zip).size),
  };
  return { root, env };
}
const classifierArgs = (extra: string[] = []) => [
  "--experimental-strip-types",
  "--no-warnings",
  script,
  "--job-id",
  "123",
  ...extra,
];
function importedClassifierArgs(env: NodeJS.ProcessEnv, extra: string[]): string[] {
  const optionValue = (name: string): string | undefined => {
    const index = extra.indexOf(name);
    return index < 0 ? undefined : extra[index + 1];
  };
  const repo = optionValue("--repo");
  const artifactName = optionValue("--artifact-name");
  const maxLines = optionValue("--max-lines");
  const clipMode = optionValue("--clip-mode");
  const input: Record<string, unknown> = {
    workdir: process.cwd(),
    jobId: "123",
    ...(repo === undefined ? {} : { repo }),
    ...(artifactName === undefined ? {} : { artifactName }),
    ...(maxLines === undefined ? {} : { maxLines: Number(maxLines) }),
    ...(clipMode === undefined ? {} : { clipMode }),
  };
  return [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    [
      `import { classifyCiFailureWithRuntimeForTest } from ${JSON.stringify(new URL("file://" + script).href)};`,
      `const input = ${JSON.stringify(input)};`,
      "const environment = { ...process.env };",
      "const executables = { bash: '/usr/bin/bash', base64: '/usr/bin/base64', dd: '/usr/bin/dd', gh: process.env.TEST_GH, rm: '/usr/bin/rm', stat: '/usr/bin/stat', tail: '/usr/bin/tail', wc: '/usr/bin/wc' };",
      "void classifyCiFailureWithRuntimeForTest(input, { executables, environment }).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });",
    ].join("\n"),
  ];
}
function run(env: NodeJS.ProcessEnv, extra: string[] = []) {
  const useCli =
    extra.some((value) => value === "--unknown") ||
    extra.filter((value) => value === "--repo").length > 1 ||
    extra.some((value) => value === "0" || value === "1.5" || value === "501");
  return spawnSync(
    process.execPath,
    useCli ? classifierArgs(extra) : importedClassifierArgs(env, extra),
    {
      encoding: "utf8",
      env,
    },
  );
}
function classifierTemporaryDirectories(prefix: "nemoclaw-ci-log." | "nemoclaw-ci-classify.") {
  const temporaryRoot = `/tmp/nemoclaw-ci-classifier-${uid}`;
  return existsSync(temporaryRoot)
    ? readdirSync(temporaryRoot).filter((name) => name.startsWith(prefix))
    : [];
}
async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 2_000, interval: 10 });
}
type FakePath = {
  type: "directory" | "file" | "symlink";
  mode?: number;
  uid?: number;
  realpath?: string;
};
function resolverFilesystem(entries: Record<string, FakePath>): GhResolverFilesystem {
  const missing = (path: string): never => {
    const error = new Error("missing " + path) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
  const entry = (path: string): FakePath => entries[path] ?? missing(path);
  return {
    lstat: (path) => {
      const value = entry(path);
      return {
        isDirectory: () => value.type === "directory",
        isFile: () => value.type === "file",
        isSymbolicLink: () => value.type === "symlink",
        mode: value.mode ?? 0o755,
        uid: value.uid ?? 0,
      };
    },
    realpath: (path) => entry(path).realpath ?? path,
    access: (path) => {
      entry(path);
    },
  };
}
function trustedDirectories(home = "/home/tester"): Record<string, FakePath> {
  return {
    "/": { type: "directory" },
    "/usr": { type: "directory" },
    "/usr/bin": { type: "directory" },
    "/usr/local": { type: "directory" },
    "/usr/local/bin": { type: "directory" },
    "/home": { type: "directory" },
    [home]: { type: "directory", uid: 1000, mode: 0o750 },
    [join(home, ".local")]: { type: "directory", uid: 1000, mode: 0o700 },
    [join(home, ".local", "bin")]: { type: "directory", uid: 1000 },
  };
}

describe("GitHub CLI production resolver", () => {
  test("selects a safe user-local executable without consulting PATH", () => {
    const home = "/home/tester";
    const gh = join(home, ".local", "bin", "gh");
    const filesystem = resolverFilesystem({
      ...trustedDirectories(home),
      [gh]: { type: "file", uid: 1000 },
      "/attacker/gh": { type: "file", uid: 1000 },
    });
    expect(
      resolveProductionGhExecutableForTest({ HOME: home, PATH: "/attacker" }, 1000, filesystem),
    ).toBe(gh);
  });

  test("skips a writable system candidate and selects a safe user-local executable", () => {
    const home = "/home/tester";
    const gh = join(home, ".local", "bin", "gh");
    const filesystem = resolverFilesystem({
      ...trustedDirectories(home),
      "/usr/bin/gh": { type: "file", mode: 0o777 },
      [gh]: { type: "file", uid: 1000 },
    });
    expect(resolveProductionGhExecutableForTest({ HOME: home }, 1000, filesystem)).toBe(gh);
  });

  test.each<[string, Record<string, FakePath>]>([
    [
      "writable path component",
      { "/home/tester/.local": { type: "directory", uid: 1000, mode: 0o770 } },
    ],
    ["foreign owner", { "/home/tester/.local/bin/gh": { type: "file", uid: 2000 } }],
    [
      "symlink candidate",
      {
        "/home/tester/.local/bin/gh": {
          type: "symlink",
          uid: 1000,
          realpath: "/attacker/gh",
        },
        "/attacker/gh": { type: "file", uid: 1000 },
      },
    ],
  ])("rejects a user-local executable with a %s", (_case, overrides) => {
    const home = "/home/tester";
    const gh = join(home, ".local", "bin", "gh");
    const filesystem = resolverFilesystem({
      ...trustedDirectories(home),
      [gh]: { type: "file", uid: 1000 },
      ...overrides,
    });
    expect(() =>
      resolveProductionGhExecutableForTest({ HOME: home, PATH: "/attacker" }, 1000, filesystem),
    ).toThrow("Could not find a trusted GitHub CLI executable");
  });
});

describe("CI failure classifier process", () => {
  test("redacts credentials from classified diagnostic output", () => {
    const secrets = [
      "Authorization: Bearer full authorization value with spaces",
      "> X-API-Key: x-header-secret",
      "request: Api-Key: api-header-secret",
      "unrelated diagnostic text",
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
    expect(r.stdout).not.toMatch(
      /full authorization|x-header-secret|api-header-secret|user:password|AKIAEXAMPLE|token-value|secret-value|password-value|api-key-value|ghp_alpha|gho_beta|ghu_gamma|ghs_delta|ghr_epsilon|github_pat_zeta/,
    );
    expect(r.stdout).toContain("> X-API-Key: [REDACTED]");
    expect(r.stdout).toContain("request: Api-Key: [REDACTED]");
    expect(r.stdout).toContain("unrelated diagnostic text");
    expect(r.stdout.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(10);
  });
  test("does not pass executable lookup or startup injection to classifier subprocesses", () => {
    const item = fixture("AssertionError: expected true");
    const attackerBin = join(item.root, "attacker-bin");
    const executableMarker = join(item.root, "attacker-executable-ran");
    const bashMarker = join(item.root, "bash-env-ran");
    const nodeMarker = join(item.root, "node-options-ran");
    mkdirSync(attackerBin);
    const bashExecutable = join(attackerBin, "bash");
    const ghExecutable = join(attackerBin, "gh");
    writeFileSync(
      bashExecutable,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(executableMarker)}, "bash\n");`,
    );
    writeFileSync(
      ghExecutable,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(executableMarker)}, "gh\n");`,
    );
    chmodSync(bashExecutable, 0o755);
    chmodSync(ghExecutable, 0o755);
    const bashHook = join(item.root, "bash-env");
    writeFileSync(bashHook, `printf injected >> ${JSON.stringify(bashMarker)}`);
    const nodeHook = join(item.root, "node-options.mjs");
    writeFileSync(
      nodeHook,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(nodeMarker)}, ${JSON.stringify("loaded\n")});`,
    );
    item.env.PATH = attackerBin;
    item.env.BASH_ENV = bashHook;
    item.env.ENV = bashHook;
    item.env.NODE_OPTIONS = `--import=${nodeHook}`;
    const result = run(item.env);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("classified");
    expect(existsSync(executableMarker)).toBe(false);
    expect(existsSync(bashMarker)).toBe(false);
    expect(readFileSync(nodeMarker, "utf8").trim().split("\n")).toEqual(["loaded"]);
  });

  test("classifies an AssertionError as a test failure", () => {
    const item = fixture("AssertionError: expected true");
    const result = run(item.env);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.result).toBe("classified");
    expect(value.categories).toContain("test-failure");
  });
  test("returns unclassified when output has no failure signature", () => {
    const item = fixture("ordinary unrelated output");
    const result = run(item.env);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("unclassified");
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
        "> X-API-Key: artifact-error-key\nunrelated artifact error\ndownload failed https://storage.test/object?X-Amz-Credential=error-credential&X-Amz-Signature=error-signature&X-Amz-Security-Token=error-session&keep=error-visible",
      command:
        "request: Api-Key: artifact-command-key\nunrelated artifact command\ncurl 'https://storage.test/object?X-Goog-Credential=command-credential&X-Goog-Signature=command-google-signature&sig=command-signature&access_token=command-access&token=command-token&keep=command-visible'",
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const failure = JSON.parse(result.stdout).artifact.failures[0];
    expect(failure.error).toContain("> X-API-Key: [REDACTED]");
    expect(failure.error).toContain("unrelated artifact error");
    expect(failure.command).toContain("request: Api-Key: [REDACTED]");
    expect(failure.command).toContain("unrelated artifact command");
    expect(failure.error).toContain(
      "?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&keep=error-visible",
    );
    expect(failure.command).toContain(
      "?X-Goog-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&sig=[REDACTED]&access_token=[REDACTED]&token=[REDACTED]&keep=command-visible",
    );
    expect(result.stdout).not.toMatch(
      /artifact-error-key|artifact-command-key|error-credential|error-signature|error-session|command-credential|command-google-signature|command-signature|command-access|command-token/,
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
    const temporaryRoot = `/tmp/nemoclaw-ci-classifier-${uid}`;
    expect(
      existsSync(temporaryRoot)
        ? readdirSync(temporaryRoot).filter((name) => name.startsWith("nemoclaw-ci-log."))
        : [],
    ).toEqual([]);
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
  test.each([
    ["authentication", "authentication required BUILD_TOKEN=log-access-secret"],
    ["authorization", "HTTP 403 resource not accessible BUILD_TOKEN=log-access-secret"],
  ])("fails log acquisition with bounded, redacted %s recovery guidance", (_kind, failure) => {
    const item = fixture("unused");
    item.env.FAIL_LOG = failure;
    const result = run(item.env);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GitHub access failed. Run gh auth status");
    expect(result.stderr).toContain("ask the user to correct authentication, authorization, SSO");
    expect(result.stderr).toContain("BUILD_TOKEN=[REDACTED]");
    expect(result.stderr).not.toContain("log-access-secret");
    expect(result.stderr.length).toBeLessThanOrEqual(2001);
    expect(classifierTemporaryDirectories("nemoclaw-ci-log.")).toEqual([]);
  });

  test("preserves the primary log failure while direct cleanup ignores a fake rm", () => {
    const item = fixture("AssertionError: retained tail");
    const credential = "cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    item.env.FAIL_CLEANUP = "nemoclaw-ci-log";
    item.env.FAIL_LOG = "primary log download failure";
    const result = run(item.env);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("primary log download failure");
    expect(result.stderr).not.toContain(credential);
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr.length).toBeLessThanOrEqual(2001);
    expect(classifierTemporaryDirectories("nemoclaw-ci-log.")).toEqual([]);
    expect(existsSync(item.env.CLEANUP_OBSERVATIONS!)).toBe(false);
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
  test("preserves an artifact validation failure while direct cleanup ignores a fake rm", () => {
    const item = fixture("SIGKILL", undefined, Buffer.from("not a zip"));
    const credential = "artifact-cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    item.env.FAIL_CLEANUP = "nemoclaw-ci-classify";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr).not.toContain(credential);
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
    expect(existsSync(item.env.CLEANUP_OBSERVATIONS!)).toBe(false);
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
    expect(existsSync(item.env.CLEANUP_OBSERVATIONS!)).toBe(false);
    const temporaryRoot = `/tmp/nemoclaw-ci-classifier-${uid}`;
    expect(
      existsSync(temporaryRoot)
        ? readdirSync(temporaryRoot).filter((name) => name.startsWith("nemoclaw-ci-"))
        : [],
    ).toEqual([]);
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

  test("ignores a string false timeout and retains a boolean true timeout", () => {
    const archive = artifactZip([
      {
        name: "string-false.result.json",
        contents: JSON.stringify({ exitCode: 0, timedOut: "false" }),
      },
      {
        name: "boolean-true.result.json",
        contents: JSON.stringify({ exitCode: 0, timedOut: true }),
      },
    ]);
    const item = fixture("ordinary output", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const failures = JSON.parse(result.stdout).artifact.failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ path: "boolean-true.result.json", timedOut: true });
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

  test("retains a leader for an ignored-stdio process-group member until timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "classify-ci-timeout-"));
    roots.push(root);
    const marker = join(root, "descendant-pid");
    const program = [
      "const {spawn}=require('node:child_process');",
      "const child=spawn(process.execPath,['-e',\"process.title='member ) name'; process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:'ignore'});",
      "require('node:fs').writeFileSync(process.argv[1],String(child.pid));",
    ].join("");
    const started = Date.now();
    const pending = execute(process.execPath, ["-e", program, marker], root, 200);
    await waitForFile(marker);
    const descendantPid = Number(readFileSync(marker, "utf8"));
    expect(() => process.kill(descendantPid, 0)).not.toThrow();
    const result = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(result.exitCode).not.toBe(0);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  test("does not escalate after a child exits promptly on SIGTERM", async () => {
    const item = fixture("AssertionError: retained tail");
    const marker = join(item.root, "blocked");
    const signals = join(item.root, "process-group-signals");
    const instrument = join(item.root, "instrument-process-kill.mjs");
    writeFileSync(
      instrument,
      [
        'import { appendFileSync } from "node:fs";',
        "const realKill = process.kill.bind(process);",
        "process.kill = (pid, signal) => {",
        "  if (pid < 0 && signal) appendFileSync(process.env.KILL_SIGNAL_LOG, String(signal) + '\\n');",
        "  return realKill(pid, signal);",
        "};",
      ].join("\n"),
    );
    item.env.BLOCK_LOG = "1";
    item.env.BLOCK_MARKER = marker;
    item.env.KILL_SIGNAL_LOG = signals;
    item.env.NODE_OPTIONS = `--import=${instrument}`;
    const child = spawn(process.execPath, importedClassifierArgs(item.env, []), {
      env: item.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForFile(marker);
    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    expect(result).toEqual({ code: 143, signal: null });
    expect(readFileSync(signals, "utf8").trim().split("\n")).toEqual(["SIGTERM"]);
  });
  test("reports a redacted fixed-root removal command when cancellation cleanup fails", async () => {
    const item = fixture("AssertionError: retained tail");
    const marker = join(item.root, "blocked");
    const instrument = join(item.root, "fail-cancellation-cleanup.mjs");
    writeFileSync(
      instrument,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        'import path from "node:path";',
        "const realRmSync = fs.rmSync.bind(fs);",
        "fs.rmSync = (target, options) =>",
        "  path.basename(String(target)).startsWith('nemoclaw-ci-log.')",
        "    ? (() => { throw new Error('BUILD_TOKEN=cancellation-cleanup-secret'); })()",
        "    : realRmSync(target, options);",
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    item.env.BLOCK_LOG = "1";
    item.env.BLOCK_MARKER = marker;
    item.env.NODE_OPTIONS = `--import=${instrument}`;
    const child = spawn(process.execPath, importedClassifierArgs(item.env, []), {
      env: item.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForFile(marker);
    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    expect(result).toEqual({ code: 143, signal: null });
    const generatedName = stderr.match(
      /Cancellation cleanup failure for (nemoclaw-ci-log\.[A-Za-z0-9]{6})/,
    )?.[1];
    expect(generatedName).toBeDefined();
    expect(stderr).toContain(
      `Remove it directly with: rm -rf -- /tmp/nemoclaw-ci-classifier-${uid}/${generatedName}`,
    );
    expect(stderr).toContain("BUILD_TOKEN=[REDACTED]");
    expect(stderr).not.toContain("cancellation-cleanup-secret");
    expect(stderr.length).toBeLessThanOrEqual(2001);
    rmSync(`/tmp/nemoclaw-ci-classifier-${uid}/${generatedName}`, { recursive: true, force: true });
  });

  test.each([
    ["metadata", "BLOCK_METADATA", [], "SIGTERM", 143, false],
    ["log", "BLOCK_LOG", [], "SIGINT", 130, true],
    ["log", "BLOCK_LOG", [], "SIGHUP", 129, true],
    ["artifact", "BLOCK_ARTIFACT", ["--artifact-name", "results"], "SIGTERM", 143, true],
  ] as const)(
    "kills the detached group and its ignoring descendant during %s cancellation",
    async (_kind, block, extra, signal, exitCode, exitGroupLeader) => {
      const item = fixture("AssertionError: retained tail");
      const marker = join(item.root, "blocked");
      const groupMarker = join(item.root, "group-pid");
      const descendantMarker = join(item.root, "descendant-pid");
      item.env[block] = "1";
      item.env.BLOCK_MARKER = marker;
      item.env.BLOCK_GROUP_MARKER = groupMarker;
      item.env.BLOCK_DESCENDANT_MARKER = descendantMarker;
      Object.assign(item.env, exitGroupLeader ? { EXIT_GROUP_LEADER: "1" } : {});
      const child = spawn(process.execPath, importedClassifierArgs(item.env, [...extra]), {
        env: item.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await Promise.all([
        waitForFile(marker),
        waitForFile(groupMarker),
        waitForFile(descendantMarker),
      ]);
      const groupPid = Number(readFileSync(groupMarker, "utf8"));
      const descendantPid = Number(readFileSync(descendantMarker, "utf8"));
      child.kill(signal);
      child.kill(signal);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) =>
          child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
      );
      expect(result).toEqual({ code: exitCode, signal: null });
      expect(() => process.kill(groupPid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
      expect(stderr.length).toBeLessThanOrEqual(2000);
      const temporaryRoot = `/tmp/nemoclaw-ci-classifier-${uid}`;
      const remaining = existsSync(temporaryRoot)
        ? readdirSync(temporaryRoot).filter((name) => name.startsWith("nemoclaw-ci-"))
        : [];
      expect(remaining).toEqual([]);
      expect(existsSync(item.env.CLEANUP_OBSERVATIONS!)).toBe(false);
    },
  );

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
