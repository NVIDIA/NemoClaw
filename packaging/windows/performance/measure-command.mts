// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import {
  identity,
  measuredCommand,
  startupSpans,
  assertMeasurementDeadline,
  installedOpenClawReplayDeadline,
  createCommandOutputRecorder,
} from "./measurement.mts";

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("Performance commands run only on the disposable GitHub Windows ARM64 runner.");
  const [planPath, outputPath] = process.argv.slice(2);
  if (!planPath || !outputPath || fs.existsSync(outputPath))
    throw new Error("A fresh command receipt and reviewed plan are required.");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (
    plan.schemaVersion !== 1 ||
    plan.fixtureOnly !== true ||
    typeof plan.executable !== "string" ||
    !/^[a-f0-9]{64}$/u.test(plan.sha256 ?? "") ||
    !/^[a-f0-9]{40}$/u.test(plan.source ?? "") ||
    !Array.isArray(plan.args) ||
    plan.args.length > 64 ||
    plan.args.some((arg: unknown) => typeof arg !== "string" || arg.length > 4096) ||
    !Number.isSafeInteger(plan.timeoutMs) ||
    plan.timeoutMs < 1
  )
    throw new Error("The reviewed Windows measurement command is invalid.");
  if (
    plan.deadlineContract !== undefined &&
    (plan.deadlineContract !== installedOpenClawReplayDeadline.contract ||
      plan.source !== installedOpenClawReplayDeadline.source ||
      plan.action !== "launch" ||
      path.basename(plan.executable).toLowerCase() !== "node.exe" ||
      path.basename(plan.args[2] ?? "") !== "profile-installed-openclaw.mts" ||
      !plan.driverFiles?.some((driver: { path: string }) => driver.path === plan.args[2]))
  )
    throw new Error("The extended deadline is restricted to the pinned installed OpenClaw replay.");
  assertMeasurementDeadline(plan.timeoutMs, plan.deadlineContract);
  if (plan.driverFiles !== undefined) {
    if (!Array.isArray(plan.driverFiles) || plan.driverFiles.length > 16)
      throw new Error("Driver identity list is invalid.");
    for (const driver of plan.driverFiles) {
      if (
        typeof driver.path !== "string" ||
        !/^[a-f0-9]{64}$/u.test(driver.sha256 ?? "") ||
        identity(driver.path).sha256 !== driver.sha256
      )
        throw new Error("A reviewed scenario driver differs from its pinned input.");
    }
  }
  const executable = identity(plan.executable);
  if (executable.sha256 !== plan.sha256)
    throw new Error("The measured executable differs from its immutable input.");
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.OPENCLAW_GATEWAY_STARTUP_TRACE;
  const instrumentation: Record<string, unknown> = { mode: "none", percentagesInvented: false };
  const capture = new AbortController();
  let traceBudget: ReturnType<typeof setInterval> | undefined;
  if (plan.diagnostics === true) {
    const traces = path.join(path.dirname(outputPath), "node-traces");
    fs.mkdirSync(traces);
    const flags = [
      "--cpu-prof",
      "--cpu-prof-interval=1000",
      "--cpu-prof-dir=" + traces,
      "--trace-event-categories=v8,node.environment,node.module_timer,node.fs.sync,node.fs.async,node.fs_dir.sync,node.fs_dir.async",
      "--trace-event-file-pattern=" + path.join(traces, "node-${pid}-${rotation}.json"),
    ];
    environment.NODE_OPTIONS = flags.map((flag) => JSON.stringify(flag)).join(" ");
    environment.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    instrumentation.mode = "Node CPU/fs + official OpenClaw startup trace";
    instrumentation.flags = flags;
    instrumentation.scope =
      "only processes inheriting these variables; contained runtimes may filter them";
    instrumentation.overheadExcludedFromTimingComparison = true;
    instrumentation.maximumNodeTraceBytes = 256 * 1024 * 1024;
    traceBudget = setInterval(() => {
      try {
        const size = fs
          .readdirSync(traces)
          .reduce((sum, name) => sum + fs.statSync(path.join(traces, name)).size, 0);
        if (size > 256 * 1024 * 1024) {
          instrumentation.capped = true;
          capture.abort();
        }
      } catch {
        instrumentation.captureError = true;
        capture.abort();
      }
    }, 500);
  }
  let result;
  let durableOutput: ReturnType<typeof createCommandOutputRecorder> | undefined;
  let primary: unknown;
  let failed = false;
  try {
    durableOutput = createCommandOutputRecorder(path.dirname(outputPath));
    result = await measuredCommand({
      executable: plan.executable,
      args: plan.args,
      environment,
      cwd: plan.cwd ?? path.dirname(plan.executable),
      timeoutMs: plan.timeoutMs,
      deadlineContract: plan.deadlineContract,
      onOutput: durableOutput.write,
      marker: plan.configurationLogMarker ?? null,
      signal: capture.signal,
      onSpawn: (pid) => fs.writeFileSync(outputPath + ".pid", String(pid) + "\n", { flag: "wx" }),
    });
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    clearInterval(traceBudget);
    try {
      durableOutput?.close();
    } catch (error) {
      if (!failed) {
        primary = error;
        failed = true;
      }
    }
  }
  if (failed) throw primary;
  if (!result) throw new Error("The measured command did not return a result.");
  const receipt = {
    classification: "windows-performance-command",
    source: plan.source,
    executable,
    driverFiles: plan.driverFiles ?? [],
    args: plan.args,
    fixtureStateLabel: plan.fixtureStateLabel ?? "not supplied",
    instrumentation,
    configurationLogMarker: plan.configurationLogMarker ?? null,
    endpointReconstruction: plan.configurationLogMarker
      ? "reviewed literal marker; not the unavailable original user trace"
      : "unidentified; no config-log metric inferred",
    startupSpans: startupSpans(result.lines),
    otherMilestones: {
      setupVisible: null,
      backendUiReady: null,
      firstUsableScreen: null,
      firstModelResponse: null,
    },
    ...result,
  };
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  if (
    result.timedOut ||
    result.aborted ||
    result.observerError ||
    result.spawnError ||
    !result.closed ||
    result.exitCode !== 0
  )
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
