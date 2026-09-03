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
    "const block=()=>{ if(process.env.EXIT_PROMPTLY_ON_TERM) { fs.writeFileSync(process.env.BLOCK_WRAPPER_MARKER,String(process.ppid)); fs.writeFileSync(process.env.BLOCK_COMMAND_MARKER,String(process.pid)); process.once('SIGTERM',()=>{ fs.appendFileSync(process.env.SIGNAL_LOG,'SIGTERM\\n'); process.exit(0); }); } if(process.env.BLOCK_DESCENDANT_MARKER) { process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); } if(process.env.BLOCK_GROUP_MARKER) fs.writeFileSync(process.env.BLOCK_GROUP_MARKER,String(process.pid)); if(process.env.BLOCK_DESCENDANT_MARKER) { const child=spawn(process.execPath,['-e',\"process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:process.env.EXIT_GROUP_LEADER ? ['ignore',process.stdout,process.stderr] : 'ignore'}); fs.writeFileSync(process.env.BLOCK_DESCENDANT_MARKER,String(child.pid)); if(process.env.EXIT_GROUP_LEADER) { fs.writeFileSync(process.env.BLOCK_MARKER,'ready'); process.exit(0); } } fs.writeFileSync(process.env.BLOCK_MARKER,'ready'); setInterval(()=>{},1000); };",
    "const a=process.argv.slice(2).join(' ');",
    "fs.appendFileSync(process.env.GH_CALLS,a+'\\n');",
    "fs.appendFileSync(process.env.GH_ENV,JSON.stringify({GH_HOST:process.env.GH_HOST,GH_ENTERPRISE_TOKEN:process.env.GH_ENTERPRISE_TOKEN,GH_TOKEN:process.env.GH_TOKEN,GITHUB_TOKEN:process.env.GITHUB_TOKEN})+'\\n');",
    "if(a==='api --hostname github.com repos/NVIDIA/NemoClaw/actions/jobs/123') { if(process.env.BLOCK_METADATA) { block(); } else if(process.env.FAIL_METADATA) { console.error(process.env.FAIL_METADATA); process.exit(8); } else console.log(JSON.stringify({id:123,run_id:456,name:process.env.JOB_NAME||'CLI tests',status:'completed',conclusion:'failure',html_url:process.env.JOB_URL||'https://example.test/job'})); }",
    "else if(a==='api --hostname github.com repos/NVIDIA/NemoClaw/actions/jobs/123/logs') { if(process.env.BLOCK_LOG) { block(); } else if(process.env.FAIL_LOG) { console.error(process.env.FAIL_LOG); process.exit(8); } else process.stdout.write('discarded\\n'.repeat(Number(process.env.LOG_PREFIX_LINES||0))+process.env.TEST_LOG); }",
    "else if(a==='api --hostname github.com --include repos/NVIDIA/NemoClaw/actions/runs/456/artifacts?per_page=100&page=1') { if(process.env.FAIL_INVENTORY) { console.error(process.env.FAIL_INVENTORY); process.exit(8); } const artifacts=process.env.DUPLICATE_ARTIFACTS ? [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)},{id:790,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}] : [{id:789,name:'results',size_in_bytes:Number(process.env.ZIP_SIZE)}]; process.stdout.write('HTTP/2 200\\r\\n\\r\\n'+JSON.stringify({total_count:artifacts.length,artifacts})); }",
    "else if(a==='api --hostname github.com repos/NVIDIA/NemoClaw/actions/artifacts/789/zip') { if(process.env.BLOCK_ARTIFACT) { block(); } else if(process.env.STREAM_BYTES) process.stdout.write(Buffer.alloc(Number(process.env.STREAM_BYTES))); else process.stdout.write(fs.readFileSync(process.env.ZIP_PATH)); }",
    "else { console.error('unexpected '+a); process.exit(9); }",
  ].join("\n");
  writeFileSync(gh, fake);
  chmodSync(gh, 0o755);
  const dd = join(bin, "dd");
  writeFileSync(
    dd,
    [
      `#!${process.execPath}`,
      "const {spawnSync}=require('node:child_process');",
      "if(process.env.FAIL_PROBE_DD && process.argv.includes('count=1')) process.exit(7);",
      "const result=spawnSync('/usr/bin/dd',process.argv.slice(2),{stdio:'inherit'});",
      "process.exit(result.status ?? 1);",
    ].join("\n"),
  );
  chmodSync(dd, 0o755);
  const wc = join(bin, "wc");
  writeFileSync(
    wc,
    [
      `#!${process.execPath}`,
      "const {spawnSync}=require('node:child_process');",
      "if(process.env.FAIL_PROBE_WC && process.argv.includes('-c')) process.exit(7);",
      "const result=spawnSync('/usr/bin/wc',process.argv.slice(2),{stdio:'inherit'});",
      "process.exit(result.status ?? 1);",
    ].join("\n"),
  );
  chmodSync(wc, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TMPDIR: root,
    GH_CALLS: join(root, "calls"),
    GH_ENV: join(root, "environment"),
    TEST_DD: dd,
    TEST_GH: gh,
    TEST_WC: wc,
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
      "const executables = { bash: '/usr/bin/bash', dd: process.env.TEST_DD || '/usr/bin/dd', gh: process.env.TEST_GH, stat: '/usr/bin/stat', tail: '/usr/bin/tail', wc: process.env.TEST_WC || '/usr/bin/wc' };",
      "const timeouts = { metadataMs: process.env.TEST_METADATA_TIMEOUT_MS ? Number(process.env.TEST_METADATA_TIMEOUT_MS) : undefined, logMs: process.env.TEST_LOG_TIMEOUT_MS ? Number(process.env.TEST_LOG_TIMEOUT_MS) : undefined, artifactMs: process.env.TEST_ARTIFACT_TIMEOUT_MS ? Number(process.env.TEST_ARTIFACT_TIMEOUT_MS) : undefined };",
      "void classifyCiFailureWithRuntimeForTest(input, { executables, environment, timeouts }).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });",
    ].join("\n"),
  ];
}
function run(env: NodeJS.ProcessEnv, extra: string[] = []) {
  const useCli =
    extra.some((value) => value === "--unknown") ||
    extra.some((value) => value === "--repo") ||
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

describe.skipIf(process.platform !== "linux")("CI failure classifier process", () => {
  test("redacts credentials from classified diagnostic output", () => {
    const secrets = [
      "Authorization: Bearer full authorization value with spaces",
      "> X-API-Key: x-header-secret",
      "request: Api-Key: api-header-secret",
      "cOoKiE: log-cookie-secret=plain",
      "> sEt-CoOkIe: log-set-cookie-secret=prefixed; Secure",
      "< Set-Cookie: log-response-cookie-secret=prefixed; HttpOnly",
      "< Cookie: log-response-request-cookie-secret=prefixed",
      "< Authorization: Bearer log-response-auth-secret",
      "< API-Key: log-response-api-key-secret",
      "request: COOKIE: log-request-cookie-secret=prefixed",
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
      /full authorization|x-header-secret|api-header-secret|log-cookie-secret|log-set-cookie-secret|log-response-cookie-secret|log-response-request-cookie-secret|log-response-auth-secret|log-response-api-key-secret|log-request-cookie-secret|user:password|AKIAEXAMPLE|token-value|secret-value|password-value|api-key-value|ghp_alpha|gho_beta|ghu_gamma|ghs_delta|ghr_epsilon|github_pat_zeta/,
    );
    expect(r.stdout).toContain("> X-API-Key: [REDACTED]");
    expect(r.stdout).toContain("request: Api-Key: [REDACTED]");
    expect(r.stdout).toContain("cOoKiE: [REDACTED]");
    expect(r.stdout).toContain("> sEt-CoOkIe: [REDACTED]");
    expect(r.stdout).toContain("< Set-Cookie: [REDACTED]");
    expect(r.stdout).toContain("< Cookie: [REDACTED]");
    expect(r.stdout).toContain("< Authorization: [REDACTED]");
    expect(r.stdout).toContain("< API-Key: [REDACTED]");
    expect(r.stdout).toContain("request: COOKIE: [REDACTED]");
    expect(r.stdout).toContain("unrelated diagnostic text");
    expect(r.stdout.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(13);
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

  test("binds GitHub API reads to github.com without forwarding enterprise host credentials", () => {
    const item = fixture("AssertionError: expected true");
    item.env.GH_HOST = "attacker.invalid";
    item.env.GH_ENTERPRISE_TOKEN = "enterprise-secret";
    item.env.GH_TOKEN = "github-token";
    item.env.GITHUB_TOKEN = "github-actions-token";

    const result = run(item.env, ["--artifact-name", "results"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(item.env.GH_CALLS!, "utf8").trim().split("\n")).toEqual([
      "api --hostname github.com repos/NVIDIA/NemoClaw/actions/jobs/123",
      "api --hostname github.com repos/NVIDIA/NemoClaw/actions/jobs/123/logs",
      "api --hostname github.com --include repos/NVIDIA/NemoClaw/actions/runs/456/artifacts?per_page=100&page=1",
      "api --hostname github.com repos/NVIDIA/NemoClaw/actions/artifacts/789/zip",
    ]);
    const environments = readFileSync(item.env.GH_ENV!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(environments).toHaveLength(4);
    expect(environments).toEqual(
      environments.map(() => ({ GH_TOKEN: "github-token", GITHUB_TOKEN: "github-actions-token" })),
    );
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
  test("redacts artifact errors and omits ignored command data", () => {
    const item = fixture("ordinary output", {
      exitCode: 1,
      error:
        "> X-API-Key: artifact-error-key\n< Set-Cookie: artifact-response-cookie-secret=opaque; HttpOnly\nrequest: Set-Cookie: artifact-error-cookie=opaque; HttpOnly\nunrelated artifact error\ndownload failed https://storage.test/object?X-Amz-Credential=error-credential&X-Amz-Signature=error-signature&X-Amz-Security-Token=error-session&keep=error-visible",
      command:
        "request: Api-Key: artifact-command-key\n> COOKIE: artifact-command-cookie=opaque\nunrelated artifact command\ncurl 'https://storage.test/object?X-Goog-Credential=command-credential&X-Goog-Signature=command-google-signature&sig=command-signature&access_token=command-access&token=command-token&keep=command-visible'",
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const failure = JSON.parse(result.stdout).artifact.failures[0];
    expect(failure.error).toContain("> X-API-Key: [REDACTED]");
    expect(failure.error).toContain("< Set-Cookie: [REDACTED]");
    expect(failure.error).toContain("request: Set-Cookie: [REDACTED]");
    expect(failure.error).toContain("unrelated artifact error");
    expect(failure).not.toHaveProperty("command");
    expect(failure.error).toContain(
      "?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&keep=error-visible",
    );
    expect(result.stdout).not.toMatch(
      /artifact-error-key|artifact-response-cookie-secret|artifact-error-cookie|artifact-command-key|artifact-command-cookie|error-credential|error-signature|error-session|command-credential|command-google-signature|command-signature|command-access|command-token/,
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
  test("rejects an alternate valid repository before invoking GitHub", () => {
    const item = fixture("unused");
    const r = spawnSync(
      process.execPath,
      importedClassifierArgs(item.env, ["--repo", "NVIDIA/Other"]),
      {
        encoding: "utf8",
        env: item.env,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("repo must be NVIDIA/NemoClaw");
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
    [["--repo", "NVIDIA/NemoClaw"], "Unknown option --repo"],
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

  test.each([
    [
      "job metadata",
      "FAIL_METADATA",
      [],
      "authentication required BUILD_TOKEN=metadata-access-secret",
    ],
    [
      "artifact inventory",
      "FAIL_INVENTORY",
      ["--artifact-name", "results"],
      "HTTP 403 resource not accessible BUILD_TOKEN=inventory-access-secret",
    ],
  ] as const)(
    "fails %s access with bounded, redacted recovery guidance",
    (_kind, variable, extra, failure) => {
      const item = fixture("ordinary output");
      item.env[variable] = failure;
      const result = run(item.env, [...extra]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("GitHub access failed. Run gh auth status");
      expect(result.stderr).toContain(
        "ask the user to correct authentication, authorization, SSO, or token scope",
      );
      expect(result.stderr).toContain("BUILD_TOKEN=[REDACTED]");
      expect(result.stderr).not.toMatch(/metadata-access-secret|inventory-access-secret/u);
      expect(result.stderr.length).toBeLessThanOrEqual(2001);
    },
  );

  test.each([
    [
      "job metadata",
      "BLOCK_METADATA",
      "TEST_METADATA_TIMEOUT_MS",
      [],
      "GitHub job metadata read timed out after 30 seconds",
    ],
    [
      "job log",
      "BLOCK_LOG",
      "TEST_LOG_TIMEOUT_MS",
      [],
      "GitHub job log read timed out after 60 seconds",
    ],
    [
      "artifact",
      "BLOCK_ARTIFACT",
      "TEST_ARTIFACT_TIMEOUT_MS",
      ["--artifact-name", "results"],
      "GitHub artifact read timed out after 60 seconds",
    ],
  ] as const)(
    "reports a bounded silent %s timeout and removes temporary data",
    (_operation, block, timeoutVariable, extra, diagnostic) => {
      const item = fixture("ordinary output");
      item.env[block] = "1";
      item.env.BLOCK_MARKER = join(item.root, "blocked");
      item.env[timeoutVariable] = "50";
      const result = run(item.env, [...extra]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(diagnostic);
      expect(result.stderr).toContain(
        "Check GitHub availability, then retry CI failure classification.",
      );
      expect(result.stderr).not.toContain("repos/NVIDIA/NemoClaw/actions");
      expect(result.stderr).not.toContain("--hostname");
      expect(result.stderr.length).toBeLessThanOrEqual(2001);
      expect(classifierTemporaryDirectories("nemoclaw-ci-log.")).toEqual([]);
      expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
    },
  );

  test("preserves the primary log failure and directly removes its temporary directory", () => {
    const item = fixture("AssertionError: retained tail");
    const credential = "cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    item.env.FAIL_LOG = "primary log download failure";
    const result = run(item.env);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("primary log download failure");
    expect(result.stderr).not.toContain(credential);
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr.length).toBeLessThanOrEqual(2001);
    expect(classifierTemporaryDirectories("nemoclaw-ci-log.")).toEqual([]);
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
  test("allows an artifact stream at the exact compressed-size limit", () => {
    const item = fixture("SIGKILL");
    item.env.STREAM_BYTES = "25000000";
    item.env.ZIP_SIZE = "25000000";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
    expect(result.stderr).not.toContain("compressed stream exceeds");
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
  });

  test("rejects one byte beyond the compressed-size limit", () => {
    const item = fixture("SIGKILL");
    item.env.STREAM_BYTES = "25000001";
    item.env.ZIP_SIZE = "25000000";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Selected artifact compressed stream exceeds the 25,000,000-byte limit",
    );
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
  });

  test("rejects the artifact stream when the extra-byte dd probe fails", () => {
    const item = fixture("SIGKILL", { exitCode: 1 });
    item.env.FAIL_PROBE_DD = "1";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not download selected artifact");
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
  });

  test("rejects the artifact stream when the extra-byte wc probe fails", () => {
    const item = fixture("SIGKILL", { exitCode: 1 });
    item.env.FAIL_PROBE_WC = "1";
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not download selected artifact");
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
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
  test("preserves an artifact validation failure and directly removes its temporary directory", () => {
    const item = fixture("SIGKILL", undefined, Buffer.from("not a zip"));
    const credential = "artifact-cleanup-path-secret";
    const tempRoot = join(item.root, `BUILD_TOKEN=${credential}`);
    mkdirSync(tempRoot, { recursive: true });
    item.env.TMPDIR = tempRoot;
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Artifact ZIP is malformed or unsafe");
    expect(result.stderr).not.toContain("cleanup-secret");
    expect(result.stderr).not.toContain(credential);
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
  });
  test("reads a real ZIP artifact and removes private temporary directories", () => {
    const item = fixture("SIGKILL", {
      exitCode: 137,
      signal: "SIGKILL",
    });
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.artifactId).toBe(789);
    expect(value.artifact.filesRead).toBe(1);
    expect(value.artifact.failures[0].signal).toBe("SIGKILL");
    expect(result.stdout).not.toContain("artifact-secret");
    const temporaryRoot = `/tmp/nemoclaw-ci-classifier-${uid}`;
    expect(
      existsSync(temporaryRoot)
        ? readdirSync(temporaryRoot).filter((name) => name.startsWith("nemoclaw-ci-"))
        : [],
    ).toEqual([]);
  });
  test.each([
    {
      name: "nonzero exit code",
      artifactResult: { exitCode: 23 },
      category: "process-exit-code",
      nextAction: "Inspect the captured command and its producing step",
    },
    {
      name: "timeout",
      artifactResult: { exitCode: null, timedOut: true },
      category: "process-timeout",
      nextAction: "Inspect the captured command and surrounding resource evidence",
    },
    {
      name: "reported error",
      artifactResult: { exitCode: null, error: "runner could not start" },
      category: "artifact-reported-error",
      nextAction: "Inspect the reported command error and its producing step",
    },
  ])(
    "classifies an artifact-reported $name without a known log signature",
    ({ artifactResult, category, nextAction }) => {
      const item = fixture("ordinary output", artifactResult);
      const result = run(item.env, ["--artifact-name", "results"]);
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.result).toBe("classified");
      expect(value.categories).toContain(category);
      expect(value.nextActions).toContainEqual(expect.stringContaining(nextAction));
    },
  );

  test.each([
    {
      name: "signal",
      artifactResult: { exitCode: 137, signal: "SIGKILL" },
      category: "process-signal",
      diagnostic: "ended with SIGKILL",
    },
    {
      name: "timeout",
      artifactResult: { timedOut: true },
      category: "process-timeout",
      diagnostic: "exceeded its time limit",
    },
    {
      name: "reported error",
      artifactResult: { error: "runner could not start" },
      category: "artifact-reported-error",
      diagnostic: "reported: runner could not start",
    },
  ])(
    "selects a later $name beyond capped failure evidence",
    ({ artifactResult, category, diagnostic }) => {
      const secret = "winner-path-secret";
      const earlier = Array.from({ length: 20 }, (_, index) => ({
        name: `earlier-${index}.result.json`,
        contents: JSON.stringify({ exitCode: 23 }),
      }));
      const winnerPath = `BUILD_TOKEN=${secret} ${"x".repeat(1100)}.result.json`;
      const archive = artifactZip([
        ...earlier,
        { name: winnerPath, contents: JSON.stringify(artifactResult) },
      ]);
      const item = fixture("ordinary output", undefined, archive);
      const result = run(item.env, ["--artifact-name", "results"]);
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      const finding = value.findings.find((entry: { type: string }) => entry.type === category);
      expect(value.categories).toEqual([category]);
      expect(value.artifact.failures).toHaveLength(20);
      expect(value.artifact.failuresTruncated).toBe(true);
      expect(value.artifact.failures).not.toContainEqual(
        expect.objectContaining({ path: expect.stringContaining("[REDACTED]") }),
      );
      expect(finding.detail).toContain("BUILD_TOKEN=[REDACTED]");
      expect(finding.detail).toContain(diagnostic);
      expect(finding.detail.length).toBeLessThanOrEqual(1100);
      expect(result.stdout).not.toContain(secret);
    },
  );

  test("reports bounded malformed result evidence while retaining valid artifact failures", () => {
    const pathSecret = "malformed-path-secret";
    const malformed = Array.from({ length: 25 }, (_, index) => ({
      name: `results/TOKEN=${pathSecret}-${index}.result.json`,
      contents: '{"exitCode":',
    }));
    const archive = artifactZip([
      { name: `${"a".repeat(1_100)}.result.json`, contents: "null" },
      ...malformed,
      { name: "valid.result.json", contents: JSON.stringify({ exitCode: 1 }) },
    ]);
    const item = fixture("ordinary output", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.artifact.filesRead).toBe(27);
    expect(value.artifact.malformedResultCount).toBe(26);
    expect(value.artifact.malformedResultPaths).toHaveLength(20);
    expect(value.artifact.malformedResultPaths.every((path: string) => path.length <= 1_000)).toBe(
      true,
    );
    expect(value.artifact.malformedResultPathsTruncated).toBe(true);
    expect(
      value.artifact.malformedResultPaths.some((path: string) => path.includes("[REDACTED]")),
    ).toBe(true);
    expect(value.artifact.failures).toHaveLength(1);
    expect(value.artifact.failures[0].exitCode).toBe(1);
    expect(result.stdout).not.toContain(pathSecret);
  });

  test("reports malformed evidence when every selected artifact result is malformed", () => {
    const archive = artifactZip([
      { name: "truncated.result.json", contents: '{"exitCode":' },
      { name: "non-object.result.json", contents: JSON.stringify("invalid result") },
    ]);
    const item = fixture("ordinary output", undefined, archive);
    const result = run(item.env, ["--artifact-name", "results"]);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.result).toBe("unclassified");
    expect(value.artifact).toMatchObject({
      filesRead: 2,
      malformedResultCount: 2,
      malformedResultPaths: ["truncated.result.json", "non-object.result.json"],
      malformedResultPathsTruncated: false,
      failures: [],
    });
  });

  test("ignores non-failure and command-only records and retains a true timeout", () => {
    const archive = artifactZip([
      {
        name: "string-false.result.json",
        contents: JSON.stringify({ exitCode: 0, timedOut: "false" }),
      },
      {
        name: "command-only.result.json",
        contents: JSON.stringify({ command: "npm test" }),
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
    expect(result.timedOut).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  test("drains a process group whose command exits promptly on SIGTERM", async () => {
    const item = fixture("AssertionError: retained tail");
    const marker = join(item.root, "blocked");
    const signals = join(item.root, "process-group-signals");
    const wrapperMarker = join(item.root, "wrapper-pid");
    const commandMarker = join(item.root, "command-pid");
    item.env.BLOCK_LOG = "1";
    item.env.BLOCK_MARKER = marker;
    item.env.EXIT_PROMPTLY_ON_TERM = "1";
    item.env.SIGNAL_LOG = signals;
    item.env.BLOCK_WRAPPER_MARKER = wrapperMarker;
    item.env.BLOCK_COMMAND_MARKER = commandMarker;
    const child = spawn(process.execPath, importedClassifierArgs(item.env, []), {
      env: item.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await Promise.all([
      waitForFile(marker),
      waitForFile(wrapperMarker),
      waitForFile(commandMarker),
    ]);
    const wrapperPid = Number(readFileSync(wrapperMarker, "utf8"));
    const commandPid = Number(readFileSync(commandMarker, "utf8"));
    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })),
    );
    expect(result).toEqual({ code: 143, signal: null });
    expect(readFileSync(signals, "utf8").trim().split("\n")).toEqual(["SIGTERM"]);
    expect(() => process.kill(wrapperPid, 0)).toThrow();
    expect(() => process.kill(commandPid, 0)).toThrow();
    expect(classifierTemporaryDirectories("nemoclaw-ci-log.")).toEqual([]);
    expect(classifierTemporaryDirectories("nemoclaw-ci-classify.")).toEqual([]);
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
