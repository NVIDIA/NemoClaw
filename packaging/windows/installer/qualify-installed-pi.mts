// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI acceptance uses the installed native onboarding and real Pi terminal.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acceptanceProcessesStopped,
  captureOwned,
  retainedAcceptance,
} from "./qualify-finished-package.mts";
import { childEnvironment, sanitizedFailure } from "./qualify-installed-openclaw.mts";
import { nativeCredentialBinding, readOpenedRegularFile } from "../runtime/native-security.mts";
import { recordedPiReply } from "./installed-pi-session.mts";

type Document = Record<string, any>;
function argument(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? fallback : process.argv[at + 1];
  assert(value && !value.startsWith("--"), "Missing Pi acceptance input: " + name);
  return value;
}
async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pi acceptance operation timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function closed(child: ChildProcess) {
  const result = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  void result.catch(() => {});
  return result;
}

export function piAcceptanceChallenge(nonce: string, fileTools = false) {
  assert.match(nonce, /^[a-f0-9]{20}$/u);
  const reply = "PI_REPLY_" + nonce;
  const file = { path: `qualification-${nonce}.txt`, content: `PI_FILE_${nonce}\n` };
  const instruction = fileTools
    ? `Use the write tool to create ${file.path} in the current directory containing PI_FILE_${nonce} followed by one newline. Wait for success, then use the read tool to read the entire file, without offset or limit. After both tools succeed, `
    : "";
  const prompt =
    instruction +
    `Reply with exactly the concatenation of PI_, REPLY_, and ${nonce}. No spaces or other text.` +
    (fileTools ? " Use no other tools." : " Do not use tools.");
  assert(!prompt.includes(reply), "An echoed prompt must not satisfy the screen check");
  return { prompt, reply, ...(fileTools ? { file } : {}) };
}

export function retainedPiAcceptance(
  previous: Document,
  identity: Document,
  configuration: string,
  controllerRun: string,
) {
  const stateRoot = retainedAcceptance("pi", previous, identity, configuration, controllerRun);
  assert(
    previous.results.realTerminal === true &&
      previous.results.realModelReply === true &&
      previous.results.fileToolsQualified === true,
    "Pi restart requires a successful preserved cold-run receipt",
  );
  return stateRoot;
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const install = path.resolve(argument("--install-root"));
  const output = path.resolve(argument("--output"));
  const identity = JSON.parse(fs.readFileSync(argument("--runtime-identity"), "utf8"));
  const model = argument("--model", "nvidia/nemotron-3-super-120b-a12b");
  const secret = process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "";
  assert(/^nvapi-[^\r\n\0]{1,2042}$/u.test(secret), "An authorized NVIDIA credential is required");
  assert(!fs.existsSync(output), "Pi evidence must be fresh");
  fs.mkdirSync(output, { recursive: true });
  const launcher = path.join(install, "bin/NemoClaw.exe");
  const pwsh = path.join(process.env.ProgramFiles!, "PowerShell/7/pwsh.exe");
  const state = path.join(process.env.LOCALAPPDATA!, "NVIDIA/NemoClaw/agents/pi");
  const environment = childEnvironment(process.env);
  delete environment.GITHUB_ACTIONS;
  const observerEnvironment = { ...environment, GITHUB_ACTIONS: "true" };
  const reuse = process.argv.includes("--reuse-configuration");
  const preserve = process.argv.includes("--preserve-configuration");
  const results: Document = {
    realTerminal: false,
    realModelReply: false,
    networkQualification: false,
  };
  const cleanupErrors: string[] = [];
  let primary: unknown,
    phase = "preflight",
    stateOwned = false,
    binding: string | undefined;
  let guardian: ChildProcess | undefined, observer: ChildProcess | undefined;
  let guardianClosed: Promise<number> | undefined, observerClosed: Promise<number> | undefined;
  let quitRequested = false,
    observerFailure: Error | undefined;
  let waiting: { resolve(value: Document): void; reject(error: Error): void } | undefined;
  let request: ((command: Document) => Promise<Document>) | undefined;
  const session = path.join(output, "session");
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
  const read = (name: string): Document | null => {
    const content = readOpenedRegularFile(path.join(session, name), {
      encoding: "utf8",
      maxBytes: 1024 * 1024,
      rejectLinks: true,
    });
    if (content === null) return null;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("Invalid Pi session receipt");
    }
  };
  const command = async (name: string, args: string[], input = "") => {
    const value = await captureOwned(launcher, args, environment, input);
    assert.equal(value.failure, null, name);
    assert.equal(value.exitCode, 0, name);
    return value.stdout;
  };
  const until = async <T,>(inspect: () => Promise<T | null>, timeout: number): Promise<T> => {
    const deadline = performance.now() + timeout;
    do {
      if (observerFailure) throw observerFailure;
      if (guardian && guardian.exitCode !== null)
        throw new Error("The installed Pi guardian exited before acceptance");
      if (read("session-failure.json"))
        throw new Error("The installed Pi backend failed; see its retained session receipt");
      const value = await inspect();
      if (value !== null) return value;
      await sleep(250);
    } while (performance.now() < deadline);
    throw new Error("The installed Pi stage exceeded its deadline");
  };
  try {
    if (!reuse)
      assert(!fs.existsSync(state), "Fresh Pi acceptance cannot replace saved configuration");
    const configurationPath = path.join(state, "native-windows.json");
    const retainedState = reuse
      ? retainedPiAcceptance(
          JSON.parse(
            readOpenedRegularFile(argument("--previous-acceptance"), {
              encoding: "utf8",
              maxBytes: 1024 * 1024,
              rejectLinks: true,
            }) ?? "null",
          ),
          identity,
          readOpenedRegularFile(configurationPath, {
            encoding: "utf8",
            maxBytes: 64 * 1024,
            rejectLinks: true,
          }) ?? "",
          `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
        )
      : undefined;
    const ownedState = JSON.parse(await command("private state", ["--state-session", "pi"]));
    assert.equal(ownedState.agent, "pi");
    assert.equal(ownedState.leaseHeld, true);
    assert.match(ownedState.stateRoot, /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-pi$/u);
    assert(
      reuse || ownedState.created === true,
      "Fresh Pi acceptance cannot use pre-existing agent data",
    );
    if (reuse)
      assert(
        ownedState.created === false && ownedState.stateRoot === retainedState,
        "Pi restart cannot claim different or recreated agent data",
      );
    stateOwned = true;
    results.stateRoot = ownedState.stateRoot;
    const configuration = {
      agent: "pi",
      inference: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
    };
    binding = nativeCredentialBinding(configuration);
    if (!reuse) {
      phase = "onboarding";
      const receipt = path.join(output, "native-onboarding.json");
      const onboard = await captureOwned(
        pwsh,
        [
          "-NoProfile",
          "-File",
          fileURLToPath(new URL("./control-installed-hermes-onboarding.ps1", import.meta.url)),
          "-Agent",
          "pi",
          "-InstallRoot",
          install,
          "-Model",
          model,
          "-OutputPath",
          receipt,
        ],
        { ...observerEnvironment, NVIDIA_API_KEY: secret },
        "",
        180_000,
      );
      assert.equal(onboard.failure, null);
      assert.equal(onboard.exitCode, 0, "Native Pi onboarding failed");
      results.onboarding = JSON.parse(fs.readFileSync(receipt, "utf8"));
      for (const key of ["passed", "nativeWpf", "integrationChoicesUnavailable", "cleanupClosed"])
        assert.equal(results.onboarding[key], true, key);
      assert.equal(results.onboarding.successfulConfigurationSaves, 1);
    }
    const configurationText = readOpenedRegularFile(configurationPath, {
      encoding: "utf8",
      maxBytes: 64 * 1024,
      rejectLinks: true,
    });
    assert(configurationText !== null, "Saved Pi configuration is missing");
    const saved = JSON.parse(configurationText);
    results.configurationSha256 = createHash("sha256").update(configurationText).digest("hex");
    for (const [key, value] of Object.entries({
      ...configuration,
      model,
      profile: "personal",
      credentialStored: true,
    }))
      assert(saved[key] === value, "Pi configuration differs from onboarding");
    assert.equal(
      fs
        .readFileSync(path.join(path.dirname(path.dirname(state)), "active-agent.txt"), "utf8")
        .trim(),
      "pi",
      "Ordinary launch must remember Pi",
    );
    const capabilities = JSON.parse(await command("capabilities", ["--runtime-capabilities"]));
    assert(capabilities.immutableRuntime === true && capabilities.guardianEnabled === true);
    const description = JSON.parse(await command("runtime host", ["--runtime-host", "describe"]));
    assert(description.sea === true && description.node === "v22.23.2");
    const lease = JSON.parse(
      await command("runtime identity", ["--runtime-session", "pi"], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ])
      assert.equal(lease[key], identity[key], key);
    results.runtime = lease;
    phase = "terminal-startup";
    fs.mkdirSync(session);
    const startedAt = Date.now(),
      started = performance.now();
    guardian = spawn(
      launcher,
      ["--wait", "--console-qualification", "--artifact-directory", session],
      { env: environment, stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    guardianClosed = closed(guardian);
    const ready = await until(async () => read("interactive-session-start.json"), 120_000);
    assert(
      ready.schemaVersion === 1 &&
        ready.agent === "pi" &&
        ready.agentRuntimeRoot === ownedState.stateRoot,
    );
    assert(Number.isSafeInteger(ready.nodeProcessId) && ready.nodeProcessId > 0);
    const runtimeRoot = path.join(install, "runtimes", identity.runtimeId);
    observer = spawn(
      pwsh,
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./control-installed-pi-console.ps1", import.meta.url)),
        "-RootProcessId",
        String(guardian.pid),
        "-RuntimeProcessId",
        String(ready.nodeProcessId),
        "-InstallRoot",
        install,
        "-RuntimeRoot",
        runtimeRoot,
        "-StateRoot",
        ownedState.stateRoot,
      ],
      { env: observerEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    observerClosed = closed(observer);
    observer.stdin!.on("error", () => {
      observerFailure = new Error("The Pi observer input closed");
    });
    observer.stderr!.resume();
    let buffer = "",
      attached = false;
    observer.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString("utf8");
      try {
        assert(buffer.length <= 12 * 1024 * 1024, "Pi observer response exceeded its bound");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const value = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (!attached && value.kind === "attached") attached = true;
          else if (value.kind === "closed" && quitRequested) {
            /* guardian exit is checked separately */
          } else {
            assert(waiting, "Unexpected Pi observer response");
            const pending = waiting;
            waiting = undefined;
            pending.resolve(value);
          }
        }
      } catch {
        observerFailure = new Error("The Pi observer protocol failed");
        waiting?.reject(observerFailure);
        waiting = undefined;
      }
    });
    observerClosed.then(
      () => {
        if (!quitRequested) observerFailure = new Error("The Pi observer exited before Stop");
        waiting?.reject(new Error("The Pi observer closed during a request"));
        waiting = undefined;
      },
      () => {
        observerFailure = new Error("The Pi observer could not start");
      },
    );
    request = async (value) => {
      assert(!waiting && !observerFailure, "The Pi observer is not available");
      const response = new Promise<Document>((resolve, reject) => {
        waiting = { resolve, reject };
      });
      observer!.stdin!.write(JSON.stringify(value) + "\n");
      return bounded(response, 15_000);
    };
    await until(async () => (attached ? true : null), 30_000);
    await until(async () => {
      const bootstrap = read("bootstrap-connectivity.json");
      if (!bootstrap) return null;
      assert(
        bootstrap.agent === "pi" &&
          bootstrap.nodeProcessId === ready.nodeProcessId &&
          bootstrap.verdict === "pass",
      );
      assert(
        bootstrap.hostListener?.httpStatus === 403 &&
          bootstrap.contained?.unauthenticatedStatus === 403 &&
          bootstrap.contained?.authenticatedStatus === 200 &&
          bootstrap.contained?.bootstrapConsumedByWorkload === true,
      );
      const view = await request!({ action: "ready" });
      return view.kind === "ready" && view.rawInput === true && view.screenNonempty === true
        ? bootstrap
        : null;
    }, 120_000);
    results.startupElapsedMs = performance.now() - started;
    results.realTerminal = true;
    phase = "model-conversation";
    let sessionId: string | undefined;
    results.turns = [];
    for (let turn = 0; turn < 2; turn++) {
      const challenge = piAcceptanceChallenge(randomBytes(10).toString("hex"), turn === 1);
      const turnStart = performance.now();
      const submitted = await request({ action: "submit", text: challenge.prompt });
      assert.equal(submitted.kind, "submitted");
      const proof = await until(async () => {
        const view = await request!({ action: "observe", expected: challenge.reply });
        if (view.kind !== "screen" || view.containsReply !== true || view.rawInput !== true)
          return null;
        const evidence = await request!({ action: "sessions" });
        assert(
          evidence.kind === "sessions" &&
            Array.isArray(evidence.documents) &&
            evidence.documents.length <= 8,
        );
        for (const encoded of evidence.documents) {
          assert(typeof encoded === "string" && encoded.length <= 1398104);
          const text = Buffer.from(encoded, "base64").toString("utf8");
          const first = text.slice(0, text.indexOf("\n"));
          if (!first) continue;
          let header;
          try {
            header = JSON.parse(first);
          } catch {
            throw new Error("Invalid Pi conversation header");
          }
          if (Date.parse(header.timestamp) < startedAt) continue;
          const value = recordedPiReply(text, {
            ...challenge,
            model,
            cwd: ownedState.stateRoot,
            startedAt,
            sessionId,
          });
          if (value) return value;
        }
        return null;
      }, 120_000);
      sessionId = proof.sessionId;
      results.turns.push({
        ...proof,
        elapsedMs: performance.now() - turnStart,
        visibleInTerminal: true,
      });
    }
    results.realModelReply = true;
    assert.equal(
      results.turns[1].fileTools,
      true,
      "Pi must complete the write/read tool roundtrip",
    );
    results.fileToolsQualified = true;
    results.configurationReused = reuse;
    phase = "stop";
    quitRequested = true;
    assert.equal((await request({ action: "quit" })).kind, "stop-requested");
    assert.equal(await bounded(guardianClosed, 130_000), 0);
    assert.equal(await bounded(observerClosed, 10_000), 0);
    const end = read("console-cleanup.json");
    assert(end?.agent === "pi");
    for (const key of [
      "sandboxDeleted",
      "gatewayStopped",
      "ephemeralRootsRemoved",
      "stateRetained",
      "leaseReleased",
      "cleanupSucceeded",
    ])
      assert.equal(end[key], true, key);
    for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
      assert.equal(end.runtimeIdentity[key], identity[key]);
    results.cleanup = end;
  } catch (error) {
    primary = error;
  } finally {
    if (guardian?.exitCode === null && request && !quitRequested) {
      try {
        quitRequested = true;
        await request({ action: "quit" });
        if (guardianClosed) await bounded(guardianClosed, 130_000);
      } catch {
        cleanupErrors.push("Pi terminal Stop");
      }
    }
    if (guardian?.exitCode === null && guardian.pid) {
      cleanupErrors.push("Pi required emergency guardian termination");
      await captureOwned(
        path.join(process.env.SystemRoot!, "System32/taskkill.exe"),
        ["/PID", String(guardian.pid), "/T", "/F"],
        environment,
        "",
        15_000,
      );
      if (guardianClosed)
        await bounded(guardianClosed, 5000).catch(() =>
          cleanupErrors.push("Pi guardian remains live"),
        );
    }
    if (observer?.exitCode === null) {
      observer.kill();
      if (observerClosed)
        await bounded(observerClosed, 5000).catch(() =>
          cleanupErrors.push("Pi observer remains live"),
        );
    }
    if (!acceptanceProcessesStopped(guardian, observer)) {
      cleanupErrors.push(
        "Processes remain live or unconfirmed; saved data and credentials retained",
      );
    } else if (stateOwned && (!preserve || primary !== undefined || cleanupErrors.length)) {
      try {
        await command("remove owned Pi data", ["--remove-native-data", "--agent", "pi"]);
      } catch {
        cleanupErrors.push("Pi saved data");
      }
      if (binding)
        try {
          await command("remove Pi credential", [
            "--credential-delete",
            "nvidia",
            "--binding",
            binding,
          ]);
        } catch {
          cleanupErrors.push("Pi NVIDIA credential");
        }
    }
  }
  if (cleanupErrors.length) primary ??= new Error("Pi cleanup did not complete");
  results.configurationPreserved = preserve && primary === undefined;
  write("installed-pi-acceptance.json", {
    schemaVersion: 1,
    classification: "installed-pi-terminal-acceptance",
    controllerRun: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
    runtime: identity,
    verdict: primary === undefined ? "pass" : "fail",
    failedStage: primary === undefined ? null : phase,
    error: primary === undefined ? null : sanitizedFailure(primary, secret),
    results,
    cleanupErrors,
    fullInstalledQualification: false,
  });
  if (primary !== undefined)
    throw new Error("Installed Pi acceptance failed; see its sanitized receipt");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(
      sanitizedFailure(
        error,
        process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "",
      ),
    );
    process.exitCode = 1;
  });
