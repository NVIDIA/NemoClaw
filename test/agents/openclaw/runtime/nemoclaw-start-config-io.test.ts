// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);
const SANDBOX_JSON5_MODULE = "/usr/local/lib/node_modules/openclaw/node_modules/json5";

describe("sandbox OpenClaw config parser dependency", () => {
  it.each([
    START_SCRIPT,
    path.resolve(
      import.meta.dirname,
      "../../../../scripts/lib/refresh-openclaw-wechat-placeholder.py",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/messaging/channels/telegram/runtime/telegram-diagnostics.ts",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/actions/sandbox/mcp-bridge-adapter-status.ts",
    ),
    path.resolve(import.meta.dirname, "../../../../src/lib/actions/sandbox/mcp-bridge-source.ts"),
  ])(
    "loads JSON5 from the agent runtime exposed by the OpenShell filesystem policy: %s",
    (sourcePath) => {
      const source = fs.readFileSync(sourcePath, "utf-8");
      expect(source, sourcePath).toContain(SANDBOX_JSON5_MODULE);
      expect(source, sourcePath).not.toContain("/opt/nemoclaw/node_modules/json5");
    },
  );
});

describe("root OpenClaw config I/O authority", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("drops the root environment before invoking an absolute sandbox-owned writer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-env-"));
    const script = path.join(root, "run.sh");
    const handoff = path.join(root, "handoff");
    const rawSecret = "SENTINEL_ROOT_ONLY_PROVIDER_SECRET";
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { printf '0\\n'; }",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "used\\n" >${JSON.stringify(handoff)}; exec "$@"' sandbox-step-down)`,
        extractShellFunctionFromSource(src, "run_openclaw_config_as_owner"),
        `export ROOT_ONLY_SECRET=${JSON.stringify(rawSecret)}`,
        'run_openclaw_config_as_owner /usr/bin/env SAFE_INPUT=reviewed /usr/bin/python3 -I -c \'import os; print(os.environ.get("SAFE_INPUT", "")); print(os.environ.get("ROOT_ONLY_SECRET", "absent")); print(os.environ.get("HOME", ""))\'',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["reviewed", "absent", "/sandbox"]);
      expect(fs.readFileSync(handoff, "utf-8")).toBe("used\n");
      expect(result.stdout).not.toContain(rawSecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
