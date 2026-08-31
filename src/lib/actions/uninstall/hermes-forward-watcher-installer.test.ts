// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");
const INSTALLER = path.join(REPOSITORY_ROOT, "scripts", "install.sh");

describe("Hermes forward installer state", () => {
  it.each([
    {
      name: "legacy row",
      registry: JSON.stringify({ sandboxes: { hermes: {} } }),
      status: 0,
      output: "8642",
    },
    {
      name: "allocated interior port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 8645 } } }),
      status: 0,
      output: "8645",
    },
    {
      name: "missing sandbox row",
      registry: JSON.stringify({ sandboxes: {} }),
      status: 1,
      output: "",
    },
    {
      name: "out-of-range port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 9000 } } }),
      status: 1,
      output: "",
    },
    {
      name: "non-number port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: "8645" } } }),
      status: 1,
      output: "",
    },
    {
      name: "fractional numeric port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 8645.5 } } }),
      status: 1,
      output: "",
    },
    { name: "malformed registry", registry: "{", status: 1, output: "" },
  ])("resolves $name without inventing recovery state", ({ registry, status, output }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-port-state-"));
    try {
      const stateDir = path.join(tmp, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "sandboxes.json"), registry);
      const result = spawnSync(
        "bash",
        ["-c", 'source "$INSTALLER" 2>/dev/null; resolve_hermes_api_port "$SANDBOX"'],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmp,
            INSTALLER,
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            SANDBOX: "hermes",
          },
        },
      );

      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout).toBe(output);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});
