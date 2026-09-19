// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  identity,
  measuredCommand,
  installedOpenClawReplayDeadline,
  createCommandOutputRecorder,
} from "./measurement.mts";
import { makeDiagnosticReplay } from "./profile-replay.mts";

export function assertDashboardReceipt(receipt: unknown) {
  if (!receipt || typeof receipt !== "object")
    throw new Error("No installed dashboard receipt was retained.");
  const r = receipt as Record<string, unknown>;
  if (
    r.classification !== "installed-nemoclaw-native-windows-openclaw-control-ui" ||
    r.verdict !== "pass" ||
    r.turnCount !== 3 ||
    r.onboardingSkipped !== true ||
    r.deterministicLocalModel !== true ||
    r.inferenceTransport !== "contained-deterministic-model" ||
    ![
      "sandboxDeleted",
      "sandboxRegistryAbsent",
      "gatewayStopped",
      "qualificationRootsRemoved",
    ].every((key) => r[key] === true) ||
    !Array.isArray(r.turns) ||
    r.turns.length !== 3 ||
    r.turns.some(
      (turn, index) =>
        !turn || turn.visible !== true || turn.expected !== `NATIVE_WINDOWS_TURN_${index + 1}_OK`,
    )
  )
    throw new Error("The actual baseline dashboard or its owned cleanup did not finish.");
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("Profiling replay is limited to a disposable GitHub Windows ARM64 runner.");
  const [directory, mode] = process.argv.slice(2);
  const temporary = process.env.RUNNER_TEMP;
  if (
    !directory ||
    !temporary ||
    !["ordinary", "diagnostic"].includes(mode ?? "") ||
    fs.existsSync(directory) ||
    !path
      .resolve(directory)
      .toLowerCase()
      .startsWith(path.resolve(temporary).toLowerCase() + path.sep)
  )
    throw new Error("Profiling requires a fresh owned output and explicit replay mode.");
  fs.mkdirSync(directory);
  const installRoot = path.join(process.env.ProgramFiles ?? "", "NVIDIA", "NemoClaw");
  const lock = JSON.parse(
    fs.readFileSync(new URL("./profiling-baseline.lock.json", import.meta.url), "utf8"),
  );
  const inputs = [];
  for (const file of lock.files) {
    const actual = identity(path.join(installRoot, ...file.path.split("/")));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new Error("An installed baseline input differs from the pinned f8 payload.");
    inputs.push({ relativePath: file.path, ...actual });
  }
  const node = path.join(installRoot, "bin", "node.exe");
  const installedRunner = path.join(
    installRoot,
    "qualification",
    "run-installed-native-web-ui.mts",
  );
  let runner = installedRunner;
  if (mode === "diagnostic") {
    const adapted = makeDiagnosticReplay(
      fs.readFileSync(installedRunner, "utf8"),
      path.dirname(installedRunner),
      fileURLToPath(new URL("./profile-replay.mts", import.meta.url)),
    );
    runner = path.join(directory, "diagnostic-runner.mts");
    fs.writeFileSync(runner, adapted.source, { flag: "wx" });
    fs.writeFileSync(
      path.join(directory, "exact-replay-delta.json"),
      JSON.stringify(
        { ...adapted, source: undefined, diagnosticOnly: true, installedRuntimeModified: false },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
  const applicationEvidence = path.join(directory, "application");
  fs.mkdirSync(applicationEvidence);
  let result: Awaited<ReturnType<typeof measuredCommand>> | undefined;
  let primary: unknown;
  let failed = false;
  let dashboard: unknown;
  const durableOutput = createCommandOutputRecorder(directory);
  try {
    result = await measuredCommand({
      executable: node,
      args: [
        "--experimental-strip-types",
        "--no-warnings",
        runner,
        "--qualification",
        "--skip-onboarding",
        "--agent",
        "openclaw",
        "--artifact-directory",
        applicationEvidence,
      ],
      environment: { ...process.env, NEMOCLAW_NATIVE_INSTALL_ROOT: installRoot },
      cwd: installRoot,
      timeoutMs: installedOpenClawReplayDeadline.applicationMs,
      deadlineContract: installedOpenClawReplayDeadline.contract,
      onOutput: durableOutput.write,
      marker: null,
      onSpawn: (pid) =>
        fs.writeFileSync(
          path.join(directory, "application-process.json"),
          JSON.stringify({
            schemaVersion: 1,
            pid,
            executable: node,
            source: lock.source,
            createdAt: new Date().toISOString(),
          }) + "\n",
          { flag: "wx" },
        ),
    });
    fs.writeFileSync(
      path.join(directory, "application-command.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    // Retain literal observed output; no invented nested startup timestamps.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.spawnError ||
      result.observerError ||
      result.outputExceeded ||
      !result.closed
    )
      throw new Error(
        "The installed OpenClaw replay failed or exceeded its diagnostic sample bound; literal output is retained.",
      );
    const receipts = fs
      .readdirSync(applicationEvidence)
      .filter((name) => /^native-windows-web-ui-[a-f0-9]+\.json$/u.test(name));
    if (receipts.length !== 1)
      throw new Error("The baseline did not publish one actual dashboard receipt.");
    dashboard = JSON.parse(fs.readFileSync(path.join(applicationEvidence, receipts[0]!), "utf8"));
    assertDashboardReceipt(dashboard);
    if (mode === "diagnostic") {
      const model = fs
        .readFileSync(
          path.join(applicationEvidence, "contained-traces", "model-timing.jsonl"),
          "utf8",
        )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const turns = model.filter((r) => r.method === "POST" && r.status === 200);
      if (
        turns.length < 3 ||
        turns.some(
          (r) =>
            r.realProviderLatency !== false || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0,
        )
      )
        throw new Error("The separate deterministic model timing evidence is incomplete.");
    }
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    try {
      durableOutput.close();
    } catch (error) {
      if (!failed) {
        primary = error;
        failed = true;
      }
    }
    const receipt = {
      schemaVersion: 1,
      classification: "installed-baseline-openclaw-profile-replay",
      source: lock.source,
      mode,
      inputs,
      installedRuntimeModified: false,
      artifactAcceptanceClaimed: false,
      beforeAfterComparison: false,
      liveTavilyTested: false,
      modelLatency:
        mode === "diagnostic"
          ? "separate deterministic contained handler only"
          : "not separately instrumented",
      elapsedMs: result?.elapsedMs ?? null,
      applicationClosed: result?.closed ?? false,
      rootTerminationConfirmed: result?.rootTerminationConfirmed ?? false,
      timedOut: result?.timedOut ?? false,
      observerDeadline: installedOpenClawReplayDeadline,
      censoredByOuterDeadline: result?.timedOut ?? false,
      aborted: result?.aborted ?? false,
      applicationExitCode: result?.exitCode ?? null,
      dashboard,
      complete: !failed,
      error: primary instanceof Error ? primary.message : null,
      stageMeasurementsAvailable: false,
      relayCountersAvailable: false,
    };
    try {
      fs.writeFileSync(
        path.join(directory, "profile-session.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      if (!failed) {
        primary = error;
        failed = true;
      }
    }
  }
  if (failed) throw primary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "The baseline profiling driver failed.");
    process.exitCode = 1;
  });
