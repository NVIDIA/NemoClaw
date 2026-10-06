// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  cleanupStationRuntime,
  stationVolumeBaseline,
} from "../../../tools/e2e/dgx-station-cleanup.mts";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getManagedInferenceCompiledRecipe } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { isHostLocalInferenceServingRecipe } from "../../../src/lib/inference/serving/adapter-registry.ts";
import { materializeHostLocalVllmModel } from "../../../src/lib/inference/serving/host-local-vllm-selection.ts";
import {
  buildVllmServeCommand,
  resolveVllmModelAlias,
} from "../../../src/lib/inference/vllm-models.ts";
import { detectVllmProfile, resolveVllmModelRuntime } from "../../../src/lib/inference/vllm.ts";
import { parseStrictOpenShellSandboxListJson } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

export const STATION_SMOKE_SANDBOX = "e2e-station-express";
export const STATION_SMOKE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const STATION_SMOKE_PHASES = [
  "inspect the prepared Station",
  "install Station Express from the candidate checkout",
  "assert managed Ultra and routed inference",
  "clean up the job runtime",
] as const;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  requireCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "Station smoke received an invalid record",
  );
  return value as Record<string, unknown>;
}
function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Station smoke received invalid JSON; inspect the command artifact");
  }
}

export function stationSmokeEnvironment(
  base: NodeJS.ProcessEnv,
  repoRoot: string,
): NodeJS.ProcessEnv {
  const workspace = base.NEMOCLAW_STATION_WORKSPACE ?? "";
  requireCondition(
    /^\/var\/tmp\/nemoclaw-station-e2e\/[a-f0-9]{64}$/u.test(workspace),
    "Station smoke requires a dispatcher-owned job workspace",
  );
  const runnerHome = base.NEMOCLAW_STATION_RUNNER_HOME ?? "";
  requireCondition(
    path.isAbsolute(runnerHome) &&
      path.normalize(runnerHome) === runnerHome &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(runnerHome) &&
      base.HOME === runnerHome,
    "Station smoke requires the configured runner HOME",
  );
  requireCondition(
    /^[a-f0-9]{40}$/u.test(base.E2E_MANAGED_IMAGE_REVISION ?? ""),
    "Station smoke requires an exact managed-image revision",
  );
  return {
    ...buildAvailabilityProbeEnv(base),
    HOME: base.HOME,
    PATH: base.PATH,
    TMPDIR: `/tmp/ncs/${path.basename(workspace)}`,
    XDG_BIN_HOME: `${runnerHome}/.local/bin`,
    XDG_CACHE_HOME: `${runnerHome}/.cache`,
    XDG_CONFIG_HOME: `${runnerHome}/.config`,
    XDG_DATA_HOME: `${runnerHome}/.local/share`,
    XDG_STATE_HOME: `${runnerHome}/.local/state`,
    XDG_RUNTIME_DIR: base.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS,
    npm_config_prefix: `${workspace}/npm-prefix`,
    GITHUB_ACTIONS: "true",
    E2E_MANAGED_IMAGE_REVISION: base.E2E_MANAGED_IMAGE_REVISION,
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_REPO_ROOT: repoRoot,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_SANDBOX_NAME: STATION_SMOKE_SANDBOX,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_PROVIDER: "",
    NEMOCLAW_MODEL: "",
    NEMOCLAW_VLLM_MODEL: "",
    NEMOCLAW_VLLM_EXTRA_ARGS_JSON: "",
    NEMOCLAW_DGX_STATION_PEER: "",
    NEMOCLAW_NON_INTERACTIVE_SUDO_MODE: "",
    NEMOCLAW_NO_EXPRESS: "",
    NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "",
    NEMOCLAW_LOCAL_MODEL_RUNTIME: "",
    NEMOCLAW_GATEWAY_PORT: "8080",
    NEMOCLAW_DASHBOARD_PORT: "18789",
    NEMOCLAW_VLLM_PORT: "8000",
    DOCKER_CONTEXT: "default",
    DOCKER_HOST: "",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
}

export function stationModelCacheMetadata(home: string): { sha256: string; entries: number } {
  const root = path.join(
    home,
    ".cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
  );
  const rows: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      requireCondition(rows.length < 10_000, "Station model cache metadata exceeds its bound");
      requireCondition(
        !/[\u0000-\u001f\u007f-\u009f]/u.test(name),
        "Station model cache contains an unsafe filename",
      );
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(root, file);
      const kind = stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other";
      requireCondition(kind !== "other", "Station model cache contains a special file");
      rows.push(
        JSON.stringify([
          relative,
          kind,
          stat.isFile() ? stat.size : 0,
          stat.isSymbolicLink() ? fs.readlinkSync(file) : "",
        ]),
      );
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
  requireCondition(rows.length > 0, "Station model cache is empty");
  return {
    sha256: createHash("sha256").update(rows.join("\n")).digest("hex"),
    entries: rows.length,
  };
}

export function stationVllmCommands(): readonly string[] {
  const recipe = getManagedInferenceCompiledRecipe(
    "vllm.nemotron-3-ultra-550b-a55b-nvfp4.station-arm64-single.v1",
  );
  requireCondition(
    recipe && isHostLocalInferenceServingRecipe(recipe) && recipe.spec.serve.directInstall,
    "Station Ultra serving recipe is unavailable",
  );
  const registered = resolveVllmModelAlias("nemotron-3-ultra-550b-a55b");
  const profile = detectVllmProfile({ platform: "station" });
  requireCondition(registered && profile, "Station Ultra runtime is unavailable");
  requireCondition(
    recipe.spec.model.id === "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4" &&
      registered.id === recipe.spec.model.id &&
      recipe.spec.model.servedName === STATION_SMOKE_MODEL,
    "Station smoke requires the default Ultra weights and serving alias",
  );
  return [
    buildVllmServeCommand(
      materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "station"),
      {},
    ),
    buildVllmServeCommand(
      resolveVllmModelRuntime({ ...profile, buildDockerRunFlags: undefined }, registered, "arm64")
        .model,
      {},
    ),
  ];
}

export function assertStationVllm(output: string): string {
  const values = parseJson(output);
  requireCondition(
    Array.isArray(values) && values.length === 1,
    "Station smoke requires exactly one managed vLLM container",
  );
  const value = record(values[0]);
  const config = record(value.Config);
  const args = config.Cmd;
  const labels = record(config.Labels);
  requireCondition(
    record(value.State).Running === true && labels["com.nvidia.nemoclaw.managed-vllm"] === "true",
    "Station managed vLLM must be running",
  );
  requireCondition(
    JSON.stringify(config.Entrypoint) === JSON.stringify(["/bin/bash"]) &&
      Array.isArray(args) &&
      args.length === 2 &&
      args[0] === "-lc" &&
      stationVllmCommands().includes(args[1]),
    "Station Express must serve the default Ultra model",
  );
  requireCondition(
    typeof value.Image === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.Image),
    "Station vLLM image identity is invalid",
  );
  return value.Image;
}

export function assertStationReady(output: string): void {
  const rows = parseStrictOpenShellSandboxListJson(output);
  requireCondition(
    rows?.length === 1 &&
      rows[0].name === STATION_SMOKE_SANDBOX &&
      ["ready", "running"].includes(rows[0].phase.toLowerCase()),
    "Station Express must produce exactly its ready sandbox",
  );
}

export function assertStationWorkload(value: unknown, revision: string): void {
  const registry = record(value);
  const entry = record(record(registry.sandboxes)[STATION_SMOKE_SANDBOX]);
  const workload = record(entry.workload);
  requireCondition(
    workload.kind === "managed-image" && workload.sourceRevision === revision,
    "Station sandbox must use the independently selected managed-image revision",
  );
}

export function assertStationInference(output: string): void {
  const response = record(parseJson(output));
  const choices = response.choices;
  requireCondition(
    response.model === STATION_SMOKE_MODEL && Array.isArray(choices) && choices.length > 0,
    "Station inference must come from the default Ultra model",
  );
  const content = record(record(choices[0]).message).content;
  requireCondition(
    typeof content === "string" && content.trim().length > 0,
    "Station routed inference returned no assistant content",
  );
}

export async function runStationExpressSmoke(options: {
  host: Pick<HostCliClient, "command">;
  cleanup: Pick<CleanupRegistry, "add" | "runAll">;
  sandbox: Pick<SandboxClient, "exec">;
  environment: NodeJS.ProcessEnv;
  repoRoot: string;
  phases: { inspect(): void; install(): void; assert(): void; cleanup(): void };
  writeEvidence: (name: string, value: unknown) => Promise<unknown>;
  now?: () => number;
  modelCacheMetadata?: () => ReturnType<typeof stationModelCacheMetadata>;
}): Promise<void> {
  const env = stationSmokeEnvironment(options.environment, options.repoRoot);
  const now = options.now ?? (() => performance.now());
  const command = async (label: string, executable: string, args: string[], timeoutMs = 30_000) => {
    const result = await options.host.command(executable, args, {
      env,
      cwd: options.repoRoot,
      artifactName: label,
      timeoutMs,
    });
    requireCondition(
      result.exitCode === 0 && !result.timedOut,
      `${label} failed; inspect its command artifact`,
    );
    return result.stdout;
  };
  options.phases.inspect();
  requireCondition(
    (
      await command("station-platform", "bash", [
        "--noprofile",
        "--norc",
        "-c",
        "source scripts/install.sh >/dev/null; detect_express_platform",
      ])
    ).trim() === "DGX Station",
    "Station smoke requires qualified Station hardware and release metadata",
  );
  const initialContainers = await command("station-initial-containers", "docker", [
    "container",
    "ls",
    "--all",
    "--quiet",
  ]);
  requireCondition(
    initialContainers.trim() === "",
    "Station smoke requires an empty dedicated Docker host",
  );
  requireCondition(
    !fs.existsSync(path.join(env.HOME!, ".nemoclaw")),
    "Station smoke requires fresh installer state",
  );
  const initialVolumes = (
    await command("station-initial-volumes", "docker", ["volume", "ls", "--quiet"])
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  stationVolumeBaseline(initialVolumes);
  const initialImages = (
    await command("station-initial-images", "docker", ["image", "ls", "--quiet", "--no-trunc"])
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const modelCacheMetadata =
    options.modelCacheMetadata ?? (() => stationModelCacheMetadata(env.HOME!));
  const cacheBefore = modelCacheMetadata();
  await options.writeEvidence("station-model-cache-baseline.json", cacheBefore);
  const timings: Record<string, number | string> = {};
  const started = now();
  let vllmImage: string | undefined;
  let failure: unknown;
  options.cleanup.add("clean up Station job runtime", async () => {
    const cleanupStarted = now();
    try {
      const runtimeCleanup = await cleanupStationRuntime({
        home: env.HOME!,
        repoRoot: options.repoRoot,
        baselineVolumes: initialVolumes,
        command,
      });
      await options.writeEvidence("station-runtime-cleanup.json", runtimeCleanup);
      requireCondition(
        (
          await command("station-remaining-containers", "docker", [
            "container",
            "ls",
            "--all",
            "--quiet",
          ])
        ).trim() === "",
        "Station cleanup left a container behind",
      );
      const volumes = (
        await command("station-remaining-volumes", "docker", ["volume", "ls", "--quiet"])
      )
        .split(/\r?\n/u)
        .filter(Boolean)
        .sort();
      requireCondition(
        JSON.stringify(volumes) === JSON.stringify(initialVolumes),
        "Station cleanup changed the preserved volume baseline",
      );
      if (vllmImage)
        await command("station-preserved-vllm-image", "docker", ["image", "inspect", vllmImage]);
      requireCondition(
        JSON.stringify(modelCacheMetadata()) === JSON.stringify(cacheBefore),
        "Station cleanup changed model cache paths, sizes, or symlink targets",
      );
      timings.cleanup = "succeeded";
    } catch (error) {
      timings.cleanup = "failed";
      throw error;
    } finally {
      timings.cleanupMs = now() - cleanupStarted;
      timings.totalMs = now() - started;
      await options.writeEvidence("station-express-timings.json", timings);
    }
  });
  options.phases.install();
  try {
    await command(
      "station-express-install",
      "bash",
      ["install.sh", "--express-install", "--yes-i-accept-third-party-software"],
      40 * 60_000,
    );
    timings.installMs = now() - started;
    options.phases.assert();
    assertStationReady(
      await command("station-sandbox-ready", "openshell", ["sandbox", "list", "-o", "json"]),
    );
    timings.installToReadyMs = now() - started;
    vllmImage = assertStationVllm(
      await command("station-managed-vllm", "docker", [
        "inspect",
        "--format",
        '[{"Image":{{json .Image}},"State":{"Running":{{json .State.Running}}},"Config":{"Cmd":{{json .Config.Cmd}},"Entrypoint":{{json .Config.Entrypoint}},"Labels":{"com.nvidia.nemoclaw.managed-vllm":{{json (index .Config.Labels "com.nvidia.nemoclaw.managed-vllm")}}}}}]',
        "nemoclaw-vllm",
      ]),
    );
    requireCondition(
      initialImages.includes(vllmImage),
      "The selected Station vLLM image was not pre-pulled",
    );
    assertStationWorkload(
      parseJson(fs.readFileSync(path.join(env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8")),
      env.E2E_MANAGED_IMAGE_REVISION!,
    );
    const response = await options.sandbox.exec(
      STATION_SMOKE_SANDBOX,
      [
        "curl",
        "-q",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "90",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        JSON.stringify({
          model: STATION_SMOKE_MODEL,
          messages: [{ role: "user", content: "Reply with one word: PONG" }],
          max_tokens: 512,
        }),
      ],
      { env, artifactName: "station-routed-inference", timeoutMs: 120_000 },
    );
    requireCondition(
      response.exitCode === 0 && !response.timedOut,
      "Station sandbox inference request failed; inspect its artifact",
    );
    assertStationInference(response.stdout);
    timings.assertMs = now() - started - Number(timings.installMs);
  } catch (error) {
    timings.installMs ??= now() - started;
    failure = error;
  } finally {
    try {
      options.phases.cleanup();
    } catch (error) {
      failure ??= error;
    }
    const cleanupResult = await options.cleanup.runAll();
    await options.writeEvidence("station-cleanup.json", cleanupResult);
    if (cleanupResult.failures.length > 0) {
      const cleanupError = new Error("Station runtime cleanup failed; inspect cleanup evidence");
      failure = failure
        ? new AggregateError([failure, cleanupError], "Station smoke and cleanup failed")
        : cleanupError;
    }
  }
  if (failure) throw failure;
}
