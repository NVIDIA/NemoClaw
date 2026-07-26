// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCredentialFormCsp,
  parseCliArguments,
  parseCredentialField,
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
const CONFIG_ROOT_ENV_NAMES = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "CURL_HOME",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "GCONV_PATH",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GLIBC_TUNABLES",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "KUBECONFIG",
  "LOCALAPPDATA",
  "LOCPATH",
  "NETRC",
  "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL",
  "NEMOCLAW_BOOTSTRAP_PAYLOAD",
  "NEMOCLAW_INSTALL_REF",
  "NEMOCLAW_INSTALL_TAG",
  "NEMOCLAW_INSTALLER_STAGED",
  "NEMOCLAW_INSTALLER_URL",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_CHANNEL",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
  "NEMOCLAW_REPO_ROOT",
  "NEMOCLAW_SOURCE_ROOT",
  "NVM_DIR",
  "OLDPWD",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "PROGRAMDATA",
  "PSMODULEPATH",
  "PWD",
  "PYTHONUSERBASE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "VIRTUAL_ENV",
  "XDG_BIN_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "ZDOTDIR",
];
const CONFIG_ROOT_ENV_OVERRIDES = Object.fromEntries(
  CONFIG_ROOT_ENV_NAMES.map((name) => [name, `/ambient/${name.toLowerCase()}`]),
) satisfies NodeJS.ProcessEnv;
const PRIVATE_EXECUTION_ENV_PATHS = {
  APPDATA: ["appdata", "roaming"],
  CURL_HOME: ["config"],
  HOME: [],
  LOCALAPPDATA: ["appdata", "local"],
  PWD: [],
  TEMP: ["tmp"],
  TMP: ["tmp"],
  TMPDIR: ["tmp"],
  USERPROFILE: [],
  XDG_CACHE_HOME: ["cache"],
  XDG_CONFIG_DIRS: ["config-dirs"],
  XDG_CONFIG_HOME: ["config"],
  XDG_DATA_DIRS: ["data-dirs"],
  XDG_DATA_HOME: ["data"],
  XDG_RUNTIME_DIR: ["runtime"],
  XDG_STATE_HOME: ["state"],
} as const;
const NETWORK_TRUST_ENV_NAMES = [
  "ALL_PROXY",
  "AWS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "DENO_CERT",
  "FTP_PROXY",
  "GIT_PROXY_SSL_CAINFO",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "GRPC_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSLKEYLOGFILE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
];
const NETWORK_TRUST_ENV_OVERRIDES = {
  ...Object.fromEntries(
    NETWORK_TRUST_ENV_NAMES.map((name) => [name, `ambient-${name.toLowerCase()}`]),
  ),
  GIT_SSL_NO_VERIFY: "1",
  NODE_EXTRA_CA_CERTS: "",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  NO_PROXY: "*",
} satisfies NodeJS.ProcessEnv;
const PACKAGE_CONTROL_ENV_OVERRIDES = {
  npm_config_registry: "https://ambient-registry.invalid",
  Pip_Index_Url: "https://ambient-index.invalid/simple",
} satisfies NodeJS.ProcessEnv;
const BLOCKED_INHERITED_ENV_NAMES = [
  ...NETWORK_TRUST_ENV_NAMES,
  ...Object.keys(PACKAGE_CONTROL_ENV_OVERRIDES),
  "BASH_ENV",
  "BASH_FUNC_echo%%",
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
  "NEMOCLAW_PROVIDER",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
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

export type LocalCredentialHelperTestGroup = "contract" | "fields" | "session";

export function registerLocalCredentialHelperTests(group: LocalCredentialHelperTestGroup): void {
  const activeChildren = new Set<CapturedChild>();
  const tempDirs = new Set<string>();

  function privateExecutionRoots(): string[] {
    return fs
      .readdirSync(path.dirname(HELPER_PATH))
      .filter((name) => name.startsWith(".credential-child-"))
      .sort();
  }

  afterEach(async () => {
    await Promise.all([...activeChildren].map((captured) => terminate(captured)));
    activeChildren.clear();
    for (const dir of tempDirs) fs.rmSync(dir, { force: true, recursive: true });
    tempDirs.clear();
  });

  function captureChild(
    args: string[],
    envOverrides: NodeJS.ProcessEnv = {},
    cwd = REPO_ROOT,
  ): CapturedChild {
    const child = spawn(process.execPath, args, {
      cwd,
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

  function helperCliArguments(
    fields: string[],
    command: string[],
    formPath = FORM_PATH,
    executionProfile: "account-home" | "isolated" = "isolated",
    commandCwd?: string,
  ): string[] {
    const cwdArgs = commandCwd === undefined ? [] : ["--cwd", commandCwd];
    const args = ["--execution-profile", executionProfile, "--form", formPath, ...cwdArgs];
    return [...args, ...fields.flatMap((field) => ["--field", field]), "--", ...command];
  }

  function helperArgs(
    fields: string[],
    command: string[],
    formPath = FORM_PATH,
    executionProfile: "account-home" | "isolated" = "isolated",
    commandCwd?: string,
  ): string[] {
    return [
      "--experimental-strip-types",
      HELPER_PATH,
      ...helperCliArguments(fields, command, formPath, executionProfile, commandCwd),
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
    executionProfile: "account-home" | "isolated" = "isolated",
    commandCwd?: string,
    helperCwd = REPO_ROOT,
  ): Promise<RunningHelper> {
    const captured = captureChild(
      helperArgs(
        ["OPENAI_API_KEY:secret", "PUBLIC_ID:text"],
        command,
        FORM_PATH,
        executionProfile,
        commandCwd,
      ),
      envOverrides,
      helperCwd,
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
      'const path = require("node:path");',
      "const [markerPath, publicValue, unexpectedShellPath] = process.argv.slice(1);",
      'const secret = process.env.OPENAI_API_KEY || "";',
      'const actualHash = crypto.createHash("sha256").update(secret).digest("hex");',
      `if (actualHash !== ${JSON.stringify(secretHash)}) process.exit(21);`,
      `if (process.env.PUBLIC_ID !== ${JSON.stringify(TEST_PUBLIC_VALUE)}) process.exit(22);`,
      `if (publicValue !== ${JSON.stringify(TEST_PUBLIC_VALUE)}) process.exit(23);`,
      'if (!process.argv.includes("--")) process.exit(25);',
      `if (${JSON.stringify(BLOCKED_INHERITED_ENV_NAMES)}.some((name) => Object.hasOwn(process.env, name))) process.exit(26);`,
      `if (Object.values(process.env).some((value) => ${JSON.stringify(Object.values(CONFIG_ROOT_ENV_OVERRIDES))}.includes(value))) process.exit(27);`,
      'const privateRoot = process.env.HOME || "";',
      `for (const [name, parts] of Object.entries(${JSON.stringify(PRIVATE_EXECUTION_ENV_PATHS)})) if (process.env[name] !== path.join(privateRoot, ...parts)) process.exit(28);`,
      `if (${JSON.stringify(CONFIG_ROOT_ENV_NAMES.filter((name) => !Object.hasOwn(PRIVATE_EXECUTION_ENV_PATHS, name)))}.some((name) => Object.hasOwn(process.env, name))) process.exit(29);`,
      "if (!path.isAbsolute(privateRoot) || process.cwd() !== privateRoot) process.exit(30);",
      'if (process.platform !== "win32" && (fs.statSync(privateRoot).mode & 0o077) !== 0) process.exit(31);',
      'if ([".curlrc", ".gitconfig", ".npmrc", ".netrc"].some((name) => fs.existsSync(path.join(privateRoot, name)))) process.exit(32);',
      'fs.writeFileSync(markerPath + ".private-root", privateRoot);',
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
    const body =
      typeof options.body === "string" ? Buffer.from(options.body, "utf8") : options.body;
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

  function expectHttpStatus(result: HttpResult, expected: number): void {
    expect(result.status).toBe(expected);
  }

  async function expectCompletionCode(
    completion: Promise<number>,
    expected: number,
  ): Promise<void> {
    expect(await completion).toBe(expected);
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
    const privateRootMarker = `${markerPath}.private-root`;
    const privateRootStillExists =
      fs.existsSync(privateRootMarker) && fs.existsSync(fs.readFileSync(privateRootMarker, "utf8"));
    expect(privateRootStillExists).toBe(false);
  }

  describe("local credential helper", () => {
    if (group === "contract") {
      it("hashes inline form tags case-insensitively for CSP generation (#5048)", () => {
        const csp = buildCredentialFormCsp(Buffer.from("<STYLE>body{}</STYLE><SCRIPT>0;</SCRIPT>"));

        expect(csp).toContain("script-src 'sha256-");
        expect(csp).toContain("style-src 'sha256-");
      });

      it("drops every ambient entry without mutating the source environment (#5048)", () => {
        const ambient = {
          ...CONFIG_ROOT_ENV_OVERRIDES,
          ...NETWORK_TRUST_ENV_OVERRIDES,
          ...PACKAGE_CONTROL_ENV_OVERRIDES,
          BASH_ENV: "shell-hook",
          "BASH_FUNC_echo%%": '() { printf "%s" "$OPENAI_API_KEY"; }',
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
          LD_PRELOAD: "loader-hook",
          NEMOCLAW_PROVIDER: "ambient-provider",
          Node_Options: "--no-warnings",
          Path: "/ambient/search/path",
          Public_Id: "ambient-field-collision",
          UNKNOWN_AMBIENT_SETTING: "removed",
          SSH_AUTH_SOCK: "/ambient/agent.sock",
        } satisfies NodeJS.ProcessEnv;
        const original = { ...ambient };

        const sanitized = sanitizeInheritedChildEnvironment(ambient, new Set(["PUBLIC_ID"]));

        expect(sanitized).toEqual({});
        expect(ambient).toEqual(original);
      });

      it("allows explicitly collected NemoClaw settings while denying their ambient values (#5048)", () => {
        expect(parseCredentialField("NEMOCLAW_PROVIDER:text")).toEqual({
          name: "NEMOCLAW_PROVIDER",
          type: "text",
        });
        expect(
          sanitizeInheritedChildEnvironment(
            { NEMOCLAW_MODEL: "ambient-model", NEMOCLAW_PROVIDER: "ambient-provider" },
            new Set(["NEMOCLAW_PROVIDER"]),
          ),
        ).toEqual({});
      });
    }

    if (group === "fields") {
      it.each([
        {
          fields: ["OPENAI_API_KEY:text"],
          label: "secret-shaped field declared as text",
        },
        { fields: ["PATH:text"], label: "process search path field" },
        { fields: ["NODE_OPTIONS:secret"], label: "Node process-control field" },
        { fields: ["BASH_FUNC_ECHO:secret"], label: "exported Bash function field prefix" },
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
        ...CONFIG_ROOT_ENV_NAMES.map((name) => ({
          fields: [`${name}:text`],
          label: `${name} configuration-root field`,
        })),
        ...NETWORK_TRUST_ENV_NAMES.map((name) => ({
          fields: [`${name}:text`],
          label: `${name} network or trust control field`,
        })),
        { fields: ["NPM_CONFIG_REGISTRY:text"], label: "npm configuration field prefix" },
        {
          fields: ["OPENSHELL_DOCKER_SUPERVISOR_IMAGE:text"],
          label: "OpenShell configuration field prefix",
        },
        { fields: ["PIP_INDEX_URL:text"], label: "pip configuration field prefix" },
        {
          fields: ["PUBLIC_ID:text", "PUBLIC_ID:text"],
          label: "duplicate field",
        },
        {
          fields: Array.from({ length: 17 }, (_value, index) => `PUBLIC_ID_${index}:text`),
          label: "field count above the session limit",
        },
        { fields: ["bad-name:secret"], label: "malformed field name" },
      ])("rejects $label before listening (#5048)", ({ fields }) => {
        expect(() =>
          parseCliArguments(
            helperCliArguments(fields, [process.execPath, "-e", "process.exit(0)"]),
          ),
        ).toThrow();
      });

      it("wires field rejection through the CLI entrypoint before listening (#5048)", async () => {
        const captured = captureChild(
          helperArgs(["PATH:text"], [process.execPath, "-e", "process.exit(0)"]),
        );

        const result = await withTimeout(captured.closed, PROCESS_TIMEOUT_MS, "invalid helper CLI");

        expect(result.code).not.toBe(0);
        expect(captured.output()).toContain(
          "--field PATH is a process-control environment variable and is not allowed",
        );
        expect(captured.output()).not.toMatch(READINESS_URL_PATTERN);
      });

      it.each([
        { executable: "node" },
        { executable: "./node" },
      ])("rejects non-absolute approved executable $executable before listening (#5048)", ({
        executable,
      }) => {
        expect(() =>
          parseCliArguments(
            helperCliArguments(["OPENAI_API_KEY:secret"], [executable, "-e", "process.exit(0)"]),
          ),
        ).toThrow("approved command executable must use an absolute path");
      });

      it.each([
        {
          options: [],
          expected: "--execution-profile isolated or --execution-profile account-home is required",
        },
        {
          options: ["--execution-profile", "unknown"],
          expected: "--execution-profile must be isolated or account-home",
        },
        {
          options: ["--execution-profile", "account-home"],
          expected: "--execution-profile account-home requires an absolute --cwd path",
        },
        {
          options: ["--execution-profile", "account-home", "--cwd", "relative"],
          expected: "--cwd must be an absolute path without NUL bytes",
        },
        {
          options: ["--execution-profile", "isolated", "--cwd", REPO_ROOT],
          expected: "--execution-profile isolated does not accept --cwd",
        },
      ])("rejects an unsafe or ambiguous execution profile before listening (#5048)", ({
        expected,
        options,
      }) => {
        expect(() =>
          parseCliArguments([
            ...options,
            "--field",
            "OPENAI_API_KEY:secret",
            "--",
            process.execPath,
            "-e",
            "process.exit(0)",
          ]),
        ).toThrow(expected);
      });
    }

    if (group === "contract") {
      it("rejects a non-absolute executable through the direct session API (#5048)", async () => {
        await expect(
          startLocalCredentialHelper({
            commandArgv: ["node", "-e", "process.exit(0)"],
            executionProfile: "isolated",
            fields: [{ name: "OPENAI_API_KEY", type: "secret" }],
            formBytes: fs.readFileSync(FORM_PATH),
          }),
        ).rejects.toThrow("approved command executable must use an absolute path");
      });

      it("rejects a missing or unknown execution profile through the direct session API (#5048)", async () => {
        await expect(
          startLocalCredentialHelper({
            commandArgv: [process.execPath, "-e", "process.exit(0)"],
            executionProfile: "unknown" as "isolated",
            fields: [{ name: "OPENAI_API_KEY", type: "secret" }],
            formBytes: fs.readFileSync(FORM_PATH),
          }),
        ).rejects.toThrow("execution profile must be isolated or account-home");
      });
    }

    if (group === "session") {
      it("removes the isolated execution root when a session expires (#5048)", async () => {
        const rootsBefore = privateExecutionRoots();
        const session = await startLocalCredentialHelper({
          commandArgv: [process.execPath, "-e", "process.exit(0)"],
          executionProfile: "isolated",
          fields: [{ name: "OPENAI_API_KEY", type: "secret" }],
          formBytes: fs.readFileSync(FORM_PATH),
          timeoutMs: 20,
        });

        await expectCompletionCode(session.completion, 1);
        expect(privateExecutionRoots()).toEqual(rootsBefore);
      });

      it("removes the isolated execution root when the approved executable cannot start (#5048)", async () => {
        const rootsBefore = privateExecutionRoots();
        const missingExecutable = path.join(
          path.parse(process.execPath).root,
          "nemoclaw-definitely-missing-executable",
        );
        const session = await startLocalCredentialHelper({
          commandArgv: [missingExecutable],
          executionProfile: "isolated",
          fields: [
            { name: "OPENAI_API_KEY", type: "secret" },
            { name: "PUBLIC_ID", type: "text" },
          ],
          formBytes: fs.readFileSync(FORM_PATH),
        });
        const formUrl = new URL(session.url);
        const capability = new URLSearchParams(formUrl.hash.slice(1)).get("cap") ?? "";
        const accepted = await request(formUrl, {
          body: validBody(),
          headers: {
            "content-type": "application/json",
            origin: formUrl.origin,
            "x-nemoclaw-capability": capability,
          },
          method: "POST",
          path: "/submit",
        });

        expectHttpStatus(accepted, 202);
        await expectCompletionCode(session.completion, 1);
        expect(privateExecutionRoots()).toEqual(rootsBefore);
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

        const result = await withTimeout(
          captured.closed,
          PROCESS_TIMEOUT_MS,
          "modified helper form",
        );

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
        const hostileConfigRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "nemoclaw-hostile-config-"),
        );
        tempDirs.add(hostileConfigRoot);
        for (const relativePath of [".curlrc", ".gitconfig", ".netrc", ".npmrc", ".zshenv"]) {
          fs.writeFileSync(path.join(hostileConfigRoot, relativePath), "attack-marker\n");
        }
        fs.mkdirSync(path.join(hostileConfigRoot, ".git"));
        fs.writeFileSync(
          path.join(hostileConfigRoot, ".git", "config"),
          "[credential]\nhelper = attack\n",
        );
        fs.mkdirSync(path.join(hostileConfigRoot, "pip"));
        fs.writeFileSync(
          path.join(hostileConfigRoot, "pip", "pip.conf"),
          "[global]\nindex-url=attack\n",
        );
        const helper = await startHelper(
          fixture.command,
          {
            ...CONFIG_ROOT_ENV_OVERRIDES,
            ...NETWORK_TRUST_ENV_OVERRIDES,
            ...PACKAGE_CONTROL_ENV_OVERRIDES,
            BASH_ENV: "ambient-shell-hook",
            "BASH_FUNC_echo%%": '() { printf "%s" "$OPENAI_API_KEY"; }',
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
            NEMOCLAW_PROVIDER: "ambient-provider",
            OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "attacker.invalid/supervisor:latest",
            OPENAI_API_KEY: "ambient-openai-key",
            PATH: "/ambient/search/path",
            Path: "/ambient/mixed-case/search/path",
            PUBLIC_ID: "ambient-public-id",
            UNRELATED_API_TOKEN: "ambient-generic-token",
            HOME: hostileConfigRoot,
            XDG_CONFIG_HOME: hostileConfigRoot,
          },
          "isolated",
          undefined,
          hostileConfigRoot,
        );

        const accepted = await request(helper.formUrl, {
          body: validBody(),
          headers: validHeaders(helper),
          method: "POST",
          path: "/submit",
        });

        expect(accepted.status).toBe(202);
        await expectSuccessfulCompletion(helper, fixture.markerPath);
      });

      it.runIf(process.platform !== "win32" && fs.existsSync("/usr/bin/git"))(
        "blocks an ambient Git template hook from observing submitted credentials (#5048)",
        async () => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-git-template-test-"));
          tempDirs.add(dir);
          const source = path.join(dir, "source");
          const destination = path.join(dir, "clone");
          const template = path.join(dir, "template");
          const hooks = path.join(template, "hooks");
          const leakPath = path.join(dir, "leaked-secret.txt");
          fs.mkdirSync(hooks, { recursive: true });

          execFileSync("/usr/bin/git", ["init", "--quiet", source]);
          fs.writeFileSync(path.join(source, "tracked.txt"), "fixture\n");
          execFileSync("/usr/bin/git", ["-C", source, "add", "tracked.txt"]);
          execFileSync("/usr/bin/git", [
            "-C",
            source,
            "-c",
            "user.name=NemoClaw Test",
            "-c",
            "user.email=nemoclaw-test@example.invalid",
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "-m",
            "fixture",
          ]);

          const hookPath = path.join(hooks, "post-checkout");
          const quotedLeakPath = `'${leakPath.replaceAll("'", `'"'"'`)}'`;
          fs.writeFileSync(
            hookPath,
            `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > ${quotedLeakPath}\n`,
          );
          fs.chmodSync(hookPath, 0o755);

          const helper = await startHelper(
            ["/usr/bin/git", "clone", "--quiet", source, destination],
            {
              GIT_TEMPLATE_DIR: template,
            },
          );
          const accepted = await request(helper.formUrl, {
            body: validBody(),
            headers: validHeaders(helper),
            method: "POST",
            path: "/submit",
          });

          expect(accepted.status).toBe(202);
          await expect(helper.closed).resolves.toEqual({ code: 0, signal: null });
          expect(fs.readFileSync(path.join(destination, "tracked.txt"), "utf8")).toBe("fixture\n");
          expect(fs.existsSync(path.join(destination, ".git", "hooks", "post-checkout"))).toBe(
            false,
          );
          expect(fs.existsSync(leakPath)).toBe(false);
          expect(helper.output()).not.toContain(TEST_SECRET);
        },
      );

      it("uses only the explicit cwd and OS account home in account-home mode (#5048)", async () => {
        const commandCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-account-cwd-test-"));
        tempDirs.add(commandCwd);
        const markerPath = path.join(commandCwd, "account-context.json");
        const command = [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({cwd:process.cwd(),environment:Object.fromEntries(${JSON.stringify(CONFIG_ROOT_ENV_NAMES)}.map((name)=>[name,process.env[name]]))}))`,
          markerPath,
        ];
        const helper = await startHelper(
          command,
          CONFIG_ROOT_ENV_OVERRIDES,
          "account-home",
          commandCwd,
        );

        const accepted = await request(helper.formUrl, {
          body: validBody(),
          headers: validHeaders(helper),
          method: "POST",
          path: "/submit",
        });

        expect(accepted.status).toBe(202);
        await expectSuccessfulCompletion(helper, markerPath);
        const observed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
          cwd: string;
          environment: Record<string, string | undefined>;
        };
        const accountHome = os.userInfo().homedir;
        const accountTemp = path.join(accountHome, "AppData", "Local", "Temp");
        const hasWindowsDrive = /^[A-Za-z]:[\\/]/.test(accountHome);
        const expectedEnvironment: Record<string, string> =
          process.platform === "win32"
            ? {
                APPDATA: path.join(accountHome, "AppData", "Roaming"),
                ...(hasWindowsDrive
                  ? {
                      HOMEDRIVE: accountHome.slice(0, 2),
                      HOMEPATH: accountHome.slice(2) || "\\",
                    }
                  : {}),
                HOME: accountHome,
                LOCALAPPDATA: path.join(accountHome, "AppData", "Local"),
                PWD: commandCwd,
                TEMP: accountTemp,
                TMP: accountTemp,
                TMPDIR: accountTemp,
                USERPROFILE: accountHome,
              }
            : { HOME: accountHome, PWD: commandCwd };
        expect(fs.realpathSync(observed.cwd)).toBe(fs.realpathSync(commandCwd));
        expect(
          Object.fromEntries(Object.entries(observed.environment).filter(([, value]) => value)),
        ).toEqual(expectedEnvironment);
      });

      it("preserves explicit approved proxy, CA, and config arguments byte-for-byte (#5048)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-argv-test-"));
        tempDirs.add(dir);
        const markerPath = path.join(dir, "command-argv.json");
        const expectedArgv = [
          "--proxy",
          "http://trusted-proxy.internal:3128",
          "--noproxy",
          "127.0.0.1",
          "--cacert",
          "/trusted/ca.pem",
          "--config",
          "/trusted/client.conf",
          "--profile",
          "approved-profile",
        ];
        const command = [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))',
          markerPath,
          ...expectedArgv,
        ];
        const helper = await startHelper(command, NETWORK_TRUST_ENV_OVERRIDES);

        const accepted = await request(helper.formUrl, {
          body: validBody(),
          headers: validHeaders(helper),
          method: "POST",
          path: "/submit",
        });

        expect(accepted.status).toBe(202);
        await expectSuccessfulCompletion(helper, markerPath);
        expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual(expectedArgv);
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
          'echo safe >/dev/null && test ! -e "$ATTACK_MARKER" && printf "ran\\n" > "$1"',
          "bash",
          markerPath,
        ];
        const helper = await startHelper(command, {
          ATTACK_MARKER: attackMarkerPath,
          "BASH_FUNC_echo%%": '() { printf "%s" "$OPENAI_API_KEY" > "$ATTACK_MARKER"; }',
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
        expect(
          responses.filter((response) => response.status >= 200 && response.status < 300),
        ).toEqual(accepted);
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
    }
  });
}
