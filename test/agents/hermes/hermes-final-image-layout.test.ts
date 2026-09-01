// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerRunCommandBetween,
  runDockerShell,
  runLoggedDockerShell,
} from "../../helpers/dockerfile-run-shell";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const HERMES_PINNED_BASE_IMAGE =
  "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:378c7a2586261dc6ab2c36fb58f4874dde7c91587afb1efd1923227092d62ec1";
const HERMES_PINNED_BASE_LAYER_COUNT = 44;
const HERMES_COMBINED_LAYER_BUDGET = 121;
const NPM_ROOT_ARGUMENTS = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const BUILD_ONLY_MIGRATION_PATCHER_PATHS = [
  "/opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py",
  "/opt/nemoclaw-hermes-config/patch-gateway-process-identity.py",
  "/opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
  "/opt/nemoclaw-hermes-config/patch-cron-restore-drain.py",
] as const;
const HERMES_INTEGRITY_FILES = [
  {
    arg: "NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256",
    source: "agents/hermes/image-build-probes.py",
    target: "/opt/nemoclaw-hermes-config/image-build-probes.py",
  },
  {
    arg: "NEMOCLAW_HERMES_SQLITE_TEMP_STORE_PATCHER_SHA256",
    source: "agents/hermes/patch-hermes-sqlite-temp-store.py",
    target: "/usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py",
  },
  {
    arg: "NEMOCLAW_HERMES_WRAPPER_SHA256",
    source: "agents/hermes/hermes-wrapper.py",
    target: "/usr/local/lib/nemoclaw/hermes-wrapper.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CLI_ADAPTER_SHA256",
    source: "agents/hermes/hermes-cli-adapter-v1.json",
    target: "/usr/local/share/nemoclaw/hermes-cli-adapter-v1.json",
  },
  {
    arg: "NEMOCLAW_HERMES_CLI_ADAPTER_VALIDATOR_SHA256",
    source: "agents/hermes/validate-cli-adapter.py",
    target: "/usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py",
  },
  {
    arg: "NEMOCLAW_HERMES_VALIDATOR_SHA256",
    source: "agents/hermes/validate-env-secret-boundary.py",
    target: "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
  },
  {
    arg: "NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256",
    source: "agents/hermes/finalize-tirith-marker.py",
    target: "/usr/local/lib/nemoclaw/finalize-tirith-marker.py",
  },
  {
    arg: "NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256",
    source: "agents/hermes/patch-langfuse-credentials.mts",
    target: "/usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts",
  },
  {
    arg: "NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256",
    source: "agents/hermes/patch-discord-recovery-permissions.py",
    target: "/usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py",
  },
  {
    arg: "NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256",
    source: "agents/hermes/patch-gateway-runtime-metadata.py",
    target: "/opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py",
  },
  {
    arg: "NEMOCLAW_HERMES_GATEWAY_PROCESS_IDENTITY_PATCHER_SHA256",
    source: "agents/hermes/patch-gateway-process-identity.py",
    target: "/opt/nemoclaw-hermes-config/patch-gateway-process-identity.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256",
    source: "agents/hermes/patch-cron-execution-runtime.py",
    target: "/opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RESTORE_DRAIN_PATCHER_SHA256",
    source: "agents/hermes/patch-cron-restore-drain.py",
    target: "/opt/nemoclaw-hermes-config/patch-cron-restore-drain.py",
  },
  {
    arg: "NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256",
    source: "agents/hermes/cron-restore-control.py",
    target: "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
  },
  {
    arg: "NEMOCLAW_HERMES_NEUTRAL_PLATFORM_PATCHER_SHA256",
    source: "agents/hermes/patch-neutral-platform-env-activation.py",
    target: "/opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
  },
] as const;

type LegacyDataFixture =
  | "none"
  | "content"
  | "directory-symlink"
  | "entry-symlink"
  | "nested-symlink";
type OpenClawFixture = "none" | "directory" | "symlink";

interface FixturePaths {
  hermesDir: string;
  legacyDataDir: string;
  legacyTarget: string;
  openclawDir: string;
  openclawTarget: string;
}

const legacyDataSetups = {
  none: () => undefined,
  content: ({ hermesDir, legacyDataDir }: FixturePaths) => {
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "sessions", "legacy.json"), "{}\n");
    fs.writeFileSync(path.join(legacyDataDir, "legacy.txt"), "legacy\n");
    fs.symlinkSync(path.join(legacyDataDir, "sessions"), path.join(hermesDir, "sessions"));
    fs.symlinkSync(path.join(legacyDataDir, "legacy.txt"), path.join(hermesDir, "legacy.txt"));
    fs.mkdirSync(path.join(hermesDir, "profiles"), { recursive: true });
    fs.symlinkSync(
      path.join(legacyDataDir, "sessions"),
      path.join(hermesDir, "profiles", "legacy-sessions"),
    );
  },
  "directory-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(legacyTarget, { recursive: true });
    fs.writeFileSync(path.join(legacyTarget, "sentinel"), "keep\n");
    fs.symlinkSync(legacyTarget, legacyDataDir, "dir");
  },
  "entry-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(legacyTarget, "keep\n");
    fs.symlinkSync(legacyTarget, path.join(legacyDataDir, "linked-entry"));
  },
  "nested-symlink": ({ legacyDataDir, legacyTarget }: FixturePaths) => {
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(legacyTarget, "keep\n");
    fs.symlinkSync(legacyTarget, path.join(legacyDataDir, "sessions", "linked-entry"));
  },
} satisfies Record<LegacyDataFixture, (paths: FixturePaths) => void>;

const openclawSetups = {
  none: () => undefined,
  directory: ({ openclawDir }: FixturePaths) => {
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  },
  symlink: ({ openclawDir, openclawTarget }: FixturePaths) => {
    fs.mkdirSync(openclawTarget, { recursive: true });
    fs.writeFileSync(path.join(openclawTarget, "sentinel"), "keep\n");
    fs.symlinkSync(openclawTarget, openclawDir, "dir");
  },
} satisfies Record<OpenClawFixture, (paths: FixturePaths) => void>;

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function runFinalLayout({
  legacyData = "none",
  openclaw = "none",
}: {
  legacyData?: LegacyDataFixture;
  openclaw?: OpenClawFixture;
} = {}) {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-final-layout-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const hermesDir = path.join(sandboxRoot, ".hermes");
  const legacyDataDir = path.join(sandboxRoot, ".hermes-data");
  const legacyTarget = path.join(tmp, "legacy-target");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const openclawTarget = path.join(tmp, "openclaw-target");

  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n");
  fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n");

  const fixturePaths = {
    hermesDir,
    legacyDataDir,
    legacyTarget,
    openclawDir,
    openclawTarget,
  };
  legacyDataSetups[legacyData](fixturePaths);
  openclawSetups[openclaw](fixturePaths);

  const layoutCommand = dockerRunCommandBetween(
    dockerfile,
    "# Flatten stale published base images",
    "# Pin config hash at build time",
  ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
  const { result } = runDockerShell(layoutCommand, sandboxRoot);
  return { hermesDir, legacyTarget, openclawTarget, result, sandboxRoot, tmp };
}

function runNeutralPatcherCleanup() {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-neutral-patcher-"));
  const neutralPatcherPath = path.join(tmp, "patch-neutral-platform-env-activation.py");
  fs.writeFileSync(neutralPatcherPath, "build only\n", { flag: "wx" });
  const probeIndex = dockerfile.indexOf("image-build-probes.py neutral-platform-inertness");
  const runIndex = dockerfile.lastIndexOf(
    'RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]',
    probeIndex,
  );
  const command = dockerRunCommandBetween(
    dockerfile.slice(runIndex),
    'RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]',
    "RUN set -eu; \\\n    profile_probe_root=",
  ).replaceAll(
    "/opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
    neutralPatcherPath,
  );
  const result = runLoggedDockerShell(command, tmp, [], {
    env: { NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0" },
  }).result;
  return { neutralPatcherPath, result, tmp };
}

function runFinalBuildOnlyPathGuard(buildOnlyPath: string) {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-build-only-guard-"));
  const fixturePath = path.join(tmp, path.basename(buildOnlyPath));
  fs.writeFileSync(fixturePath, "build only\n", { flag: "wx" });
  const fullCommand = dockerRunCommandBetween(
    dockerfile,
    "RUN check_metadata() {",
    "# Verify the immutable security package inventory",
  ).replaceAll(buildOnlyPath, fixturePath);
  const guardedClause = `&& check_absent ${fixturePath}`;
  const guardedIndex = indexOfRequired(fullCommand, guardedClause);
  const nextClauseOffset = indexOfRequired(
    fullCommand.slice(guardedIndex + guardedClause.length),
    " && ",
  );
  const nextClauseIndex = guardedIndex + guardedClause.length + nextClauseOffset;
  const command = fullCommand.slice(0, nextClauseIndex);
  const result = runLoggedDockerShell(command, tmp).result;
  return { result, tmp };
}

describe("Hermes final image layout", () => {
  it("removes the neutral-platform patcher after its image probe", () => {
    const run = runNeutralPatcherCleanup();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(fs.existsSync(run.neutralPatcherPath)).toBe(false);
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("rejects a retained neutral-platform patcher from the final layout", () => {
    const run = runFinalBuildOnlyPathGuard(
      "/opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py",
    );
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("build-only Hermes path leaked into the final image");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it.each(BUILD_ONLY_MIGRATION_PATCHER_PATHS)(
    "rejects retained build-only migration patcher %s from the final layout",
    (buildOnlyPath) => {
      const run = runFinalBuildOnlyPathGuard(buildOnlyPath);
      try {
        expect(run.result.status).toBe(1);
        expect(run.result.stderr).toContain("build-only Hermes path leaked into the final image");
      } finally {
        fs.rmSync(run.tmp, { recursive: true, force: true });
      }
    },
  );

  it("rejects retired OpenClaw state represented as a directory", () => {
    const run = runFinalLayout({ openclaw: "directory" });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("contains retired OpenClaw state");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("rejects retired OpenClaw state represented as a symlink without following it", () => {
    const run = runFinalLayout({ openclaw: "symlink" });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("contains retired OpenClaw state");
      expect(readText(path.join(run.openclawTarget, "sentinel"))).toBe("keep\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("migrates legacy data into the current state directory", () => {
    const run = runFinalLayout({ legacyData: "content" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(
        fs.lstatSync(path.join(run.sandboxRoot, ".hermes-data"), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
      expect(fs.lstatSync(path.join(run.hermesDir, "sessions")).isDirectory()).toBe(true);
      expect(readText(path.join(run.hermesDir, "sessions", "legacy.json"))).toBe("{}\n");
      expect(fs.lstatSync(path.join(run.hermesDir, "legacy.txt")).isSymbolicLink()).toBe(false);
      expect(readText(path.join(run.hermesDir, "legacy.txt"))).toBe("legacy\n");
      const nested = path.join(run.hermesDir, "profiles", "legacy-sessions");
      expect(fs.lstatSync(nested).isDirectory()).toBe(true);
      expect(readText(path.join(nested, "legacy.json"))).toBe("{}\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it.each(["directory-symlink", "entry-symlink", "nested-symlink"] as const)(
    "refuses a legacy data %s before migration",
    (legacyData) => {
      const run = runFinalLayout({ legacyData });
      try {
        expect(run.result.status).toBe(1);
        expect(run.result.stderr).toContain("refusing legacy layout cleanup");
        const sentinel =
          legacyData === "directory-symlink"
            ? path.join(run.legacyTarget, "sentinel")
            : run.legacyTarget;
        expect(readText(sentinel)).toBe("keep\n");
      } finally {
        fs.rmSync(run.tmp, { recursive: true, force: true });
      }
    },
  );
});
