// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  sanitizeInheritedChildEnvironment,
  startLocalCredentialHelper,
} from "../scripts/local-credential-helper.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HELPER_PATH = path.join(REPO_ROOT, "scripts", "local-credential-helper.mts");
const FORM_PATH = path.join(REPO_ROOT, "docs", "resources", "local-credential-form.html");
const READINESS_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\S*#cap=[A-Za-z0-9_-]{43}/;
const PROCESS_TIMEOUT_MS = 5_000;
const TEST_SECRET = "integration-secret-value";
const TEST_PUBLIC_VALUE = "public-id";
const BLOCKED_INHERITED_ENV_NAMES = [
  "BASH_ENV",
  "BASH_FUNC_curl%%",
  "DOTNET_STARTUP_HOOKS",
  "GIT_EXEC_PATH",
  "GIT_CONFIG",
  "GH_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND",
  "GIT_TRACE2_EVENT",
  "GIT_SSH",
  "Gh_ToKeN",
  "NODE_OPTIONS",
  "Node_Options",
  "PATH",
  "Path",
  "UNRELATED_API_TOKEN",
];

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CapturedChild {
  child: ChildProcess;
  closed: Promise<ExitResult>;
  output(): string;
}

interface RunningHelper extends CapturedChild {
  capability: string;
  formUrl: URL;
}

interface HttpResult {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

interface RequestOptions {
  body?: Buffer | string;
  headers?: Record<string, string>;
  method?: string;
  omitContentLength?: boolean;
  path?: string;
}

type ReadinessState = { kind: "exited" } | { kind: "ready"; url: string } | { kind: "waiting" };

const activeChildren = new Set<CapturedChild>();
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...activeChildren].map((captured) => terminate(captured)));
  activeChildren.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { force: true, recursive: true });
  tempDirs.clear();
});

function captureChild(args: string[], envOverrides: NodeJS.ProcessEnv = {}): CapturedChild {
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...envOverrides, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const closed = new Promise<ExitResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const captured = {
    child,
    closed,
    output: () => `${stdout}${stderr}`,
  };
  activeChildren.add(captured);
  return captured;
}

function childHasExited(captured: CapturedChild): boolean {
  return captured.child.exitCode !== null || captured.child.signalCode !== null;
}

async function awaitClosed(captured: CapturedChild): Promise<void> {
  await captured.closed.catch(() => undefined);
}

async function terminateRunning(captured: CapturedChild): Promise<void> {
  captured.child.kill("SIGTERM");
  try {
    await withTimeout(captured.closed, 1_000, "credential helper SIGTERM");
  } catch {
    captured.child.kill("SIGKILL");
    await awaitClosed(captured);
  }
}

async function terminate(captured: CapturedChild): Promise<void> {
  await (childHasExited(captured) ? awaitClosed(captured) : terminateRunning(captured));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function helperArgs(fields: string[], command: string[], formPath = FORM_PATH): string[] {
  return [
    "--experimental-strip-types",
    HELPER_PATH,
    "--form",
    formPath,
    ...fields.flatMap((field) => ["--field", field]),
    "--",
    ...command,
  ];
}

function readinessState(captured: CapturedChild): ReadinessState {
  const url = captured.output().match(READINESS_URL_PATTERN)?.[0];
  return url !== undefined
    ? { kind: "ready", url }
    : childHasExited(captured)
      ? { kind: "exited" }
      : { kind: "waiting" };
}

async function waitForReadiness(captured: CapturedChild): Promise<URL> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readinessState(captured);
    switch (state.kind) {
      case "ready":
        return new URL(state.url);
      case "exited": {
        const result = await captured.closed;
        throw new Error(
          `credential helper exited before readiness (${result.code ?? result.signal}):\n${captured.output()}`,
        );
      }
      case "waiting":
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`credential helper did not report readiness:\n${captured.output()}`);
}

async function startHelper(
  command: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<RunningHelper> {
  const captured = captureChild(
    helperArgs(["OPENAI_API_KEY:secret", "PUBLIC_ID:text"], command),
    envOverrides,
  );
  const formUrl = await waitForReadiness(captured);
  const fragment = new URLSearchParams(formUrl.hash.slice(1));
  const capability = fragment.get("cap") ?? "";
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { ...captured, capability, formUrl };
}

function createCommandFixture(): {
  command: string[];
  markerPath: string;
  unexpectedShellPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-helper-test-"));
  tempDirs.add(dir);
  const markerPath = path.join(dir, "command-runs.txt");
  const unexpectedShellPath = path.join(dir, "unexpected-shell-execution");
  const secretHash = createHash("sha256").update(TEST_SECRET).digest("hex");
  const fixture = [
    'const fs = require("node:fs");',
    'const crypto = require("node:crypto");',
    "const [markerPath, publicValue, unexpectedShellPath] = process.argv.slice(1);",
    'const secret = process.env.OPENAI_API_KEY || "";',
    'const actualHash = crypto.createHash("sha256").update(secret).digest("hex");',
    `if (actualHash !== ${JSON.stringify(secretHash)}) process.exit(21);`,
    `if (process.env.PUBLIC_ID !== ${JSON.stringify(TEST_PUBLIC_VALUE)}) process.exit(22);`,
    `if (publicValue !== ${JSON.stringify(TEST_PUBLIC_VALUE)}) process.exit(23);`,
    'if (!process.argv.includes("--")) process.exit(25);',
    `if (${JSON.stringify(BLOCKED_INHERITED_ENV_NAMES)}.some((name) => Object.hasOwn(process.env, name))) process.exit(26);`,
    'fs.appendFileSync(markerPath, "ran\\n");',
    "if (fs.existsSync(unexpectedShellPath)) process.exit(24);",
  ].join("");
  return {
    command: [
      process.execPath,
      "-e",
      fixture,
      markerPath,
      TEST_PUBLIC_VALUE,
      unexpectedShellPath,
      "--",
      "opaque-command-argument",
    ],
    markerPath,
    unexpectedShellPath,
  };
}

function request(url: URL, options: RequestOptions = {}): Promise<HttpResult> {
  const body = typeof options.body === "string" ? Buffer.from(options.body, "utf8") : options.body;
  const suppliedHeaders = options.headers ?? {};
  const hasContentLength = Object.keys(suppliedHeaders).some(
    (name) => name.toLowerCase() === "content-length",
  );
  const generatedHeaders =
    body !== undefined && !hasContentLength && !options.omitContentLength
      ? { "content-length": String(body.length) }
      : {};
  const headers = { ...suppliedHeaders, ...generatedHeaders };

  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        agent: false,
        headers,
        hostname: url.hostname,
        method: options.method ?? "GET",
        path: options.path ?? `${url.pathname}${url.search}`,
        port: url.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    clientRequest.setTimeout(3_000, () => {
      clientRequest.destroy(new Error("credential helper request timed out"));
    });
    clientRequest.on("error", reject);
    clientRequest.end(body);
  });
}

function validHeaders(helper: RunningHelper): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: helper.formUrl.origin,
    "x-nemoclaw-capability": helper.capability,
  };
}

function validBody(): string {
  return JSON.stringify({
    values: {
      OPENAI_API_KEY: TEST_SECRET,
      PUBLIC_ID: TEST_PUBLIC_VALUE,
    },
  });
}

function expectNoCors(headers: IncomingHttpHeaders): void {
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["access-control-allow-credentials"]).toBeUndefined();
  expect(headers["access-control-allow-headers"]).toBeUndefined();
  expect(headers["access-control-allow-methods"]).toBeUndefined();
}

function expectRejected(result: HttpResult): void {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
  expectNoCors(result.headers);
  expect(result.body).not.toContain(TEST_SECRET);
}

function commandRunCount(markerPath: string): number {
  try {
    return fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function expectSuccessfulCompletion(
  helper: RunningHelper,
  markerPath: string,
): Promise<void> {
  const result = await withTimeout(helper.closed, PROCESS_TIMEOUT_MS, "credential helper exit");
  expect(result).toEqual({ code: 0, signal: null });
  expect(commandRunCount(markerPath)).toBe(1);
}

describe("local credential helper", () => {
  it("sanitizes inherited names case-insensitively without mutating the source environment (#5048)", () => {
    const ambient = {
      BASH_ENV: "shell-hook",
      "BASH_FUNC_curl%%": '() { printf "%s" "$OPENAI_API_KEY"; }',
      DOTNET_STARTUP_HOOKS: "startup-hook",
      DYLD_INSERT_LIBRARIES: "loader-hook",
      Gh_ToKeN: "credential",
      GIT_CONFIG: "git-config",
      GIT_CONFIG_COUNT: "1",
      GIT_EXTERNAL_DIFF: "/ambient/diff-wrapper",
      GIT_EXEC_PATH: "/ambient/git-core",
      GIT_PROXY_COMMAND: "/ambient/proxy-wrapper",
      GIT_TRACE2_EVENT: "/ambient/git-trace.json",
      GIT_SSH: "/ambient/ssh-wrapper",
      HOME: "/safe/home",
      LD_PRELOAD: "loader-hook",
      Node_Options: "--no-warnings",
      Path: "/ambient/search/path",
      Public_Id: "ambient-field-collision",
      SAFE_SETTING: "preserved",
      SSH_AUTH_SOCK: "/ambient/agent.sock",
    } satisfies NodeJS.ProcessEnv;
    const original = { ...ambient };

    const sanitized = sanitizeInheritedChildEnvironment(ambient, new Set(["PUBLIC_ID"]));

    expect(sanitized).toEqual({ HOME: "/safe/home", SAFE_SETTING: "preserved" });
    expect(ambient).toEqual(original);
  });

  it.each([
    {
      fields: ["OPENAI_API_KEY:text"],
      label: "secret-shaped field declared as text",
    },
    { fields: ["PATH:text"], label: "process search path field" },
    { fields: ["NODE_OPTIONS:secret"], label: "Node process-control field" },
    { fields: ["BASH_FUNC_CURL:secret"], label: "exported Bash function field prefix" },
    { fields: ["DOTNET_STARTUP_HOOKS:secret"], label: ".NET startup hook field" },
    { fields: ["GIT_EXEC_PATH:secret"], label: "Git executable path field" },
    { fields: ["GIT_EXTERNAL_DIFF:secret"], label: "Git external diff field" },
    { fields: ["GIT_PROXY_COMMAND:secret"], label: "Git proxy command field" },
    { fields: ["GIT_TRACE2_EVENT:secret"], label: "Git trace field prefix" },
    { fields: ["GIT_SSH:secret"], label: "Git SSH wrapper field" },
    { fields: ["LD_PRELOAD:secret"], label: "dynamic-loader field prefix" },
    { fields: ["DYLD_INSERT_LIBRARIES:secret"], label: "macOS dynamic-loader field prefix" },
    { fields: ["GIT_CONFIG:secret"], label: "exact Git config process-control field" },
    { fields: ["GIT_CONFIG_COUNT:secret"], label: "Git config process-control field prefix" },
    {
      fields: ["PUBLIC_ID:text", "PUBLIC_ID:text"],
      label: "duplicate field",
    },
    {
      fields: Array.from({ length: 17 }, (_value, index) => `PUBLIC_ID_${index}:text`),
      label: "field count above the session limit",
    },
    { fields: ["bad-name:secret"], label: "malformed field name" },
  ])("rejects $label before listening (#5048)", async ({ fields }) => {
    const captured = captureChild(helperArgs(fields, [process.execPath, "-e", "process.exit(0)"]));

    const result = await withTimeout(captured.closed, PROCESS_TIMEOUT_MS, "invalid helper CLI");

    expect(result.code).not.toBe(0);
    expect(captured.output()).not.toMatch(READINESS_URL_PATTERN);
  });

  it.each([
    { executable: "node" },
    { executable: "./node" },
  ])("rejects non-absolute approved executable $executable before listening (#5048)", async ({
    executable,
  }) => {
    const captured = captureChild(
      helperArgs(["OPENAI_API_KEY:secret"], [executable, "-e", "process.exit(0)"]),
    );

    const result = await withTimeout(captured.closed, PROCESS_TIMEOUT_MS, "relative executable");

    expect(result.code).not.toBe(0);
    expect(captured.output()).toContain("approved command executable must use an absolute path");
    expect(captured.output()).not.toMatch(READINESS_URL_PATTERN);
  });

  it("rejects a non-absolute executable through the direct session API (#5048)", async () => {
    await expect(
      startLocalCredentialHelper({
        commandArgv: ["node", "-e", "process.exit(0)"],
        fields: [{ name: "OPENAI_API_KEY", type: "secret" }],
        formBytes: fs.readFileSync(FORM_PATH),
      }),
    ).rejects.toThrow("approved command executable must use an absolute path");
  });

  it("rejects a modified credential form before listening (#5048)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-form-test-"));
    tempDirs.add(dir);
    const modifiedFormPath = path.join(dir, "local-credential-form.html");
    const modifiedForm = Buffer.concat([fs.readFileSync(FORM_PATH), Buffer.from("\n")]);
    fs.writeFileSync(modifiedFormPath, modifiedForm);
    const captured = captureChild(
      helperArgs(
        ["OPENAI_API_KEY:secret"],
        [process.execPath, "-e", "process.exit(0)"],
        modifiedFormPath,
      ),
    );

    const result = await withTimeout(captured.closed, PROCESS_TIMEOUT_MS, "modified helper form");

    expect(result.code).not.toBe(0);
    expect(captured.output()).toContain("Local credential form SHA-256 mismatch");
    expect(captured.output()).not.toMatch(READINESS_URL_PATTERN);
  });

  it("serves only the exact form bytes with hardened non-CORS headers (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command);
    const result = await request(helper.formUrl);

    expect(helper.formUrl.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(helper.formUrl.searchParams.has("cap")).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toContain("<title>NemoClaw Local Credential Form</title>");
    expect(Number(result.headers["content-length"])).toBe(Buffer.byteLength(result.body));
    expect(result.body).not.toContain(helper.capability);
    expect(JSON.stringify(result.headers)).not.toContain(helper.capability);
    expect(result.headers["content-type"]).toMatch(/^text\/html(?:;\s*charset=utf-8)?$/i);
    expect(result.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(result.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expectNoCors(result.headers);
    expect(commandRunCount(fixture.markerPath)).toBe(0);

    const modifiedTarget = await request(helper.formUrl, {
      path: `${helper.formUrl.pathname}${helper.formUrl.search}&unexpected=1`,
    });
    expectRejected(modifiedTarget);

    const stillAvailable = await request(helper.formUrl);
    expect(stillAvailable.status).toBe(200);
    expect(stillAvailable.body).toBe(result.body);
    expect(commandRunCount(fixture.markerPath)).toBe(0);
  });

  it("strips inherited credentials and process controls before launching the approved command (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command, {
      BASH_ENV: "ambient-shell-hook",
      "BASH_FUNC_curl%%": '() { printf "%s" "$OPENAI_API_KEY"; }',
      DOTNET_STARTUP_HOOKS: "ambient-startup-hook",
      GIT_EXEC_PATH: "/ambient/git-core",
      GIT_CONFIG: "ambient-git-config",
      GH_TOKEN: "ambient-github-token",
      Gh_ToKeN: "ambient-mixed-case-github-token",
      GIT_CONFIG_COUNT: "1",
      GIT_EXTERNAL_DIFF: "/ambient/diff-wrapper",
      GIT_PROXY_COMMAND: "/ambient/proxy-wrapper",
      GIT_TRACE2_EVENT: "/ambient/git-trace.json",
      GIT_SSH: "/ambient/ssh-wrapper",
      NODE_OPTIONS: "--no-warnings",
      Node_Options: "--no-warnings",
      OPENAI_API_KEY: "ambient-openai-key",
      PATH: "/ambient/search/path",
      Path: "/ambient/mixed-case/search/path",
      PUBLIC_ID: "ambient-public-id",
      UNRELATED_API_TOKEN: "ambient-generic-token",
    });

    const accepted = await request(helper.formUrl, {
      body: validBody(),
      headers: validHeaders(helper),
      method: "POST",
      path: "/submit",
    });

    expect(accepted.status).toBe(202);
    await expectSuccessfulCompletion(helper, fixture.markerPath);
  });

  it("blocks an inherited Bash function from intercepting the approved command (#5048)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-bash-test-"));
    tempDirs.add(dir);
    const markerPath = path.join(dir, "command-runs.txt");
    const attackMarkerPath = path.join(dir, "ambient-function-ran.txt");
    const command = [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      'curl --version >/dev/null && test ! -e "$ATTACK_MARKER" && printf "ran\\n" > "$1"',
      "bash",
      markerPath,
    ];
    const helper = await startHelper(command, {
      ATTACK_MARKER: attackMarkerPath,
      "BASH_FUNC_curl%%": '() { printf "%s" "$OPENAI_API_KEY" > "$ATTACK_MARKER"; }',
      PATH: "/ambient/search/path",
    });

    const accepted = await request(helper.formUrl, {
      body: validBody(),
      headers: validHeaders(helper),
      method: "POST",
      path: "/submit",
    });

    expect(accepted.status).toBe(202);
    await expectSuccessfulCompletion(helper, markerPath);
    expect(fs.existsSync(attackMarkerPath)).toBe(false);
  });

  it("rejects Host, Origin, capability, and CORS probes without consuming the session (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command);
    const body = validBody();
    const attacks: RequestOptions[] = [
      {
        body,
        headers: { ...validHeaders(helper), host: `localhost:${helper.formUrl.port}` },
        method: "POST",
        path: "/submit",
      },
      {
        body,
        headers: { ...validHeaders(helper), origin: `http://localhost:${helper.formUrl.port}` },
        method: "POST",
        path: "/submit",
      },
      {
        body,
        headers: {
          ...validHeaders(helper),
          "x-nemoclaw-capability": "x".repeat(43),
        },
        method: "POST",
        path: "/submit",
      },
      {
        body,
        headers: {
          "content-type": "application/json",
          origin: helper.formUrl.origin,
        },
        method: "POST",
        path: "/submit",
      },
      {
        headers: {
          "access-control-request-headers": "x-nemoclaw-capability, content-type",
          "access-control-request-method": "POST",
          origin: "https://attacker.invalid",
        },
        method: "OPTIONS",
        path: "/submit",
      },
    ];

    for (const attack of attacks) {
      expectRejected(await request(helper.formUrl, attack));
      expect(commandRunCount(fixture.markerPath)).toBe(0);
    }

    const accepted = await request(helper.formUrl, {
      body,
      headers: validHeaders(helper),
      method: "POST",
      path: "/submit",
    });
    expect(accepted.status).toBe(202);
    expectNoCors(accepted.headers);
    await expectSuccessfulCompletion(helper, fixture.markerPath);
  });

  it("rejects media, encoding, body, and exact-schema violations without consuming the session (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command);
    const authHeaders = validHeaders(helper);
    const invalidRequests: RequestOptions[] = [
      {
        body: validBody(),
        headers: { ...authHeaders, "content-type": "text/plain" },
        method: "POST",
        path: "/submit",
      },
      {
        body: validBody(),
        headers: { ...authHeaders, "content-type": "application/json; charset=utf-8" },
        method: "POST",
        path: "/submit",
      },
      {
        body: validBody(),
        headers: { ...authHeaders, "content-encoding": "gzip" },
        method: "POST",
        path: "/submit",
      },
      {
        body: validBody(),
        headers: { ...authHeaders, "transfer-encoding": "chunked" },
        method: "POST",
        omitContentLength: true,
        path: "/submit",
      },
      {
        body: Buffer.alloc(65_537, 0x61),
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
      {
        body: "{not-json",
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
      {
        body: JSON.stringify({ values: { OPENAI_API_KEY: TEST_SECRET } }),
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
      {
        body: JSON.stringify({
          argv: ["sh", "-c", "unexpected"],
          values: { OPENAI_API_KEY: TEST_SECRET, PUBLIC_ID: TEST_PUBLIC_VALUE },
        }),
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
      {
        body: JSON.stringify({
          values: { OPENAI_API_KEY: TEST_SECRET, PUBLIC_ID: 42 },
        }),
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
      {
        body: JSON.stringify({
          values: { OPENAI_API_KEY: TEST_SECRET, PUBLIC_ID: "é".repeat(8_193) },
        }),
        headers: authHeaders,
        method: "POST",
        path: "/submit",
      },
    ];

    for (const invalid of invalidRequests) {
      expectRejected(await request(helper.formUrl, invalid));
      expect(commandRunCount(fixture.markerPath)).toBe(0);
    }

    const accepted = await request(helper.formUrl, {
      body: validBody(),
      headers: authHeaders,
      method: "POST",
      path: "/submit",
    });
    expect(accepted.status).toBe(202);
    await expectSuccessfulCompletion(helper, fixture.markerPath);
  });

  it("claims one racing submission, runs the command once, and closes the listener (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command);
    const submission = () =>
      request(helper.formUrl, {
        body: validBody(),
        headers: validHeaders(helper),
        method: "POST",
        path: "/submit",
      });

    const outcomes = await Promise.allSettled([submission(), submission()]);
    const responses = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const accepted = responses.filter((response) => response.status === 202);

    expect(accepted).toHaveLength(1);
    expect(responses.filter((response) => response.status >= 200 && response.status < 300)).toEqual(
      accepted,
    );
    for (const response of responses.filter((response) => response.status !== 202)) {
      expect(response.status).toBe(409);
      expectNoCors(response.headers);
    }
    expect(accepted[0]?.headers.connection).toBe("close");
    expect(accepted[0]?.body).not.toContain(TEST_SECRET);

    await expectSuccessfulCompletion(helper, fixture.markerPath);
    expect(helper.output()).not.toContain(TEST_SECRET);
    expect(fs.existsSync(fixture.unexpectedShellPath)).toBe(false);
    await expect(request(helper.formUrl)).rejects.toBeInstanceOf(Error);
  });

  it("executes once when the client sends a valid request and abandons the response (#5048)", async () => {
    const fixture = createCommandFixture();
    const helper = await startHelper(fixture.command);
    const body = validBody();
    const rawRequest = [
      "POST /submit HTTP/1.1",
      `Host: ${helper.formUrl.host}`,
      `Origin: ${helper.formUrl.origin}`,
      `X-NemoClaw-Capability: ${helper.capability}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n");

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(
        { host: helper.formUrl.hostname, port: Number(helper.formUrl.port) },
        () => {
          socket.end(rawRequest, () => {
            socket.destroy();
            resolve();
          });
        },
      );
      socket.once("error", reject);
    });

    await expectSuccessfulCompletion(helper, fixture.markerPath);
    expect(helper.output()).not.toContain(TEST_SECRET);
    await expect(request(helper.formUrl)).rejects.toBeInstanceOf(Error);
  });
});
