// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageMeetsMinimumGlibc } from "../../src/lib/sandbox-base-image/image-compatibility.js";
import { testTimeoutOptions } from "../helpers/timeouts.js";

const RUN_DOCKER_E2E = process.env.NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E === "1";
const TEST_IMAGE = process.env.NEMOCLAW_TEST_IMAGE ?? "nemoclaw-production";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cleanupProbeContainers(realDocker: string, probeNamesPath: string): void {
  [...new Set(fs.readFileSync(probeNamesPath, "utf8").trim().split("\n").filter(Boolean))].forEach(
    (probeName) => spawnSync(realDocker, ["rm", "-f", probeName], { stdio: "ignore" }),
  );
}

describe.runIf(RUN_DOCKER_E2E)("sandbox base-image glibc Docker lifecycle", () => {
  it(
    "removes a retained first probe before accepting the retry (#8375)",
    testTimeoutOptions(150_000),
    () => {
      const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
      execFileSync(realDocker, ["image", "inspect", TEST_IMAGE], { stdio: "ignore" });

      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-glibc-probe-"));
      const shimPath = path.join(fixtureDir, "docker");
      const firstProbeNamePath = path.join(fixtureDir, "first-probe-name");
      const probeNamesPath = path.join(fixtureDir, "probe-names");
      const markerPath = path.join(fixtureDir, "first-probe-created");
      const logPath = path.join(fixtureDir, "docker-shim.log");
      const hadOriginalPath = Object.hasOwn(process.env, "PATH");
      const originalPath = process.env.PATH ?? "";
      let firstProbeName = "";

      fs.writeFileSync(probeNamesPath, "");

      const shim = `#!/usr/bin/env bash
set -euo pipefail
real_docker=${shellQuote(realDocker)}
test_image=${shellQuote(TEST_IMAGE)}
marker=${shellQuote(markerPath)}
name_file=${shellQuote(firstProbeNamePath)}
probe_names_file=${shellQuote(probeNamesPath)}
log_file=${shellQuote(logPath)}

if [[ "\${1:-}" == "run" ]]; then
  probe_name=""
  for ((index = 1; index <= \$#; index += 1)); do
    if [[ "\${!index}" == "--name" ]]; then
      name_index=\$((index + 1))
      probe_name="\${!name_index}"
      break
    fi
  done
  printf '%s\n' "\$probe_name" >>"\$probe_names_file"
  if [[ ! -e "\$marker" ]]; then
    : >"\$marker"
    printf '%s\n' "\$probe_name" >"\$name_file"
    printf 'retained %s\n' "\$probe_name" >>"\$log_file"
    "\$real_docker" create --name "\$probe_name" --entrypoint /usr/bin/ldd "\$test_image" --version >/dev/null
    exit 124
  fi
  printf 'retried %s\n' "\$probe_name" >>"\$log_file"
elif [[ "\${1:-}" == "rm" && "\${2:-}" == "-f" ]]; then
  printf 'removed %s\n' "\${3:-}" >>"\$log_file"
fi

exec "\$real_docker" "\$@"
`;

      fs.writeFileSync(shimPath, shim, { mode: 0o755 });
      process.env.PATH = `${fixtureDir}:${originalPath}`;

      try {
        expect(imageMeetsMinimumGlibc(TEST_IMAGE, "2.17")).toEqual({
          ok: true,
          version: expect.stringMatching(/^\d+(?:\.\d+)+$/),
        });

        firstProbeName = fs.readFileSync(firstProbeNamePath, "utf8").trim();
        expect(firstProbeName).toMatch(/^nemoclaw-glibc-probe-/);
        expect(
          spawnSync(realDocker, ["container", "inspect", firstProbeName], {
            stdio: "ignore",
          }).status,
        ).not.toBe(0);
        const lifecycleLog = fs.readFileSync(logPath, "utf8").trim().split("\n");
        expect(lifecycleLog).toEqual([
          `retained ${firstProbeName}`,
          `removed ${firstProbeName}`,
          expect.stringMatching(/^retried nemoclaw-glibc-probe-/),
        ]);
        expect(lifecycleLog[2]).not.toBe(`retried ${firstProbeName}`);
      } finally {
        Reflect.deleteProperty(process.env, "PATH");
        [originalPath]
          .filter(() => hadOriginalPath)
          .forEach((savedPath) => Reflect.set(process.env, "PATH", savedPath));
        cleanupProbeContainers(realDocker, probeNamesPath);
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});
