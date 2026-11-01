import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { nativeDiagnosticTail } from "./native-session-diagnostics.mts";

const TIMEOUT_MS = 300_000;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function fail(message: string): never {
  throw new Error(`Native Windows MXC turn qualification failed: ${message}`);
}

export function requiredFile(file: string, label: string) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail(`${label} is missing`);
  return resolved;
}

export function allowlistedWindowsEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const allowedNames = new Set(
    [
      "ComSpec",
      "LOCALAPPDATA",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "Path",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_ARCHITEW6432",
      "SystemDrive",
      "SystemRoot",
      "TEMP",
      "TMP",
      "windir",
    ].map((name) => name.toLowerCase()),
  );
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedNames.has(name.toLowerCase())) environment[name] = value;
  }
  return { ...environment, ...extra };
}

type NativeCommandResult = { exitCode: number; stdout: string; stderr: string };

export async function run(
  file: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  label: string,
  timeout = TIMEOUT_MS,
  diagnostics?: {
    capture(channel: string, chunk: Buffer | string): void;
  },
  ownProcess?: (child: ChildProcess) => void,
  options: { signal?: AbortSignal; quiet?: boolean } = {},
) {
  if (typeof ownProcess !== "function")
    throw new Error(`${label} requires an owner before starting a command`);
  if (options.signal?.aborted) throw new Error(`${label} cancelled`);
  if (!options.quiet) console.log(`NEMOCLAW> ${label}`);
  const child = spawn(file, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return await new Promise<NativeCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let failure: Error | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const failAndStop = (error: Error) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      stopTimer = setTimeout(() => {
        options.signal?.removeEventListener("abort", abort);
        reject(new Error(`${label} failed and its owned process did not close`, { cause: error }));
      }, 5000);
      try {
        child.kill();
      } catch {
        // The registered owner retains this process if bounded shutdown fails.
      }
    };
    const timer = setTimeout(() => {
      failAndStop(new Error(`${label} timed out`));
    }, timeout);
    const abort = () => failAndStop(new Error(`${label} cancelled`));
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      try {
        diagnostics?.capture("cli.stdout", chunk);
      } catch (error) {
        failAndStop(error instanceof Error ? error : new Error(`${label} diagnostics failed`));
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > 1024 * 1024) {
        failAndStop(new Error(`${label} exceeded its diagnostic output limit`));
      } else stdout += stdoutDecoder.write(bytes);
    });
    child.stderr.on("data", (chunk) => {
      if (failure) return;
      try {
        diagnostics?.capture("cli.stderr", chunk);
      } catch (error) {
        failAndStop(error instanceof Error ? error : new Error(`${label} diagnostics failed`));
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > 1024 * 1024) {
        failAndStop(new Error(`${label} exceeded its diagnostic output limit`));
      } else stderr += stderrDecoder.write(bytes);
    });
    child.once("error", (error) => {
      if (child.pid) failAndStop(error);
      else {
        clearTimeout(timer);
        clearTimeout(stopTimer);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode !== 0) {
        const secrets = Object.entries(environment ?? {})
          .filter(([name]) => /token|key|secret|password/iu.test(name))
          .map(([, value]) => String(value));
        for (let index = 0; index + 1 < args.length; index++) {
          if (args[index] !== "--env") continue;
          const assignment = String(args[index + 1]);
          const split = assignment.indexOf("=");
          if (split >= 0 && /token|key|secret|password/iu.test(assignment.slice(0, split)))
            secrets.push(assignment.slice(split + 1));
        }
        const detail = [
          stdout.trim() ? `stdout:\n${nativeDiagnosticTail(stdout, secrets)}` : "",
          stderr.trim() ? `stderr:\n${nativeDiagnosticTail(stderr, secrets)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        reject(new Error(`${label} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(result);
    });
    try {
      ownProcess(child);
    } catch (error) {
      failAndStop(error instanceof Error ? error : new Error(`${label} ownership failed`));
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  child.kill();
  return await Promise.race([exited, sleep(5000).then(() => false)]);
}

export async function removeDirectory(directory: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(directory)) return true;
    await sleep(1000);
  }
  return false;
}
