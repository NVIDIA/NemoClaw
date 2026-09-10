// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI controller only. Customer launch uses the installed compiled guardian.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error("A finished-package input is missing.");
  return path.resolve(process.argv[index + 1]);
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

function environment(installRoot: string) {
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
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())),
    ),
    NEMOCLAW_NATIVE_INSTALL_ROOT: installRoot,
  };
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64" || process.version !== "v22.23.2")
    throw new Error("The finished-package control requires Windows ARM64 and the pinned Node.");
  const installRoot = argument("--install-root"),
    output = argument("--output");
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
      await run("runtime-identity", ["--runtime-session", "openclaw"], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ])
      assert.equal(lease[key], identity[key], "The installed runtime identity differs.");
    assert.equal(lease.integrity, "installer-sealed-content");
    assert.equal(lease.leaseHeld, true);
    await run("contained-turn", [
      "--native-turn",
      "--wait",
      "--qualification",
      "--artifact-directory",
      path.join(output, "turn"),
    ]);
    const names = fs
      .readdirSync(path.join(output, "turn"))
      .filter((name) => /^native-windows-turn-[a-f0-9]+\.json$/u.test(name));
    assert.equal(names.length, 1);
    const turn = JSON.parse(fs.readFileSync(path.join(output, "turn", names[0]), "utf8"));
    assert.equal(turn.verdict, "pass");
    assert.equal(turn.exactReply, "CHAT_OK");
    assert.equal(turn.openClawExecutionMode, "embedded-worker");
    for (const key of [
      "createWatcherStopped",
      "workloadStopped",
      "gatewayStopped",
      "sandboxDeleted",
      "sandboxRegistryAbsent",
      "qualificationRootsRemoved",
    ])
      assert.equal(turn[key], true, "The contained turn did not confirm owned cleanup.");
  } catch (error) {
    primary = error;
  }
  const receipt = {
    schemaVersion: 1,
    classification: "installed-finished-package-smoke",
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
