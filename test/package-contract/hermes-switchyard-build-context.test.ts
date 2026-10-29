// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const { createHermesPortableBuildContextPlan } = require(
  path.join(root, "dist/lib/onboard/experimental/hermes-portable-build-context.js"),
) as typeof import("../../src/lib/onboard/experimental/hermes-portable-build-context");

it.each([
  ["x86_64", "d0306ee11bf44e1845f24f4fb56e4e11986ef6ac751f3abf303aef9fe1e798d2"],
  ["arm64", "267c4fa1b0ea07a9fdff019f4791e5042f4f68093ae27a7afb7541d323b2f720"],
])(
  "ships the pinned %s Switchyard bundle and verifier through the compiled context builder (#13861)",
  (arch, digest) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-switchyard-context-"));
    try {
      const plan = createHermesPortableBuildContextPlan(root, {
        model: "qwen3-vl:4b",
        provider: "ollama-local",
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "direct",
      });
      const staged = plan.materialize({
        sandboxName: "switchyard-package",
        transactionId: "11111111-1111-4111-8111-111111111111",
        createIntentSha256: "a".repeat(64),
        stateDir,
      });
      const dockerfile = fs.readFileSync(staged.dockerfilePath, "utf8");
      expect(dockerfile).toContain(
        `ADD --checksum=sha256:${digest} https://github.com/NVIDIA/NeMo-Relay-Plugins/releases/download/switchyard-plugin-0.3.0/switchyard-plugin-0.3.0-linux-${arch}.tar.gz /switchyard.tar.gz`,
      );
      const archive = path.join(stateDir, "corrupt.tar.gz");
      fs.writeFileSync(archive, "not a reviewed release");
      const verified = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          `
import runpy, sys
from pathlib import Path
installer = runpy.run_path(sys.argv[1])
destination = Path(sys.argv[2]).with_name('installed')
try:
    installer['install'](Path(sys.argv[2]), destination, sys.argv[3], '0.21.3', '0.8.3')
except ValueError as error:
    assert str(error) == 'Switchyard archive digest mismatch'
else:
    raise AssertionError('staged verifier accepted a corrupt artifact')
assert not destination.exists()
`,
          path.join(staged.buildContextPath, "agents/hermes/install-switchyard.py"),
          archive,
          arch === "arm64" ? "aarch64" : "x86_64",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(verified.status, verified.stderr).toBe(0);
      expect(dockerfile).toContain("FROM switchyard-${TARGETARCH} AS switchyard-assets");
      expect(dockerfile).toContain(
        "COPY --from=switchyard-verified /opt/nemo-relay/plugins/switchyard/",
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
