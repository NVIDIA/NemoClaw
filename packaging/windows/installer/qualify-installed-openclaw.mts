// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI-only browser acceptance of the installed executable. Never imported by the app.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { captureOwned } from "./qualify-finished-package.mts";
import { sampleInstalledIdle } from "../tests/performance/installed-idle.mts";
import { sanitizeNativeDiagnostic } from "../runtime/native-session-diagnostics.mts";

export function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "systemroot",
    "windir",
    "systemdrive",
    "comspec",
    "path",
    "pathext",
    "temp",
    "tmp",
    "programfiles",
    "programdata",
    "userprofile",
    "localappdata",
    "appdata",
    "os",
    "processor_architecture",
    "number_of_processors",
    "github_actions",
    "psmodulepath",
    "programfiles(x86)",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

export function exactChatAddress(value: string, origin: string) {
  const actual = new URL(value),
    expected = new URL(origin);
  return (
    actual.protocol === "http:" &&
    actual.hostname === "127.0.0.1" &&
    !actual.username &&
    !actual.password &&
    actual.origin === expected.origin &&
    actual.pathname === "/chat"
  );
}

// Only errors following this exact nonce-bearing user prompt can end the wait.
export function terminalAgentError(history: unknown, prompt: string): string | null {
  if (
    !history ||
    typeof history !== "object" ||
    !("messages" in history) ||
    !Array.isArray(history.messages)
  )
    return null;
  let matched = false;
  for (const item of history.messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as {
      role?: string;
      content?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part: { type?: string; text?: unknown }) =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part: { text: string }) => part.text)
              .join("\n")
          : "";
    if (message.role === "user") {
      matched = text === prompt;
      continue;
    }
    if (!matched || message.role !== "assistant") continue;
    if (
      message.stopReason === "error" &&
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim()
    )
      return message.errorMessage.slice(0, 8192);
    // Canonical chat-history projection removes errorMessage but retains the
    // terminal stopReason and sanitized display text. Never match ordinary prose.
    if (message.stopReason === "error" && text.trim()) return text.slice(0, 8192);
    if (/^(?:⚠️?\s*)?Agent failed before reply:/u.test(text)) return text.slice(0, 8192);
  }
  return null;
}

export function toolIds(result: unknown): string[] {
  assert.ok(
    result && typeof result === "object" && "agentId" in result && result.agentId === "main",
  );
  assert.ok("groups" in result && Array.isArray(result.groups));
  return result.groups.flatMap((group: { tools: { id: string }[] }) => {
    assert.ok(Array.isArray(group.tools));
    return group.tools.map((tool) => {
      assert.equal(typeof tool.id, "string");
      return tool.id;
    });
  });
}

export function verifyToolOutput(value: unknown, expected: string) {
  assert.ok(value && typeof value === "object" && "ok" in value && value.ok === true);
  assert.ok("output" in value && value.output && typeof value.output === "object");
  const output = value.output as {
    isError?: boolean;
    details?: { exitCode?: number; status?: string };
    content?: { type: string; text?: string }[];
  };
  assert.notEqual(output.isError, true);
  if (output.details && Object.hasOwn(output.details, "exitCode"))
    assert.equal(output.details.exitCode, 0);
  if (output.details && Object.hasOwn(output.details, "status"))
    assert.equal(output.details.status, "completed");
  assert.ok(Array.isArray(output.content));
  const text = output.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  assert.ok(text.includes(expected), "The actual tool output lacks its controlled result.");
}

export function recordedExec(history: { messages?: unknown[] }, command: string, expected: string) {
  assert.ok(Array.isArray(history.messages));
  const calls = new Set<string>();
  for (const value of history.messages) {
    const message = value as {
      role?: string;
      content?: { type?: string; name?: string; id?: string; arguments?: { command?: string } }[];
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content)
      if (
        block.type === "toolCall" &&
        block.name === "exec" &&
        block.arguments?.command === command &&
        typeof block.id === "string"
      )
        calls.add(block.id);
  }
  for (const value of history.messages) {
    const message = value as { role?: string; toolName?: string; toolCallId?: string };
    if (
      message.role !== "toolResult" ||
      message.toolName !== "exec" ||
      !message.toolCallId ||
      !calls.has(message.toolCallId)
    )
      continue;
    verifyToolOutput({ ok: true, output: message }, expected);
    return message;
  }
  throw new Error("The chat lacks the matching successful shell tool execution.");
}

export function recordedFileTool(
  history: { messages?: unknown[] },
  name: "write" | "read",
  file: string,
  content: string,
) {
  assert.ok(Array.isArray(history.messages));
  for (const [index, value] of history.messages.entries()) {
    const message = value as {
      role?: string;
      content?: {
        type?: string;
        name?: string;
        id?: string;
        arguments?: { path?: string; content?: string };
      }[];
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (
        call.type !== "toolCall" ||
        call.name !== name ||
        typeof call.id !== "string" ||
        call.arguments?.path !== file ||
        (name === "write" && call.arguments.content !== content)
      )
        continue;
      for (const candidate of history.messages.slice(index + 1)) {
        const result = candidate as { role?: string; toolName?: string; toolCallId?: string };
        if (
          result.role !== "toolResult" ||
          result.toolName !== name ||
          result.toolCallId !== call.id
        )
          continue;
        verifyToolOutput({ ok: true, output: result }, name === "write" ? file : content);
        return result;
      }
    }
  }
  throw new Error("The chat lacks the matching successful " + name + " file-tool execution.");
}

export function sanitizedFailure(error: unknown, secret: string) {
  const bounded = (value: string, bytes: number) =>
    Buffer.from(secret ? value.split(secret).join("[REDACTED]") : value)
      .subarray(0, bytes)
      .toString("utf8");
  const chain: { name: string; message: string; stack: string | null }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && chain.length < 4 && !seen.has(current)) {
    seen.add(current);
    try {
      chain.push({
        name: bounded(current instanceof Error ? current.name : "NonError", 128),
        message: bounded(current instanceof Error ? current.message : String(current), 2048),
        stack:
          current instanceof Error && typeof current.stack === "string"
            ? bounded(current.stack, 6144)
            : null,
      });
      current = current instanceof Error ? current.cause : undefined;
    } catch {
      break;
    }
  }
  return { chain, truncatedOrCyclicCause: current !== undefined };
}

type FailurePage = { screenshot(options: { path: string; timeout: number }): Promise<unknown> };
export async function captureFailure(
  error: unknown,
  page: FailurePage | undefined,
  screenshot: string,
  secret: string,
) {
  const failure = {
    primary: sanitizedFailure(error, secret),
    screenshot: null as string | null,
    screenshotError: null as ReturnType<typeof sanitizedFailure> | null,
  };
  if (page)
    try {
      await page.screenshot({ path: screenshot, timeout: 5000 });
      failure.screenshot = path.basename(screenshot);
    } catch (secondary) {
      failure.screenshotError = sanitizedFailure(secondary, secret);
    }
  return failure;
}

export function decodeDiagnosticOwnerRead(stdout: string): Buffer | null {
  const lines = stdout.split(/\r?\n/u);
  if (lines.length !== 4 || lines[0] !== "READY" || lines[2] !== "OK" || lines[3] !== "")
    throw new Error("The native diagnostic reader returned invalid framing.");
  if (lines[1] === "MISS") return null;
  if (!lines[1].startsWith("OK\t")) throw new Error("The native diagnostic reader rejected ready.");
  const encoded = lines[1].slice(3);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== encoded)
    throw new Error("The native diagnostic reader returned invalid bounded data.");
  return bytes;
}

// Enumeration only selects fixed names. The installed native file owner validates
// the directory/ancestors and reads ready through its existing guarded handles.
export async function retainNativeSessionDiagnostics(
  stateRoot: string,
  readReady: (directory: string) => Promise<Buffer | null>,
  save: (name: string, document: unknown) => void,
  secret: string,
) {
  const retained: { sourceDirectory: string; output: string; sourceSha256: string }[] = [];
  if (!fs.existsSync(stateRoot)) return { status: "missing", retained };
  const root = fs.lstatSync(stateRoot);
  assert(root.isDirectory() && !root.isSymbolicLink());
  const names = fs
    .readdirSync(stateRoot)
    .filter((name) => /^session-diagnostics-[a-f0-9]{20}$/u.test(name))
    .sort();
  assert(names.length <= 8, "The fresh session has too many diagnostic documents.");
  for (const name of names) {
    const directory = path.join(stateRoot, name);
    const stat = fs.lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    const bytes = await readReady(directory);
    assert(
      bytes !== null && bytes.length <= 1024 * 1024,
      "The native diagnostic document is absent or oversized.",
    );
    const text = bytes.toString("utf8");
    assert(Buffer.from(text, "utf8").equals(bytes), "The native diagnostic document is not UTF8.");
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("The native diagnostic document is malformed.");
    }
    assert(
      document.schemaVersion === 1 &&
        document.agent === "openclaw" &&
        ["native-session-success", "native-session-failure"].includes(document.classification),
    );
    const output = `native-session-diagnostic-${retained.length}.json`;
    save(output, JSON.parse(sanitizeNativeDiagnostic(text, [secret])));
    retained.push({
      sourceDirectory: name,
      output,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { status: retained.length ? "retained" : "missing", retained };
}

function argument(name: string, fallback?: string) {
  const position = process.argv.indexOf(name);
  const value = position < 0 ? fallback : process.argv[position + 1];
  if (!value || value.startsWith("--"))
    throw new Error("Missing installed-acceptance input: " + name);
  return value;
}

type Observation = {
  kind: "observation";
  rootPid: number;
  rootStartedUtc: string;
  hostPid: number;
  hostStartedUtc: string;
  hostPath: string;
  ports: number[];
  sessionPid: number | null;
  openEnabled: boolean;
  windowFound?: boolean;
  openFound?: boolean;
  openName?: string | null;
  openControlEnabled?: boolean;
  phase?: string | null;
  status?: string | null;
};

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const install = path.resolve(argument("--install-root")),
    output = path.resolve(argument("--output"));
  const identity = JSON.parse(fs.readFileSync(argument("--runtime-identity"), "utf8"));
  const model = argument("--model", "nvidia/nemotron-3-super-120b-a12b");
  assert.match(model, /^[A-Za-z0-9._/-]{1,256}$/u);
  const secret = process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "";
  assert.ok(
    secret.startsWith("nvapi-") && secret.length <= 2048 && !/[\r\n\0]/u.test(secret),
    "An authorized NVIDIA credential is required.",
  );
  const stateRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "NVIDIA",
    "NemoClaw",
    "agents",
    "openclaw",
  );
  assert.equal(
    fs.existsSync(stateRoot),
    false,
    "Acceptance requires an unconfigured disposable runner.",
  );
  assert.equal(fs.existsSync(output), false);
  fs.mkdirSync(output, { recursive: true });
  const environment = childEnvironment(process.env);
  const launcher = path.join(install, "bin", "NemoClaw.exe");
  const ps = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const redact = (text: string) => text.split(secret).join("[REDACTED]");
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(output, name), redact(JSON.stringify(value, null, 2)) + "\n", {
      flag: "wx",
    });
  const results: Record<string, unknown> = {};
  const cleanupErrors: string[] = [];
  const cleanupErrorDetails: { action: string; failure: ReturnType<typeof sanitizedFailure> }[] =
    [];
  const cleanupFailed = (action: string, error: unknown) => {
    cleanupErrors.push(action);
    cleanupErrorDetails.push({ action, failure: sanitizedFailure(error, secret) });
  };
  let primary: unknown,
    phase = "configure",
    binding: string | undefined;
  let agent: ChildProcess | undefined, observer: ChildProcess | undefined;
  let agentClosed: Promise<number> | undefined, observerClosed: Promise<number> | undefined;
  let browser: { close(): Promise<void> } | undefined;
  let failurePage: FailurePage | undefined;
  let latest: Observation | undefined, observerFailure: Error | undefined;
  let stopInvoked = false,
    stopped = false;
  const logs = { agentStdout: "", agentStderr: "", observerStderr: "" };
  const observerStarted = performance.now();
  const observerRecords: { receivedMs: number; record: unknown }[] = [];
  let omittedObserverRecords = 0;
  const httpProbes: Record<string, unknown>[] = [];
  let omittedHttpProbes = 0;
  const processEvents: Record<
    string,
    { pid: number | undefined; exit?: unknown; close?: unknown }
  > = {};
  const observerSnapshot = () =>
    structuredClone({
      lastObservation: latest ?? null,
      records: [...observerRecords],
      omittedRecords: omittedObserverRecords,
      httpProbes: [...httpProbes],
      omittedHttpProbes,
      stopInvoked,
      stopped,
      processes: processEvents,
      observerFailure: observerFailure ? sanitizedFailure(observerFailure, secret) : null,
    });
  const command = async (name: string, args: string[], input = "") => {
    const result = await captureOwned(launcher, args, environment, input, 60_000);
    results[name] = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    assert.equal(result.failure, null, name);
    assert.equal(result.exitCode, 0, name);
    return result.stdout;
  };
  const boundedClose = async <T,>(closed: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The installed session did not finish cleanup.")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  const closed = (child: ChildProcess, label: string) =>
    new Promise<number>((resolve) => {
      const events: { pid: number | undefined; exit?: unknown; close?: unknown } = {
        pid: child.pid,
      };
      processEvents[label] = events;
      child.once("exit", (code, signal) => {
        events.exit = { code, signal, elapsedMs: performance.now() - observerStarted };
      });
      child.once("error", (error) => {
        observerFailure ??= error;
      });
      child.once("close", (code, signal) => {
        events.close = { code, signal, elapsedMs: performance.now() - observerStarted };
        resolve(code ?? 1);
      });
    });
  const capture = (child: ChildProcess, channel: "stdout" | "stderr", key: keyof typeof logs) => {
    child[channel]!.on("data", (chunk: Buffer) => {
      if (logs[key].length + chunk.length > 4 * 1024 * 1024) {
        observerFailure ??= new Error("The installed acceptance output exceeded its bound.");
        return;
      }
      logs[key] += chunk.toString("utf8");
    });
  };
  try {
    const configuration = JSON.stringify({
      schemaVersion: 1,
      classification: "nemoclaw-native-windows-agent-configuration",
      agent: "openclaw",
      inference: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
      model,
      credentialStored: true,
      profile: "personal",
      options: {},
    });
    const prepared = JSON.parse(
      await command(
        "prepare-config",
        ["--configure-native", "--agent", "openclaw", "--prepare-all"],
        configuration,
      ),
    );
    assert.equal(prepared.schemaVersion, 1);
    assert.match(prepared.inference, /^[a-f0-9]{64}$/u);
    assert.deepEqual(prepared.services, {});
    binding = prepared.inference;
    await command(
      "credential-write",
      ["--credential-write", "nvidia", "--binding", binding!],
      secret,
    );
    await command("save-config", ["--configure-native", "--agent", "openclaw"], configuration);
    const saved = JSON.parse(fs.readFileSync(path.join(stateRoot, "native-windows.json"), "utf8"));
    assert.equal(saved.inference, "nvidia");
    assert.equal(saved.model, model);
    assert.equal(saved.credentialStored, true);
    const lease = JSON.parse(
      await command("installed-identity", ["--runtime-session", "openclaw"], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ])
      assert.equal(lease[key], identity[key]);
    phase = "launch";
    agent = spawn(
      launcher,
      [
        "--configured",
        "--agent",
        "openclaw",
        "--wait",
        "--artifact-directory",
        path.join(output, "session"),
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    agentClosed = closed(agent, "guardian");
    agent.stdin!.end();
    capture(agent, "stdout", "agentStdout");
    capture(agent, "stderr", "agentStderr");
    assert.ok(agent.pid);
    // Keep the existing observer deadline; the optional sample must leave its Stop budget.
    const observerDeadline = performance.now() + 600_000;
    observer = spawn(
      ps,
      [
        "-NoProfile",
        "-File",
        path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
        "-RootProcessId",
        String(agent.pid),
        "-InstallRoot",
        install,
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    observerClosed = closed(observer, "observer");
    observer.stdin!.on("error", () => {});
    capture(observer, "stderr", "observerStderr");
    let pending = "",
      observedBytes = 0;
    observer.stdout!.on("data", (chunk: Buffer) => {
      observedBytes += chunk.length;
      if (observedBytes > 256 * 1024) {
        observerFailure ??= new Error("The owned observer output exceeded its bound.");
        return;
      }
      pending += chunk.toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === "observation") {
            assert.equal(value.rootPid, agent!.pid);
            assert.equal(
              path.resolve(value.hostPath),
              path.join(install, "runtimes", identity.runtimeId, "app", "NemoClaw.Runtime.exe"),
            );
            assert.ok(
              Array.isArray(value.ports) &&
                value.ports.every(
                  (port: number) => Number.isSafeInteger(port) && port > 0 && port <= 65535,
                ),
            );
            latest = value;
          } else if (value.kind === "stop-invoked") stopInvoked = true;
          else if (value.kind === "stop-snapshot") {
            assert.equal(value.rootPid, agent!.pid);
            assert.ok(typeof value.label === "string" && Number.isFinite(value.stopElapsedMs));
            assert.ok(Buffer.byteLength(line) <= 64 * 1024);
          } else if (value.kind === "closed") {
            assert.equal(value.exitCode, 0);
            results.nativeStop = value;
            stopped = true;
          } else throw new Error("Unexpected installed session observer record.");
          if (observerRecords.length === 128) {
            observerRecords.shift();
            omittedObserverRecords++;
          }
          observerRecords.push({ receivedMs: performance.now() - observerStarted, record: value });
        } catch (error) {
          observerFailure ??=
            error instanceof Error ? error : new Error("Invalid observer record.");
        }
      }
    });
    const started = performance.now(),
      deadline = started + 180_000;
    let origin: string | undefined;
    while (!origin && performance.now() < deadline) {
      if (observerFailure) throw observerFailure;
      assert.equal(agent.exitCode, null, "The installed session exited during startup.");
      assert.equal(observer.exitCode, null, "The owned UI observer exited during startup.");
      if (latest?.openEnabled)
        for (const port of latest.ports) {
          const candidate = `http://127.0.0.1:${port}`;
          const probe: Record<string, unknown> = {
            port,
            startedMs: performance.now() - observerStarted,
          };
          try {
            const response = await fetch(candidate + "/chat", {
              redirect: "error",
              signal: AbortSignal.timeout(1000),
            });
            probe.status = response.status;
            const type = response.headers.get("content-type") ?? "";
            probe.contentType = type.startsWith("text/html")
              ? "html"
              : type.startsWith("application/json")
                ? "json"
                : type
                  ? "other"
                  : "absent";
            const html = await response.text();
            probe.bodyBytes = Buffer.byteLength(html, "utf8");
            probe.bodyCharacters = html.length;
            probe.dashboardMarker = /<openclaw-app(?:\s|>)/u.test(html);
            if (response.ok && html.length < 65536 && /<openclaw-app(?:\s|>)/u.test(html)) {
              origin = candidate;
              break;
            }
          } catch (error) {
            // No response body, raw header, URL query or arbitrary error text is retained.
            probe.errorName = error instanceof Error ? error.name : "UnknownError";
            const cause = error instanceof Error ? error.cause : null;
            const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
            probe.errorCode =
              typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
          } finally {
            probe.completedMs = performance.now() - observerStarted;
            if (httpProbes.length === 128) {
              httpProbes.shift();
              omittedHttpProbes++;
            }
            httpProbes.push(probe);
          }
        }
      if (!origin) await sleep(500);
    }
    assert.ok(origin, "The owned installed gateway did not publish its real dashboard.");
    results.startup = { elapsedMs: performance.now() - started, observation: latest, origin };
    phase = "browser";
    const driverRoot = path.resolve(argument("--browser-driver-root"));
    const require = createRequire(path.join(driverRoot, "package.json"));
    const { chromium } = require(driverRoot);
    const edge = [
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
      process.env.PROGRAMFILES,
    ]
      .filter(Boolean)
      .map((root) => path.join(root!, "Microsoft", "Edge", "Application", "msedge.exe"))
      .find((file) => fs.existsSync(file));
    assert.ok(edge, "Microsoft Edge is required for the actual browser control.");
    const activeBrowser = await chromium.launch({
      executablePath: edge,
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    browser = activeBrowser;
    const page = await activeBrowser.newPage({ viewport: { width: 1440, height: 900 } });
    failurePage = page;
    await page.goto(origin + "/chat", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForURL((url: URL) => exactChatAddress(url.href, origin!), { timeout: 30_000 });
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(
      () => {
        const input = document.querySelector(".agent-chat__composer-combobox > textarea");
        return input instanceof HTMLTextAreaElement && !input.disabled;
      },
      undefined,
      { timeout: 90_000 },
    );
    const rpc = (method: string, params: Record<string, unknown>) =>
      boundedClose(
        page.evaluate(
          async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
            const app = document.querySelector("openclaw-app") as unknown as {
              context?: {
                gateway?: {
                  snapshot?: {
                    connected: boolean;
                    client: { request(method: string, params: unknown): Promise<unknown> };
                  };
                };
              };
            };
            const gateway = app?.context?.gateway?.snapshot;
            if (!gateway?.connected || !gateway.client)
              throw new Error("The actual browser gateway client is disconnected.");
            return await gateway.client.request(method, params);
          },
          { method, params },
        ),
        45_000,
      ) as Promise<any>;
    const sessionKey = await page.evaluate(
      () =>
        (document.querySelector("openclaw-app-shell") as unknown as { activeSessionKey?: string })
          ?.activeSessionKey,
    );
    assert.ok(
      typeof sessionKey === "string" && /^agent:main:[A-Za-z0-9:._-]+$/u.test(sessionKey),
      "The visible chat session identity is missing.",
    );
    const waitForReply = async (prompt: string, expected: string) => {
      let complete = false;
      const terminal = (async () => {
        while (!complete) {
          await sleep(1000);
          if (complete) return;
          let history: unknown;
          try {
            history = await rpc("chat.history", { sessionKey, limit: 100, maxChars: 20000 });
          } catch {
            continue;
          } // A failed diagnostic read cannot replace the ordinary reply deadline.
          if (complete) return;
          const error = terminalAgentError(history, prompt);
          if (error) throw new Error("The installed agent failed: " + error);
        }
      })();
      try {
        await Promise.race([
          page
            .getByText(expected, { exact: true })
            .last()
            .waitFor({ state: "visible", timeout: 180_000 }),
          terminal,
        ]);
      } finally {
        complete = true;
      }
    };
    phase = "nvidia-response";
    const responseStarted = performance.now();
    const nonce = randomBytes(12).toString("hex"),
      reply = "NEMOCLAW_NVIDIA_" + nonce;
    const responsePrompt = "Reply with exactly this text and no other text: " + reply;
    await composer.fill(responsePrompt);
    await composer.press("Enter");
    await waitForReply(responsePrompt, reply);
    await page.screenshot({ path: path.join(output, "nvidia-response.png") });
    results.response = {
      provider: "nvidia",
      model,
      visibleReply: reply,
      deterministicModel: false,
      elapsedMs: performance.now() - responseStarted,
    };
    phase = "tools";
    const toolsStarted = performance.now();
    const catalog = await rpc("tools.catalog", { agentId: "main", includePlugins: true });
    const effective = await rpc("tools.effective", { agentId: "main", sessionKey });
    const catalogIds = toolIds(catalog),
      effectiveIds = toolIds(effective);
    results.tools = {
      catalogIds,
      effectiveIds,
      search: {
        catalogRegistered: catalogIds.includes("web_search"),
        effectiveAvailable: effectiveIds.includes("web_search"),
        configured: false,
        liveLookup: "waived-no-key",
        liveQualified: false,
      },
    };
    for (const name of ["read", "write", "exec"])
      assert.ok(effectiveIds.includes(name), "Required effective tool unavailable: " + name);
    assert.ok(catalogIds.includes("web_search"), "The web search catalog registration is missing.");
    const file = "nemoclaw-acceptance-" + nonce + ".txt";
    // Gateway tools.invoke constructs gateway-visible tools, not the agent's
    // base coding tools. Exercise write/read through the same real model turn.
    // Local code uses the packaged Node executable through the actual shell tool.
    // OpenClaw's unrelated code_execution tool needs xAI; no extra provider is invented.
    const nodeCommand =
      "& '" +
      path.join(install, "bin", "node.exe").replaceAll("'", "''") +
      "' -e \"process.stdout.write('NEMOCLAW_CODE_" +
      nonce +
      ":'+String(6*7))\"";
    const shellCommand = "Write-Output 'NEMOCLAW_SHELL_" + nonce + "'";
    const completed = "NEMOCLAW_TOOLS_" + nonce;
    const toolPrompt =
      "Use the write tool with these exact arguments: " +
      JSON.stringify({ path: file, content: nonce }) +
      ". Then use the read tool with these exact arguments and verify the file content: " +
      JSON.stringify({ path: file }) +
      ". Then use the exec tool to run each of these exact PowerShell commands separately. Do not change the arguments or commands, or simulate tool output. First command: " +
      JSON.stringify(shellCommand) +
      ". Second: " +
      JSON.stringify(nodeCommand) +
      ". After all four tool calls succeed, reply with exactly " +
      completed;
    await composer.fill(toolPrompt);
    await composer.press("Enter");
    await waitForReply(toolPrompt, completed);
    const history = await rpc("chat.history", { sessionKey, limit: 100, maxChars: 20000 });
    results["tool-write"] = recordedFileTool(history, "write", file, nonce);
    results["tool-read"] = recordedFileTool(history, "read", file, nonce);
    results["tool-shell"] = recordedExec(history, shellCommand, "NEMOCLAW_SHELL_" + nonce);
    results["tool-local-code"] = recordedExec(
      history,
      nodeCommand,
      "NEMOCLAW_CODE_" + nonce + ":42",
    );
    await page.screenshot({ path: path.join(output, "tool-response.png") });
    results.toolsElapsedMs = performance.now() - toolsStarted;
    results.browser = {
      version: activeBrowser.version(),
      realDashboard: true,
      containedGateway: true,
    };
    // Model/tool results and their durations are already recorded. This read-only
    // companion is independent diagnostic evidence and never owns application Stop.
    if (performance.now() > observerDeadline - 45_000 - 130_000) {
      results.idleObservation = {
        status: "censored",
        reason: "The existing observer deadline must retain its normal Stop budget.",
      };
    } else {
      try {
        assert.ok(latest && agent.pid);
        results.idleObservation = await sampleInstalledIdle(
          {
            installRoot: install,
            guardianPid: agent.pid,
            guardianStartedUtc: latest.rootStartedUtc,
            hostPid: latest.hostPid,
            hostStartedUtc: latest.hostStartedUtc,
            runtimeId: identity.runtimeId,
            sourceRevision: identity.sourceRevision,
            manifestSha256: identity.manifestSha256,
          },
          path.join(output, "installed-idle.json"),
        );
      } catch (error) {
        results.idleObservation = {
          status: "failed",
          error: sanitizedFailure(error, secret),
        };
      }
    }
  } catch (error) {
    primary = error;
    results.observerAtFailure = observerSnapshot();
    try {
      write("owned-observer-at-failure.json", observerSnapshot());
    } catch (failure) {
      results.observerEvidenceFailure = sanitizedFailure(failure, secret);
    }
    results.failureDiagnostics = await captureFailure(
      error,
      failurePage,
      path.join(output, "failure.png"),
      secret,
    );
  } finally {
    const cleanupStarted = performance.now();
    if (browser)
      try {
        await browser.close();
        results.automationBrowserClosed = true;
      } catch (error) {
        cleanupFailed("automation browser", error);
      }
    if (observer && agentClosed && observerClosed) {
      try {
        observer.stdin!.end("stop\n");
        assert.equal(await boundedClose(agentClosed, 130_000), 0);
        assert.equal(await boundedClose(observerClosed, 5000), 0);
        assert.equal(stopInvoked, true);
        assert.equal(stopped, true);
        const session = path.join(output, "session");
        const receipts = fs
          .readdirSync(session)
          .filter((name) => /^native-windows-web-ui-[a-f0-9]+\.json$/u.test(name));
        assert.equal(receipts.length, 1);
        const result = JSON.parse(fs.readFileSync(path.join(session, receipts[0]), "utf8"));
        assert.equal(result.verdict, "pass");
        assert.equal(result.deterministicLocalModel, false);
        assert.equal(result.runtimeBytesCopied, 0);
        for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
          assert.equal(result.runtimeIdentity[key], identity[key]);
        assert.equal(result.backend, "process_container");
        assert.equal(result.architecture, "arm64");
        assert.notEqual(result.inferenceTransport, "contained-deterministic-model");
        for (const name of [
          "sandboxDeleted",
          "sandboxRegistryAbsent",
          "gatewayStopped",
          "qualificationRootsRemoved",
        ])
          assert.equal(result[name], true);
        results.sessionCleanup = result;
      } catch (error) {
        cleanupFailed("native Stop or backend cleanup", error);
      }
    }
    if (agent && agent.exitCode === null && agent.pid) {
      try {
        const taskkill = path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
          "System32",
          "taskkill.exe",
        );
        const killed = await captureOwned(
          taskkill,
          ["/PID", String(agent.pid), "/T", "/F"],
          environment,
          "",
          15_000,
        );
        assert.equal(killed.exitCode, 0);
        if (agentClosed) await boundedClose(agentClosed, 5000);
      } catch (error) {
        cleanupFailed("owned launcher emergency termination", error);
      }
    }
    if (observer && observer.exitCode === null) {
      try {
        observer.kill();
        if (observerClosed) await boundedClose(observerClosed, 5000);
      } catch (error) {
        cleanupFailed("owned observer", error);
      }
    }
    try {
      write("owned-session-observer.json", observerSnapshot());
      results.nativeSessionDiagnostics = await retainNativeSessionDiagnostics(
        stateRoot,
        async (directory) => {
          const reply = await captureOwned(
            launcher,
            ["--native-ui-file-owner", directory],
            environment,
            "read\tready\nclose\n",
            10_000,
          );
          assert.equal(reply.failure, null);
          assert.equal(reply.exitCode, 0);
          return decodeDiagnosticOwnerRead(reply.stdout);
        },
        write,
        secret,
      );
    } catch (error) {
      results.nativeSessionDiagnosticFailure = sanitizedFailure(error, secret);
    }
    if (binding) {
      try {
        await command("remove-configured-data", ["--remove-native-data", "--agent", "openclaw"]);
      } catch (error) {
        cleanupFailed("configured agent data", error);
      }
      try {
        await command("credential-delete", ["--credential-delete", "nvidia", "--binding", binding]);
      } catch (error) {
        cleanupFailed("NVIDIA credential deletion", error);
      }
    }
    results.cleanupElapsedMs = performance.now() - cleanupStarted;
    try {
      write("owned-process-output.json", logs);
    } catch (error) {
      primary ??= error;
    }
  }
  if (cleanupErrors.length) primary ??= new Error("Installed acceptance cleanup did not finish.");
  try {
    write("installed-openclaw-acceptance.json", {
      schemaVersion: 1,
      classification: "installed-compiled-openclaw-acceptance",
      runtime: identity,
      verdict: primary === undefined ? "pass" : "fail",
      failedStage: primary === undefined ? null : phase,
      error:
        primary instanceof Error
          ? primary.message
          : primary === undefined
            ? null
            : "Installed acceptance failed.",
      results,
      cleanupErrors,
      cleanupErrorDetails,
      primaryFailure: primary === undefined ? null : sanitizedFailure(primary, secret),
      fullProductQualification: false,
      liveSearchQualified: false,
      defaultBrowserLifetime: "delegated-to-Windows; automation browser closed separately",
    });
  } catch (error) {
    primary ??= error;
  }
  if (primary !== undefined)
    throw new Error(
      redact(primary instanceof Error ? primary.message : "Installed acceptance failed."),
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
