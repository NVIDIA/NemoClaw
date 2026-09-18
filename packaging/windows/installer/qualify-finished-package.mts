// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI controller only. Customer launch uses the installed compiled guardian.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readOpenedRegularFile } from "../runtime/native-security.mts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error("A finished-package input is missing.");
  return path.resolve(process.argv[index + 1]);
}

export function acceptanceProcessesStopped(
  ...children: (Pick<ChildProcess, "exitCode" | "signalCode"> | undefined)[]
) {
  return children.every(
    (child) => child === undefined || child.exitCode !== null || child.signalCode !== null,
  );
}

export function retainedAcceptance(
  agent: "pi" | "hermes",
  previous: Record<string, any>,
  identity: Record<string, any>,
  configuration: string,
  controllerRun: string,
) {
  assert.match(controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  assert(
    previous?.schemaVersion === 1 &&
      previous.classification ===
        (agent === "pi"
          ? "installed-pi-terminal-acceptance"
          : "installed-canonical-hermes-acceptance") &&
      previous.verdict === "pass" &&
      previous.controllerRun === controllerRun &&
      Array.isArray(previous.cleanupErrors) &&
      previous.cleanupErrors.length === 0 &&
      previous.results?.configurationReused === false &&
      previous.results.configurationPreserved === true &&
      previous.results.cleanup?.cleanupSucceeded === true &&
      previous.results.cleanup.stateRetained === true,
    "Restart requires a successful preserved cold-run receipt",
  );
  for (const key of [
    "runtimeId",
    "manifestSha256",
    "sourceRevision",
    "nodeSha256",
    "nodeVersion",
  ]) {
    assert.match(
      identity[key],
      key === "nodeVersion"
        ? /^22\.23\.2$/u
        : key === "sourceRevision"
          ? /^[a-f0-9]{40}$/u
          : /^[a-f0-9]{64}$/u,
    );
    assert.equal(previous.runtime?.[key], identity[key], "Restart runtime identity differs");
  }
  assert.equal(
    previous.results.configurationSha256,
    createHash("sha256").update(configuration).digest("hex"),
    "Restart configuration differs from its cold run",
  );
  assert.match(
    previous.results.stateRoot,
    /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-(?:pi|hermes)$/u,
  );
  assert(previous.results.stateRoot.endsWith(`-${agent}`));
  return previous.results.stateRoot as string;
}

export async function captureOwned(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  input = "",
  timeoutMs = 600_000,
) {
  const started = performance.now();
  const child = spawn(executable, args, {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let primary: Error | undefined;
  const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  const bytes = { stdout: 0, stderr: 0 };
  const fail = (error: Error) => {
    primary ??= error;
    child.kill();
  };
  const timer = setTimeout(
    () => fail(new Error("The owned compiled-package control timed out.")),
    timeoutMs,
  );
  for (const channel of ["stdout", "stderr"] as const)
    child[channel].on("data", (chunk: Buffer) => {
      bytes[channel] += chunk.length;
      if (bytes[channel] > 8 * 1024 * 1024)
        fail(new Error("The owned compiled-package output exceeded its bound."));
      else chunks[channel].push(chunk);
    });
  child.stdin.on("error", () => {});
  child.stdin.end(Buffer.from(input, "utf8"));
  const code = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      primary ??= error;
    });
    child.once("close", (value) => resolve(value ?? 1));
  });
  clearTimeout(timer);
  return {
    exitCode: code,
    elapsedMs: performance.now() - started,
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    failure: primary?.message ?? null,
  };
}

export function qualificationEnvironment(source: NodeJS.ProcessEnv, observer = false) {
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
    "processor_architecture",
    "number_of_processors",
    "os",
  ]);
  if (observer)
    for (const key of ["github_actions", "psmodulepath", "programfiles(x86)"]) allowed.add(key);
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => allowed.has(name.toLowerCase())),
  );
}

export function environment(installRoot: string, source: NodeJS.ProcessEnv = process.env) {
  return {
    ...qualificationEnvironment(source),
    NEMOCLAW_NATIVE_INSTALL_ROOT: installRoot,
  };
}

export function smokeAgent(value: string = "openclaw") {
  assert.ok(value === "openclaw" || value === "pi", "Unsupported finished-package smoke agent.");
  return value;
}

export function turnArguments(agent: "openclaw" | "pi", output: string) {
  return [
    ...(agent === "pi"
      ? ["--runtime-host", "terminal-turn", "--agent", "pi"]
      : ["--native-turn", "--wait"]),
    "--qualification",
    "--artifact-directory",
    output,
  ];
}

export function validateTurn(
  agent: "openclaw" | "pi",
  output: string,
  systemDriveRoot = `${process.env.SystemDrive ?? "C:"}\\`,
) {
  const pattern =
    agent === "pi"
      ? /^native-windows-pi-[a-f0-9]{10}\.json$/u
      : /^native-windows-turn-[a-f0-9]+\.json$/u;
  const names = fs.readdirSync(output).filter((name) => pattern.test(name));
  assert.equal(names.length, 1, "Expected exactly one completed contained-turn receipt.");
  const file = path.join(output, names[0]);
  const content = readOpenedRegularFile(file, {
    encoding: "utf8",
    maxBytes: 1024 * 1024,
    rejectLinks: true,
  });
  assert.ok(typeof content === "string", "The completed contained-turn receipt disappeared.");
  const turn = JSON.parse(content);
  assert.equal(turn.verdict, "pass");
  if (agent === "pi") {
    assert.equal(turn.classification, "installed-nemoclaw-native-windows-pi");
    assert.equal(turn.piVersion, "0.84.1");
    assert.equal(turn.architecture, "arm64");
    assert.equal(turn.backend, "process_container");
    assert.equal(turn.deterministicLocalModel, true);
    assert.equal(turn.turnCount, 3);
    assert.equal(turn.turns?.length, 3);
    for (let index = 0; index < 3; index++) {
      const expected = `NATIVE_PI_TURN_${index + 1}_OK`;
      assert.equal(turn.turns[index].expected, expected);
      assert.equal(typeof turn.turns[index].output, "string");
      assert.ok(turn.turns[index].output.includes(expected));
      assert.ok(
        Array.isArray(turn.turns[index].modelRequests) &&
          turn.turns[index].modelRequests.length > 0 &&
          turn.turns[index].modelRequests.every((token: unknown) => token === expected),
        "The Pi turn did not confirm its local-model request.",
      );
    }
    const runId = names[0].slice("native-windows-pi-".length, -".json".length);
    for (const prefix of [
      "NemoClawNativeAgent",
      "NemoClawNativeAgentShare",
      "NemoClawNativeAgentRuntime",
    ]) {
      const ownedRoot = path.join(systemDriveRoot, `${prefix}-pi-${runId}`);
      try {
        fs.lstatSync(ownedRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error("The contained Pi turn retained an owned directory: " + ownedRoot);
    }
  } else {
    assert.equal(turn.exactReply, "CHAT_OK");
    assert.equal(turn.openClawExecutionMode, "embedded-worker");
    assert.equal(turn.workloadStopped, true);
  }
  for (const key of [
    "createWatcherStopped",
    "gatewayStopped",
    "sandboxDeleted",
    "sandboxRegistryAbsent",
    "qualificationRootsRemoved",
  ])
    assert.equal(turn[key], true, "The contained turn did not confirm owned cleanup.");
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64" || process.version !== "v22.23.2")
    throw new Error("The finished-package control requires Windows ARM64 and the pinned Node.");
  const installRoot = argument("--install-root"),
    output = argument("--output");
  const agentIndex = process.argv.indexOf("--agent");
  const agent = smokeAgent(agentIndex < 0 ? "openclaw" : (process.argv[agentIndex + 1] ?? ""));
  const identity = JSON.parse(fs.readFileSync(argument("--runtime-identity"), "utf8"));
  if (fs.existsSync(output)) throw new Error("The finished-package evidence output must be fresh.");
  fs.mkdirSync(output);
  const launcher = path.join(installRoot, "bin", "NemoClaw.exe");
  const controls: Record<string, Awaited<ReturnType<typeof captureOwned>>> = {};
  let primary: unknown;
  let stage = "capabilities";
  try {
    const run = async (name: string, args: string[], input = "") => {
      stage = name;
      const result = await captureOwned(launcher, args, environment(installRoot), input);
      controls[name] = result;
      fs.writeFileSync(path.join(output, name + ".stdout.log"), result.stdout, { flag: "wx" });
      fs.writeFileSync(path.join(output, name + ".stderr.log"), result.stderr, { flag: "wx" });
      assert.equal(result.failure, null);
      assert.equal(result.exitCode, 0, "The installed compiled control failed: " + name);
      return result.stdout;
    };
    const capabilities = JSON.parse(await run("capabilities", ["--runtime-capabilities"]));
    assert.equal(capabilities.immutableRuntime, true);
    assert.equal(capabilities.guardianEnabled, true);
    const description = JSON.parse(await run("description", ["--runtime-host", "describe"]));
    assert.equal(description.sea, true);
    assert.equal(description.node, "v22.23.2");
    const lease = JSON.parse(
      await run("runtime-identity", ["--runtime-session", agent], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ]) {
      assert.equal(typeof identity[key], "string", "The build runtime identity is incomplete.");
      assert.ok(identity[key].length > 0);
      assert.equal(lease[key], identity[key], "The installed runtime identity differs.");
    }
    assert.equal(lease.integrity, "installer-sealed-content");
    assert.equal(lease.leaseHeld, true);
    await run("contained-turn", turnArguments(agent, path.join(output, "turn")));
    validateTurn(agent, path.join(output, "turn"));
  } catch (error) {
    primary = error;
  }
  const receipt = {
    schemaVersion: 1,
    classification: "installed-finished-package-smoke",
    agent,
    validationScope: "startup-only",
    deterministicLocalModel: true,
    runtime: identity,
    verdict: primary === undefined ? "pass" : "fail",
    failedStage: primary === undefined ? null : stage,
    error:
      primary instanceof Error
        ? primary.message
        : primary === undefined
          ? null
          : "The compiled-package control failed.",
    controls,
    dashboardQualified: false,
    modelToolsQualified: false,
    fullInstalledQualification: false,
  };
  try {
    fs.writeFileSync(
      path.join(output, "finished-package-smoke.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    primary ??= error;
  }
  if (primary !== undefined) throw primary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
