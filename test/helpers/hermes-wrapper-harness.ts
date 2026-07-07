// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared test harness for the Hermes CLI wrapper suites
// (test/hermes-gateway-wrapper.test.ts and
// test/hermes-wrapper-oneshot-routing.test.ts). Both suites drive
// agents/hermes/hermes-wrapper.py by copying it into a temp dir alongside the
// runtime-env validator, planting stubs, and spawning it. Extracted here — a
// non-`.test.` module — so the shared `runWrapper` helper (and its planted-PATH
// `if` branch) lives in one place instead of being duplicated across the two
// files that were split for the test-file-size budget.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "agents",
  "hermes",
  "hermes-wrapper.py",
);
export const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);

export function python3Available(): boolean {
  try {
    return spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
export const canRun = process.platform === "linux" && python3Available();

export type WrapperRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  realInvoked: boolean;
  realArgs: string;
  realArgv: string[];
};

export type StubBehaviour = { stdout?: string; stderr?: string; exitCode?: number };

export function runWrapper(
  args: string[],
  env: Record<string, string>,
  opts: {
    shadowPython?: boolean;
    shadowHelpers?: Record<string, string>;
    stub?: StubBehaviour;
    stubMode?: number;
    validatorScript?: string;
  } = {},
): WrapperRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-"));
  try {
    fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
    const validatorContent = opts.validatorScript ?? fs.readFileSync(VALIDATOR, "utf-8");
    // Source-layout filename lets the wrapper's dev fallback pick it up.
    fs.writeFileSync(path.join(dir, "validate-env-secret-boundary.py"), validatorContent, {
      mode: 0o755,
    });
    fs.chmodSync(path.join(dir, "hermes"), 0o755);

    const marker = path.join(dir, "real-invoked.txt");
    const stubStdout = opts.stub?.stdout ?? "";
    const stubStderr = opts.stub?.stderr ?? "";
    const stubExit = opts.stub?.exitCode ?? 0;
    const stubScript = [
      "#!/usr/bin/env bash",
      `node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(marker)} "$@"`,
      stubStdout ? `cat <<'__NEMOCLAW_STUB_EOF__'\n${stubStdout}\n__NEMOCLAW_STUB_EOF__` : "",
      stubStderr
        ? `cat <<'__NEMOCLAW_STUB_ERR_EOF__' >&2\n${stubStderr}\n__NEMOCLAW_STUB_ERR_EOF__`
        : "",
      `exit ${stubExit}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: opts.stubMode ?? 0o755 });

    // Plant malicious helpers earlier on PATH; the wrapper must ignore them.
    const planted: Record<string, string> = {
      ...(opts.shadowHelpers ?? {}),
      ...(opts.shadowPython ? { python3: "#!/usr/bin/env bash\nexit 0\n" } : {}),
    };
    let pathPrefix = "";
    if (Object.keys(planted).length > 0) {
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      for (const [name, script] of Object.entries(planted)) {
        fs.writeFileSync(path.join(evilBin, name), script, { mode: 0o755 });
      }
      pathPrefix = `${evilBin}${path.delimiter}`;
    }

    const result = spawnSync(path.join(dir, "hermes"), args, {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: `${pathPrefix}${process.env.PATH ?? ""}`, HOME: dir, ...env },
    });

    const realInvoked = fs.existsSync(marker);
    const realArgv = realInvoked ? JSON.parse(fs.readFileSync(marker, "utf-8")) : [];
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      realInvoked,
      realArgs: realArgv.join(" "),
      realArgv,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
