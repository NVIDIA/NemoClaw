// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

function extractAptInstallBlock(dockerfile: string): string {
  const match = dockerfile.match(
    /RUN\s+apt-get update\s*&&\s*apt-get install -y --no-install-recommends[\s\S]*?&&\s*rm -rf \/var\/lib\/apt\/lists\/\*/m,
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("Hermes share mount package parity (#2947)", () => {
  it("includes gnupg, procps, and openssh-sftp-server in Hermes base apt packages", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const aptBlock = extractAptInstallBlock(dockerfile);

    expect(aptBlock).toContain("gnupg=2.2.40-1.1+deb12u2");
    expect(aptBlock).toContain("procps=2:4.0.2-3");
    expect(aptBlock).toContain("openssh-sftp-server=1:9.2p1-2+deb12u9");
  });
});
