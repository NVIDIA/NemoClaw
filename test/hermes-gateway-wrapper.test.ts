// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the hermes CLI wrapper (agents/hermes/hermes-wrapper.sh), which
// closes the #4975 bypass: `docker exec ... hermes gateway run` must enforce the
// same runtime-env secret boundary as the nemoclaw-start entrypoint, refusing
// raw secret-shaped env vars and never reaching the real gateway.
//
// Linux + python3 gated: the wrapper uses bash `exec` and invokes python3 (the
// shared validator). CI runs on Linux with python3 available.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WRAPPER = path.join(import.meta.dirname, "..", "agents", "hermes", "hermes-wrapper.sh");
const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);

function python3Available(): boolean {
  try {
    return spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
const canRun = process.platform === "linux" && python3Available();

type WrapperRun = {
  status: number | null;
  stderr: string;
  realInvoked: boolean;
  realArgs: string;
};

// Run the wrapper against a temp install: a copy of the wrapper alongside the
// real validator and a `hermes.real` stub. The wrapper's dev fallback resolves
// both from its own directory because the /usr/local install paths are absent.
// The stub records the args it was exec'd with so we can prove pass-through vs.
// refusal. `env` fully replaces the process env so CI-injected secret-shaped
// vars (e.g. GITHUB_TOKEN) cannot perturb the validator.
function runWrapper(
  args: string[],
  env: Record<string, string>,
  opts: { shadowPython?: boolean } = {},
): WrapperRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-"));
  try {
    fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
    fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
    fs.chmodSync(path.join(dir, "hermes"), 0o755);

    const marker = path.join(dir, "real-invoked.txt");
    fs.writeFileSync(
      path.join(dir, "hermes.real"),
      `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o755 },
    );

    // Optionally plant a malicious `python3` earlier on PATH that would no-op
    // the guard (exit 0). The wrapper must ignore it and use a trusted absolute
    // interpreter, so the guard still fires.
    let pathPrefix = "";
    if (opts.shadowPython) {
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      fs.writeFileSync(path.join(evilBin, "python3"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      pathPrefix = `${evilBin}${path.delimiter}`;
    }

    const result = spawnSync("bash", [path.join(dir, "hermes"), ...args], {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: `${pathPrefix}${process.env.PATH ?? ""}`, HOME: dir, ...env },
    });

    const realInvoked = fs.existsSync(marker);
    return {
      status: result.status,
      stderr: result.stderr ?? "",
      realInvoked,
      realArgs: realInvoked ? fs.readFileSync(marker, "utf-8") : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.sh", () => {
  it("refuses `gateway` with a raw secret-shaped env var and never starts the gateway (#4975)", () => {
    const run = runWrapper(["gateway", "run"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.stderr).toContain("process environment");
    expect(run.stderr).toContain("SLACK_BOT_TOKEN");
    expect(run.stderr).not.toContain("xoxb-real-1234567890");
    expect(run.realInvoked).toBe(false);
  });

  it("cannot be bypassed by shadowing python3 on PATH (#4981 review)", () => {
    // PATH is part of the untrusted env; a planted python3 that exits 0 must not
    // let the gateway start with a raw secret. The wrapper uses a trusted
    // absolute interpreter, so the guard still refuses.
    const run = runWrapper(
      ["gateway", "run"],
      { SLACK_BOT_TOKEN: "xoxb-real-1234567890" },
      { shadowPython: true },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.realInvoked).toBe(false);
  });

  it("allows `gateway` when only resolver placeholders / allow-listed keys are present", () => {
    const run = runWrapper(["gateway", "run"], {
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      OPENCLAW_GATEWAY_TOKEN: "raw-gateway-token",
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("gateway run");
  });

  it("passes non-gateway subcommands straight through, even with raw secrets present", () => {
    // The guard scopes to gateway startup; other subcommands must not be blocked.
    const run = runWrapper(["dashboard"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("dashboard");
  });

  it("passes --version through (build assertion path) without invoking the guard", () => {
    const run = runWrapper(["--version"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--version");
  });
});
