// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type StagingOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  execIntent: string[]; // argv that would have been exec'd, captured instead of exec'd
  stagedFileContent: string | null;
};

// Inlines the entry-guard staging block from install.sh into a bash
// subshell, replacing `exec bash "$_staged" "$@"` with a capture step so
// the test sees the intended argv without actually launching a new
// installer process. Keep the inlined block in sync with
// scripts/install.sh:2486-2505.
function runEntryGuard(opts: {
  bashSourceOverride?: string; // simulate disk-file invocation
  envOverrides?: Record<string, string>;
  curlSucceeds?: boolean;
  curlOutputContent?: string;
}): StagingOutcome {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-stage-"));
  const execLog = path.join(tmp, "exec-intent.txt");
  const fallthrough = path.join(tmp, "fallthrough.flag");

  // curl stub: writes a canned installer body to the -o target on success,
  // or exits 22 on failure. Real curl is never invoked.
  const curlStub = path.join(tmp, "curl");
  const stagedContent = opts.curlOutputContent ?? "#!/usr/bin/env bash\necho staged\n";
  const curlBody = opts.curlSucceeds === false
    ? `#!/usr/bin/env bash\nexit 22\n`
    : `#!/usr/bin/env bash\n` +
      `out=""\n` +
      `while [ $# -gt 0 ]; do\n` +
      `  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n` +
      `  shift\n` +
      `done\n` +
      `if [ -n "$out" ]; then\n` +
      `  printf '%b' ${JSON.stringify(stagedContent)} > "$out"\n` +
      `fi\nexit 0\n`;
  fs.writeFileSync(curlStub, curlBody, { mode: 0o755 });

  const envInject = Object.entries(opts.envOverrides ?? {})
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n");

  // BASH_SOURCE is read-only inside a function but at the top level of a
  // sourced/exec'd script its [0] entry is empty when bash reads from a
  // pipe. We can't easily fake "empty" without actually piping, so the
  // snippet checks a regular variable (_test_bash_source) instead and the
  // production install.sh uses BASH_SOURCE[0]. They are read at the same
  // point in execution, so the substitution is faithful.
  const bashSourceExpr = opts.bashSourceOverride !== undefined
    ? JSON.stringify(opts.bashSourceOverride)
    : "";

  const snippet = `
    set +e
    export PATH=${JSON.stringify(tmp)}:"$PATH"
    ${envInject}
    set -- '--non-interactive' '--yes-i-accept-third-party-software'

    # ---- begin: inlined entry-guard staging block from install.sh ----
    _test_bash_source=${bashSourceExpr}
    if [[ -z "$_test_bash_source" ]] && [[ -z "\${NEMOCLAW_INSTALLER_STAGED:-}" ]]; then
      _installer_url="\${NEMOCLAW_INSTALLER_URL:-https://www.nvidia.com/nemoclaw.sh}"
      if _staged="$(mktemp /tmp/nemoclaw-installer-XXXXXX 2>/dev/null)" \\
         && curl -fsSL "$_installer_url" -o "$_staged" 2>/dev/null \\
         && [[ -s "$_staged" ]] \\
         && head -1 "$_staged" | grep -qE '^#!.*(sh|bash)' \\
         && bash -n "$_staged" 2>/dev/null; then
        chmod +x "$_staged"
        export NEMOCLAW_INSTALLER_STAGED="$_staged"
        # TEST capture point: record the intended exec argv + the staged
        # file's contents instead of actually exec'ing.
        printf '%s\\n' "$_staged" "$@" > ${JSON.stringify(execLog)}
        cp "$_staged" ${JSON.stringify(path.join(tmp, "staged-copy.sh"))}
        exit 0
      fi
      rm -f "\${_staged:-}" 2>/dev/null
    fi
    # ---- end: inlined entry-guard staging block ----
    : > ${JSON.stringify(fallthrough)}
    exit 0
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    timeout: 10_000,
  });

  const execIntent = fs.existsSync(execLog)
    ? fs.readFileSync(execLog, "utf-8").split("\n").filter((line) => line.length > 0)
    : [];
  const stagedCopyPath = path.join(tmp, "staged-copy.sh");
  const stagedFileContent = fs.existsSync(stagedCopyPath)
    ? fs.readFileSync(stagedCopyPath, "utf-8")
    : null;
  // If fallthrough flag exists, the script reached the "exit guard skipped" branch.
  if (fs.existsSync(fallthrough) && execIntent.length === 0) {
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, execIntent: [], stagedFileContent: null };
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    execIntent,
    stagedFileContent,
  };
}

describe("install.sh entry-guard staging — #4414 curl|bash stdin self-stage", () => {
  it("stages to /tmp and would exec bash on the staged file when invoked via curl|bash", () => {
    // Pipe-mode invocation: BASH_SOURCE[0] empty. Without staging,
    // ensure_docker's sg(1) re-exec from #4419 has no file to point at
    // and falls through to the legacy newgrp/re-curl message.
    const outcome = runEntryGuard({});

    expect(outcome.execIntent.length).toBeGreaterThan(0);
    const stagedPath = outcome.execIntent[0];
    expect(stagedPath).toMatch(/^\/tmp\/nemoclaw-installer-[A-Za-z0-9]+$/);

    // Original installer args are preserved across the would-be exec
    expect(outcome.execIntent).toContain("--non-interactive");
    expect(outcome.execIntent).toContain("--yes-i-accept-third-party-software");

    // Staged file got real installer content written into it
    expect(outcome.stagedFileContent).toContain("staged");
  });

  it("falls through to main() when curl fails (network / DNS / unreachable URL)", () => {
    // Must not loop, must not abort. Falls through to direct main() so
    // ensure_docker's existing legacy newgrp/re-curl message still surfaces.
    const outcome = runEntryGuard({ curlSucceeds: false });

    expect(outcome.execIntent.length).toBe(0);
    // outcome.status === 0 locks in clean fallthrough — a syntax/runtime
    // error in the inlined snippet would surface as non-zero here.
    expect(outcome.status).toBe(0);
  });

  it("skips staging when NEMOCLAW_INSTALLER_STAGED is already set (one-shot loop guard)", () => {
    // The staged copy that already ran main() reaches this guard a second
    // time on re-entry from ensure_docker's sg(1) re-exec. The env-var
    // must demote that second pass to fallthrough so we don't loop. The
    // value is the staged file path (cleanup uses it), but any non-empty
    // value triggers the guard.
    const outcome = runEntryGuard({
      envOverrides: { NEMOCLAW_INSTALLER_STAGED: "/tmp/nemoclaw-installer-aBcDeF" },
    });

    expect(outcome.execIntent.length).toBe(0);
    expect(outcome.status).toBe(0);
  });

  it("does not stage when invoked from a disk file (BASH_SOURCE non-empty)", () => {
    // `bash install.sh` / `./install.sh` is already handled correctly by
    // #4419's sg(1) re-exec — don't stage in that case.
    const outcome = runEntryGuard({
      bashSourceOverride: "/usr/local/share/nemoclaw/install.sh",
    });

    expect(outcome.execIntent.length).toBe(0);
    expect(outcome.status).toBe(0);
  });

  it("falls through when the curl-downloaded content lacks a shell shebang (corruption / URL drift)", () => {
    // Defense against URL drift: if the canonical URL ever serves a
    // non-script payload (CDN cache miss, HTML error page, etc.), staging
    // must not chmod+x + exec it. The shebang check catches that.
    const outcome = runEntryGuard({
      curlOutputContent: "<html><body>404</body></html>\n",
    });

    expect(outcome.execIntent.length).toBe(0);
    expect(outcome.status).toBe(0);
  });

  it("falls through when the staged installer fails bash syntax validation", () => {
    const outcome = runEntryGuard({
      curlOutputContent: "#!/usr/bin/env bash\nif true; then\n",
    });

    expect(outcome.execIntent.length).toBe(0);
    expect(outcome.status).toBe(0);
  });
});
