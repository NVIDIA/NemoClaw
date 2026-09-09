// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

describe("inference route command dependencies", () => {
  let tmp: string;
  let callsFile: string;
  let openshell: string;

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-route-deps-"));
    callsFile = path.join(tmp, "openshell.calls");
    openshell = path.join(tmp, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$*" = "inference get -g nemoclaw-19090" ]; then
  printf 'Gateway inference:\n  Provider: selected-provider\n  Model: selected-model\n'
  exit 0
fi
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  printf 'Gateway inference:\n  Provider: wrong-provider\n  Model: wrong-model\n'
  exit 0
fi
exit 0
`,
    );
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "19090");
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", openshell);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("routes list inference reads through the selected gateway (#10671)", async () => {
    const { buildListCommandDeps } = await import("./list-command-deps");

    expect(buildListCommandDeps().getLiveInference()).toEqual({
      provider: "selected-provider",
      model: "selected-model",
    });
    expect(fs.readFileSync(callsFile, "utf8").trim()).toBe("inference get -g nemoclaw-19090");
  });

  it("routes global status inference reads through the selected gateway (#10671)", async () => {
    const { buildStatusCommandDeps } = await import("./status-command-deps");

    expect(buildStatusCommandDeps(tmp).getLiveInference()).toEqual({
      provider: "selected-provider",
      model: "selected-model",
    });
    expect(fs.readFileSync(callsFile, "utf8").trim()).toBe("inference get -g nemoclaw-19090");
  });
});
