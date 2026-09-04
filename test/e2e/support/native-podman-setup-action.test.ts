// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  validateNativePodmanRestoreAction,
  validateNativePodmanSetupAction,
} from "../../../tools/e2e/workflow-boundary.mts";

const RESTORE_ACTION = path.resolve(".github/actions/restore-native-podman-e2e/action.yaml");
const FIXED_RESTORE_ROOT = "/usr/lib/nemoclaw-native-podman-e2e/docker-cli-restore";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function restoreRunScript(): string {
  const action = YAML.parse(fs.readFileSync(RESTORE_ACTION, "utf8")) as {
    runs: { steps: Array<{ name?: string; run?: string }> };
  };
  return String(
    action.runs.steps.find(
      ({ name }) => name === "Restore Docker CLI after native Podman execution",
    )?.run ?? "",
  );
}

type RestoreFixtureKind = "valid" | "regular-file" | "symlink";

function runRestoreFixture(kind: RestoreFixtureKind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-restore-"));
  const restoreRoot = path.join(root, "authority");
  const destination = path.join(root, "bin", "docker");
  const disabled = path.join(restoreRoot, "docker");
  fs.mkdirSync(restoreRoot, { mode: 0o700 });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const original = "#!/bin/sh\nexit 0\n";
  const expectedSha256 = createHash("sha256").update(original).digest("hex");
  fs.writeFileSync(path.join(restoreRoot, "metadata"), `${destination}\n${expectedSha256}\n`, {
    mode: 0o600,
  });
  const prepareSource = {
    valid: () => fs.writeFileSync(disabled, original, { mode: 0o755 }),
    "regular-file": () => fs.writeFileSync(disabled, "#!/bin/sh\necho tampered\n", { mode: 0o755 }),
    symlink: () => {
      const malicious = path.join(root, "malicious-docker");
      fs.writeFileSync(malicious, original, { mode: 0o755 });
      fs.symlinkSync(malicious, disabled);
    },
  } satisfies Record<RestoreFixtureKind, () => void>;
  prepareSource[kind]();

  const commandShims = [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  "$@"',
    "}",
    "stat() {",
    '  case "${2:-}" in',
    "    %u:%g:%a) printf '0:0:700\\n' ;;",
    "    %u:%g) printf '0:0\\n' ;;",
    "    *) return 64 ;;",
    "  esac",
    "}",
    "sha256sum() {",
    '  if [[ "${1:-}" == "--" ]]; then shift; fi',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\\\n")' "$1"`,
    "}",
    "find() {",
    "  printf 'docker\\nmetadata\\n'",
    "}",
  ].join("\n");
  const script = restoreRunScript()
    .replace(`restore_root=${FIXED_RESTORE_ROOT}`, `restore_root=${shellQuote(restoreRoot)}`)
    .replace(
      "/usr/bin/docker | /usr/local/bin/docker | /snap/bin/docker) ;;",
      `${destination}) ;;`,
    );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${commandShims}\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_BINARY: process.execPath,
      PATH: `${path.dirname(destination)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
  return { destination, expectedSha256, restoreRoot, result, root };
}

describe("native Podman E2E setup boundary", () => {
  it("provides Podman authority without impersonating Docker", () => {
    expect(validateNativePodmanSetupAction()).toEqual([]);
  });

  it("restores Docker only from the immutable root-owned authority", () => {
    expect(validateNativePodmanRestoreAction()).toEqual([]);
  });

  it("restores an unchanged Docker CLI and retires its authority", () => {
    const { destination, expectedSha256, restoreRoot, result, root } = runRestoreFixture("valid");

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(createHash("sha256").update(fs.readFileSync(destination)).digest("hex")).toBe(
        expectedSha256,
      );
      expect(
        spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v docker"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${path.dirname(destination)}:/usr/bin:/bin` },
        }).stdout.trim(),
      ).toBe(destination);
      expect(fs.existsSync(restoreRoot)).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["regular-file", "symlink"] as const)(
    "rejects a tampered %s restore source without modifying the Docker destination",
    (kind) => {
      const { destination, result, root } = runRestoreFixture(kind);

      try {
        expect(result.status).not.toBe(0);
        expect(fs.existsSync(destination)).toBe(false);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );
});
