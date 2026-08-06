// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioral contract for the OPENCLAW_GATEWAY_TOKEN trust-anchor reconcile
// block emitted into /tmp/nemoclaw-proxy-env.sh by scripts/nemoclaw-start.sh.
// Exercises the actual emitted shell (extracted from the script) under POSIX
// sh (dash), not a re-implementation. Regression: a blind assignment aborted
// sourcing with the shell's raw readonly error (exit 2) when the sourcing shell
// had already pinned OPENCLAW_GATEWAY_TOKEN readonly to a conflicting value
// (#8428).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sliceBlock } from "./helpers/corporate-ca-support";

const OPENCLAW_START = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
const RECONCILE = sliceBlock(
  OPENCLAW_START,
  "# nemoclaw-gateway-token-reconcile start",
  "# nemoclaw-gateway-token-reconcile end",
);
const REAL_TOKEN = "REAL-GATEWAY-TOKEN-abc123";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Scenario {
  intended: string;
  preset?: { value: string; readonly: boolean };
}

function runReconcile(scenario: Scenario): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-token-reconcile-"));
  tmpRoots.push(dir);
  const envFile = join(dir, "proxy-env.sh");
  // The reconcile block reads $_nemoclaw_gateway_token (set by the URL
  // case above it in the real file) and prints the resolved value on success.
  const body = [
    `_nemoclaw_gateway_token='${scenario.intended}'`,
    RECONCILE,
    "printf 'FINAL_TOKEN=[%s]\\n' \"${OPENCLAW_GATEWAY_TOKEN-<UNSET>}\"",
    "",
  ].join("\n");
  writeFileSync(envFile, body, { mode: 0o444 });
  const presetPrefix = scenario.preset
    ? `${scenario.preset.readonly ? "readonly " : ""}OPENCLAW_GATEWAY_TOKEN='${scenario.preset.value}'; `
    : "";
  // Mirror the reporter's exact invocation shape: `sh -c '<preset>; . <file>'`.
  const result = spawnSync("sh", ["-c", `${presetPrefix}. '${envFile}'`], {
    encoding: "utf-8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("proxy-env OPENCLAW_GATEWAY_TOKEN trust-anchor reconcile (#8428)", () => {
  it("emits a controlled conflict diagnostic instead of the raw readonly abort", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      preset: { value: "SENTINEL_CONFLICT", readonly: true },
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Error: conflicting trust anchor");
    expect(stderr).not.toContain("is read only");
    // The trusted token must never be echoed on the conflict path.
    expect(`${stdout}\n${stderr}`).not.toContain(REAL_TOKEN);
    expect(stdout).not.toContain("FINAL_TOKEN=");
  });

  it("advances the anchor to the intended token on a fresh (unset) source", () => {
    const { status, stdout, stderr } = runReconcile({ intended: REAL_TOKEN });
    expect(status).toBe(0);
    expect(stdout).toContain(`FINAL_TOKEN=[${REAL_TOKEN}]`);
    expect(stderr).not.toContain("conflicting trust anchor");
  });

  it("is a no-op when the readonly pin already holds the intended value", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      preset: { value: REAL_TOKEN, readonly: true },
    });
    expect(status).toBe(0);
    expect(stdout).toContain(`FINAL_TOKEN=[${REAL_TOKEN}]`);
    expect(stderr).not.toContain("conflicting trust anchor");
    expect(stderr).not.toContain("is read only");
  });

  it("keeps the non-loopback empty-token case exported-empty, not conflicting", () => {
    const { status, stdout } = runReconcile({ intended: "" });
    expect(status).toBe(0);
    expect(stdout).toContain("FINAL_TOKEN=[]");
  });

  it("advances a writable pre-existing value (repeated non-readonly source)", () => {
    const { status, stdout } = runReconcile({
      intended: REAL_TOKEN,
      preset: { value: REAL_TOKEN, readonly: false },
    });
    expect(status).toBe(0);
    expect(stdout).toContain(`FINAL_TOKEN=[${REAL_TOKEN}]`);
  });
});
