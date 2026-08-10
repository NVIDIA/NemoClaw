// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { dockerfileInstructions } from "../helpers/dockerfile-run-commands";

const COMPILER_FLAGS = [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-DNEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING=1",
  "-ffreestanding",
  "-fno-asynchronous-unwind-tables",
  "-fno-builtin",
  "-fno-ident",
  "-fno-pie",
  "-fno-stack-protector",
  "-fno-unwind-tables",
  "-no-pie",
  "-nostdlib",
  "-static",
  "-Wl,--build-id=none",
  "-Wl,-z,noexecstack",
] as const;

const MANAGED_BOOTSTRAP_BUILDER_IMAGE =
  "node:22-trixie@sha256:a566dd560283ae5615c8bb86b58fa8a1b6f3c82b492473a061672416266625da";
const MANAGED_STARTUP_RUNTIME_PATH = "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs";

function expectManagedRuntimeDiagnostic(dockerfile: string): void {
  const instructions = dockerfileInstructions(dockerfile).filter(
    (instruction) =>
      instruction.keyword === "RUN" &&
      instruction.body.includes("managed_runtime_assertion_failed()"),
  );
  expect(instructions).toHaveLength(1);
  const logicalInstruction = (instructions[0]?.body ?? "").replace(/\\\r?\n[ \t]*/gu, " ");
  const discoveryStart = logicalInstruction.indexOf("discovery_contract=");
  expect(discoveryStart).toBeGreaterThan(0);
  const functionSource = logicalInstruction.slice(0, discoveryStart).trim();

  for (const fragment of [
    "stat -c 'uid=%u gid=%g type=%F mode=%a' -- \"$nemoclaw_artifact_path\" 2>/dev/null",
    "uid=unavailable gid=unavailable type=missing mode=unavailable",
    "printf 'ERROR: managed image assertion failed: %s path=%s %s symlink=%s\\n'",
  ]) {
    expect(functionSource).toContain(fragment);
  }

  for (const assertion of [
    `test -f ${MANAGED_STARTUP_RUNTIME_PATH} || managed_runtime_assertion_failed regular-file ${MANAGED_STARTUP_RUNTIME_PATH}`,
    `test ! -L ${MANAGED_STARTUP_RUNTIME_PATH} || managed_runtime_assertion_failed non-symlink ${MANAGED_STARTUP_RUNTIME_PATH}`,
    `chown root:root ${MANAGED_STARTUP_RUNTIME_PATH} 2>/dev/null || managed_runtime_assertion_failed owner-root-root ${MANAGED_STARTUP_RUNTIME_PATH}`,
    `chmod 0444 ${MANAGED_STARTUP_RUNTIME_PATH} 2>/dev/null || managed_runtime_assertion_failed mode-0444 ${MANAGED_STARTUP_RUNTIME_PATH}`,
    `test \"$(stat -c '%u:%g:%a' ${MANAGED_STARTUP_RUNTIME_PATH} 2>/dev/null)\" = '0:0:444' || managed_runtime_assertion_failed metadata-0:0:444 ${MANAGED_STARTUP_RUNTIME_PATH}`,
  ]) {
    expect(logicalInstruction.split(assertion)).toHaveLength(2);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-image-diagnostic-"));
  const missingPath = path.join(tmp, "missing-runtime.cjs");
  const targetPath = path.join(tmp, "runtime-target.cjs");
  const linkPath = path.join(tmp, "runtime-link.cjs");
  fs.writeFileSync(targetPath, "fixture\n", { mode: 0o444 });
  fs.symlinkSync(targetPath, linkPath);
  const runDiagnostic = (artifactPath: string, invariant: string, statOutput: string) =>
    spawnSync(
      "sh",
      [
        "-c",
        [
          `stat() { printf '%s' \"$NEMOCLAW_TEST_STAT_OUTPUT\"; }`,
          functionSource,
          'managed_runtime_assertion_failed "$NEMOCLAW_TEST_INVARIANT" "$NEMOCLAW_TEST_ARTIFACT"',
        ].join("\n"),
      ],
      {
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          NEMOCLAW_TEST_ARTIFACT: artifactPath,
          NEMOCLAW_TEST_INVARIANT: invariant,
          NEMOCLAW_TEST_STAT_OUTPUT: statOutput,
        },
      },
    );

  try {
    const missing = runDiagnostic(missingPath, "regular-file", "unused");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe(
      `ERROR: managed image assertion failed: regular-file path=${missingPath} uid=unavailable gid=unavailable type=missing mode=unavailable symlink=no\n`,
    );

    const symlink = runDiagnostic(
      linkPath,
      "non-symlink",
      "uid=0 gid=0 type=symbolic link mode=777",
    );
    expect(symlink.status).toBe(1);
    expect(symlink.stdout).toBe("");
    expect(symlink.stderr).toBe(
      `ERROR: managed image assertion failed: non-symlink path=${linkPath} uid=0 gid=0 type=symbolic link mode=777 symlink=yes\n`,
    );
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
}

export function expectManagedBootstrapNativeImageContract(dockerfile: string): void {
  const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
  const builders = stages.filter((stage) =>
    stage.includes(" AS managed-bootstrap-entrypoint-builder\n"),
  );
  expect(builders).toHaveLength(1);
  const builder = builders[0] ?? "";
  const logicalBuilder = builder.replace(/\\\r?\n[ \t]*/gu, " ");

  expect(builder).toContain(
    `FROM ${MANAGED_BOOTSTRAP_BUILDER_IMAGE} AS managed-bootstrap-entrypoint-builder`,
  );
  expect(builder).not.toContain("apt-get");
  expect(builder).toContain("ARG TARGETARCH");
  expect(builder).toContain("COPY scripts/managed-bootstrap-entrypoint.c ./");
  expect(builder).toContain("COPY scripts/managed-bootstrap-trampoline.sh ./");
  expect(builder).toContain('target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"');
  expect(builder).toContain("amd64) expected_machine='Advanced Micro Devices X86-64'");
  expect(builder).toContain("arm64) expected_machine='AArch64'");
  expect(builder).toContain("unsupported managed bootstrap target architecture");
  for (const flag of COMPILER_FLAGS) expect(logicalBuilder).toContain(flag);

  for (const failClosedProbe of [
    "readelf -hW",
    "readelf -lW",
    "readelf -dW",
    "nm --undefined-only",
    "ERROR: managed bootstrap ELF has an interpreter",
    "There is no dynamic section",
  ]) {
    expect(builder).toContain(failClosedProbe);
  }

  expect(dockerfile).toContain(
    "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap",
  );
  expect(dockerfile).toContain(
    "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
  );
  expect(dockerfile).not.toContain(
    "COPY scripts/managed-bootstrap-trampoline.sh /usr/local/bin/nemoclaw-managed-bootstrap",
  );
  expect(
    dockerfile.match(
      /stat -c '%u:%g:%a' \/usr\/local\/bin\/nemoclaw-managed-bootstrap\)" = '0:0:755'/gu,
    ),
  ).toHaveLength(1);
  expect(
    dockerfile.match(
      /stat -c '%u:%g:%a' \/usr\/local\/lib\/nemoclaw\/managed-bootstrap-trampoline[.]sh\)" = '0:0:444'/gu,
    ),
  ).toHaveLength(1);
  expect(dockerfile).toContain("test ! -L /usr/local/bin/nemoclaw-managed-bootstrap");
  expect(dockerfile).toContain("test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh");
  expectManagedRuntimeDiagnostic(dockerfile);
}
