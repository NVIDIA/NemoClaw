// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

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
}
