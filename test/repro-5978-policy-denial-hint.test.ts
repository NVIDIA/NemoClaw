// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression coverage for #5978.
 *
 * Sandbox outbound network access is denied-by-default and enforced by the
 * OpenShell L7 proxy. From inside the sandbox, generic CLIs (curl, git, wget,
 * python, …) see a policy denial only as the opaque protocol error
 * `CONNECT tunnel failed, response 403`. The detailed allow/deny reason is in
 * the NemoClaw logs, but nothing pointed the user there.
 *
 * The fix emits a tool-agnostic breadcrumb into the interactive connect shell
 * via the same `/tmp/nemoclaw-proxy-env.sh` stanza that already hosts the
 * `openclaw()` guard (sourced by every interactive/login sandbox shell through
 * /etc/bash.bashrc and /etc/profile.d). It does NOT wrap or alter curl/git/wget
 * — their stdout/stderr/TTY behaviour and exit codes are untouched — so it
 * covers every tool and every connect path without regressing tool output.
 *
 * These tests execute the actual emitted stanza shell rather than asserting on
 * source text, mirroring test/repro-4538-raw-doctor-perms.test.ts.
 *
 * Accepted contract: the supported behavior is this proactive connect-shell
 * reminder, NOT a denial-time rewrite of the tool error — the OpenShell proxy
 * owns the 403 and cannot be changed here. See the "proactive-only contract"
 * test below, which sources the stanza and asserts curl/git/wget remain
 * unwrapped (not shell functions/aliases) at runtime.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../src/lib/name-validation.js";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "nemoclaw-start.sh");

// Opt-in container E2E: drives the EXACT reporter workflow against the real
// sandbox base image — the image's own /etc/profile.d + /etc/bash.bashrc hooks
// source /tmp/nemoclaw-proxy-env.sh, and a real curl is denied by a 403-on-
// CONNECT proxy (the OpenShell L7 signature). Gated like the docker E2E in
// test/repro-4538-raw-doctor-perms.test.ts because it needs Docker and the
// pulled base image. Run with:
//   NEMOCLAW_RUN_POLICY_HINT_DOCKER_E2E=1 vitest run \
//     test/repro-5978-policy-denial-hint.test.ts --project integration
//
// Kept opt-in rather than promoted to a required CI lane on purpose: it requires
// a Docker daemon plus the multi-hundred-MB sandbox base image, which the fast
// always-run CLI/integration lanes deliberately do not provision. The behavior
// itself is fully covered hermetically by the always-run stanza tests above
// (emitted shell sourced under a PTY, name allowlist, once-per-session gating,
// proactive-only contract); this scenario is the end-to-end reporter-workflow
// proof, meant for local runs and image-aware lanes. Promote it to a required
// job (or a periodic image-aware signal) once such a lane exists.
const DOCKER_E2E = process.env.NEMOCLAW_RUN_POLICY_HINT_DOCKER_E2E === "1";
const SANDBOX_BASE_IMAGE =
  process.env.NEMOCLAW_SANDBOX_BASE_IMAGE ?? "ghcr.io/nvidia/nemoclaw/sandbox-base:latest";

/**
 * Extract the literal `# nemoclaw-policy-denial-hint begin/end` stanza emitted
 * into /tmp/nemoclaw-proxy-env.sh. It lives inside a single-quoted heredoc, so
 * what the test sources is byte-identical to what a connect shell sources.
 */
function extractHintStanza(src: string): string {
  const begin = src.indexOf("# nemoclaw-policy-denial-hint begin");
  const end = src.indexOf("# nemoclaw-policy-denial-hint end");
  // Assert presence/order branch-free (test files must not add branches):
  // short-circuit to a throwing helper when the markers are missing/reordered.
  const fail = (): never => {
    throw new Error(
      "Expected nemoclaw-policy-denial-hint begin/end markers in scripts/nemoclaw-start.sh",
    );
  };
  const markersPresent = begin >= 0 && end > begin;
  markersPresent || fail();
  return src.slice(begin, src.indexOf("\n", end) + 1);
}

// Run a snippet under a pseudo-terminal so `[ -t 2 ]` is true and the shell is
// interactive (`bash -ic`) — the exact conditions of a human in a connect
// shell. `--noprofile --norc` keeps the host's rc files out of the captured
// output. `script` is part of util-linux and present on CI and the sandbox
// image. Each snippet sets SHLVL itself to model a specific shell depth; we
// force a high inherited SHLVL here so the stanza's source-time auto-call is
// always gated out (regardless of the runner's own SHLVL) and only the snippet's
// explicit invocation decides the outcome. This keeps the tests deterministic
// even under `env -u SHLVL vitest`. The forced SHLVL=9 is only the *inherited*
// value: each snippet then assigns its own SHLVL (e.g. `SHLVL=1`) before calling
// the gate, and that in-snippet assignment takes precedence — so the inherited
// 9 only neutralizes the source-time auto-invocation, by design.
function runInPty(snippet: string, env: NodeJS.ProcessEnv): { stdout: string; status: number } {
  // Write the snippet to a file so its shell quoting survives the
  // script(1) → sh -c → bash layering intact (only the file path crosses it).
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nc-5978-")), "snippet.sh");
  fs.writeFileSync(file, snippet);
  try {
    const result = spawnSync(
      "script",
      ["-qec", `bash --noprofile --norc -i ${file}`, "/dev/null"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { ...process.env, ...env, SHLVL: "9" },
      },
    );
    return { stdout: result.stdout ?? "", status: result.status ?? -1 };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function runPlain(snippet: string, env: NodeJS.ProcessEnv): { stdout: string; status: number } {
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  // The stanza prints to stderr; capture both streams together for assertions.
  return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status ?? -1 };
}

describe("sandbox policy-denial logs breadcrumb (#5978)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const stanza = extractHintStanza(src);

  it("auto-invokes the gate at source time so connect shells get it for free", () => {
    // Behavioral wiring check: just SOURCING the stanza (no explicit call) in a
    // qualifying connect shell must print the breadcrumb. Pin SHLVL=1 before the
    // stanza so its own trailing invocation runs at top-level depth.
    const { stdout, status } = runInPty(["SHLVL=1", stanza].join("\n"), {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw qa-5978 logs --tail 50");
  });

  // Accepted contract for #5978: the supported behavior is a PROACTIVE
  // connect-shell reminder, NOT modification of the denial-time curl/git/wget
  // error (that 403 is emitted by the OpenShell L7 proxy and is intentionally
  // left byte-for-byte unchanged). Sourcing the stanza must therefore never
  // turn those tools into shell functions or aliases — doing so would pipe
  // their stderr and regress TTY progress/colour. Assert the runtime command
  // resolution after sourcing rather than the stanza's source text.
  it("does not wrap or alias curl/git/wget, keeping the proactive-only contract (#5978)", () => {
    const probe = [
      stanza,
      'for t in curl git wget; do printf "%s=%s\\n" "$t" "$(type -t "$t" 2>/dev/null || echo none)"; done',
    ].join("\n");
    const { stdout } = runPlain(probe, {
      HTTPS_PROXY: "http://127.0.0.1:3128",
      OPENSHELL_SANDBOX: "qa-5978",
    });
    expect(stdout).not.toContain("=function");
    expect(stdout).not.toContain("=alias");
  });

  // All breadcrumb scenarios drive the public gate `_nemoclaw_maybe_policy_denial_hint`
  // and assert the user-visible breadcrumb, not the shell-private sub-helpers —
  // observable outcomes through the boundary rather than internal shape.
  const gate = (env: NodeJS.ProcessEnv) =>
    runInPty([stanza, "SHLVL=1; _nemoclaw_maybe_policy_denial_hint"].join("\n"), {
      HTTPS_PROXY: "http://127.0.0.1:3128",
      ...env,
    });

  it("names the sandbox from OPENSHELL_SANDBOX in the emitted breadcrumb", () => {
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "qa-5978" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw qa-5978 logs --tail 50");
  });

  it("falls back to <name> when OPENSHELL_SANDBOX is unusable (older OpenShell)", () => {
    for (const value of ["", "1", "true"]) {
      const { stdout, status } = gate({ OPENSHELL_SANDBOX: value });
      expect(status).toBe(0);
      expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    }
  });

  it("allowlists the name: a crafted OPENSHELL_SANDBOX cannot inject TTY escapes", () => {
    // ESC + newline make the value fail the RFC-1123 allowlist, so it is
    // replaced by the placeholder rather than rendered (security-boundary script).
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "qa\u001b[31m-5978\nINJECTED" });
    const normalized = stdout.replace(/\r/g, "");
    expect(status).toBe(0);
    expect(stdout).not.toContain("\u001b");
    // The newline-carried payload must not reach the terminal at all.
    expect(normalized).not.toContain("\nINJECTED");
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
  });

  it("allowlists the name: shell metacharacters fall back to <name>, not a runnable injection", () => {
    // No control characters, but ';' / space are outside the RFC-1123 label, so
    // the value must not be interpolated verbatim into the copyable command.
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "qa-5978; rm -rf /" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    expect(stdout).not.toContain("rm -rf");
  });

  it("falls back to <name> when OPENSHELL_SANDBOX is only control characters", () => {
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "\t" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
  });

  it("falls back to <name> for an uppercase-leading OPENSHELL_SANDBOX (matches NAME_VALID_PATTERN)", () => {
    // NAME_VALID_PATTERN is lowercase-only (RFC-1123 label), so an uppercase
    // leading letter is never a real sandbox name; reject Qa-5978 rather than
    // echo the untrusted value into the copyable command.
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "Qa-5978" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    expect(stdout).not.toContain("nemoclaw Qa-5978 logs");
  });

  it("falls back to <name> for an OPENSHELL_SANDBOX containing an underscore", () => {
    // Underscore is outside the RFC-1123 label class [a-z0-9-], so qa_5978 is
    // not a valid sandbox name and must not be interpolated verbatim.
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "qa_5978" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    expect(stdout).not.toContain("nemoclaw qa_5978 logs");
  });

  it("falls back to <name> for a digit-leading OPENSHELL_SANDBOX (matches NAME_VALID_PATTERN)", () => {
    // NAME_VALID_PATTERN requires a leading lowercase letter, so a real
    // sandbox name is never digit-leading; reject 9abc rather than render it.
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "9abc" });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    expect(stdout).not.toContain("nemoclaw 9abc logs");
  });

  it("falls back to <name> when OPENSHELL_SANDBOX exceeds the 63-char name limit", () => {
    // NAME_MAX_LENGTH is 63; an over-length value must not be rendered into
    // the copyable command (it could never be a real sandbox name).
    const tooLong = "a".repeat(64);
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: tooLong });
    expect(status).toBe(0);
    expect(stdout).toContain("nemoclaw <name> logs --tail 50");
    expect(stdout).not.toContain(tooLong);
  });

  it("shell allowlist agrees with NAME_VALID_PATTERN for non-sentinel names (anti-drift) (#5978)", () => {
    // Anti-drift guard: the shell `case` in nemoclaw-start.sh hand-mirrors
    // NAME_VALID_PATTERN from src/lib/name-validation.ts. Couple the two by
    // running a matrix of names through the real shell gate and asserting its
    // accept/reject decision matches the imported validator, so a future change
    // to the TS pattern that the shell does not track fails here. Boolean
    // sentinels (true/false/0/1) are intentionally excluded — the shell maps
    // them to the placeholder regardless of NAME_VALID_PATTERN because OpenShell
    // uses them as the "no usable name" signal (covered by the fallback test).
    const candidates = [
      "qa-5978",
      "a",
      "a1",
      "web-server-01",
      "Qa-5978",
      "qa_5978",
      "9abc",
      "-abc",
      "abc-",
      "ab c",
      "ab.c",
      "a".repeat(NAME_MAX_LENGTH + 1),
    ];
    for (const c of candidates) {
      const tsValid = c.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(c);
      const { stdout, status } = gate({ OPENSHELL_SANDBOX: c });
      expect(status).toBe(0);
      const shellAccepted = stdout.includes(`nemoclaw ${c} logs --tail 50`);
      expect(shellAccepted).toBe(tsValid);
    }
  });

  it("emits a tool-agnostic breadcrumb naming the 403 signature and `logs --tail 50`", () => {
    const { stdout, status } = gate({ OPENSHELL_SANDBOX: "qa-5978" });
    expect(status).toBe(0);
    expect(stdout).toContain("CONNECT tunnel failed, response 403");
    expect(stdout).toContain("nemoclaw qa-5978 logs --tail 50");
  });

  it("stays silent when the user suppresses it with NEMOCLAW_NO_POLICY_HINT=1", () => {
    const snippet = [stanza, "SHLVL=1; _nemoclaw_maybe_policy_denial_hint"].join("\n");
    const { stdout, status } = runInPty(snippet, {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      NEMOCLAW_NO_POLICY_HINT: "1",
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain("logs --tail 50");
  });

  it("stays silent when no proxy is configured (nothing to deny)", () => {
    const snippet = [stanza, "SHLVL=1; _nemoclaw_maybe_policy_denial_hint"].join("\n");
    const { stdout, status } = runInPty(snippet, {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "",
      https_proxy: "",
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain("logs --tail 50");
  });

  it("prints only once when the file is sourced twice in one login shell", () => {
    // A login shell sources both the system profile and bashrc hooks, each of
    // which sources this file and runs its trailing auto-invocation — the
    // breadcrumb must not double up. Sourcing the stanza twice models that and
    // proves the once-per-session sentinel survives a re-source.
    const snippet = ["SHLVL=1", stanza, stanza].join("\n");
    const { stdout, status } = runInPty(snippet, {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });
    expect(status).toBe(0);
    const occurrences = stdout.split("nemoclaw qa-5978 logs --tail 50").length - 1;
    expect(occurrences).toBe(1);
  });

  it("stays silent in a deeper subshell so it is shown once per session", () => {
    // SHLVL > 1 models a nested shell/pane; the top-level connect shell already
    // showed it.
    const snippet = [stanza, "SHLVL=3; _nemoclaw_maybe_policy_denial_hint"].join("\n");
    const { stdout, status } = runInPty(snippet, {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain("logs --tail 50");
  });

  it("stays silent in a non-interactive / non-TTY shell (scripts, pipelines)", () => {
    const snippet = [stanza, "true"].join("\n");
    const { stdout, status } = runPlain(snippet, {
      OPENSHELL_SANDBOX: "qa-5978",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      SHLVL: "0",
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain("logs --tail 50");
  });

  // Reporter-workflow E2E in the real sandbox base image (opt-in). Drives the
  // full acceptance clause from #5978 — both reporter commands (`curl` and
  // `git clone`) under a real policy denial — plus the proactive-only and
  // noninteractive-silence contracts, against the image's own shell hooks. This
  // is the runtime validation the always-run stanza tests cannot reach (PTY
  // behaviour, base-image /etc/profile.d + /etc/bash.bashrc hooks, natural
  // SHLVL, real tool exit codes).
  it.skipIf(!DOCKER_E2E)(
    "real base image: one breadcrumb, denied curl+git keep native error/exit, noninteractive stays silent",
    () => {
      // A 403-on-CONNECT proxy reproduces the OpenShell L7 denial. The connect
      // shell starts at SHLVL=0→1 (a fresh login shell), so the stanza's
      // source-time gate fires exactly as it does for a real `connect`.
      const inside = [
        "#!/bin/bash",
        "set -u",
        "cat > /tmp/deny-proxy.py <<'PY'",
        "import socket, threading",
        "def handle(c):",
        "    try:",
        "        c.recv(65535)",
        '        c.sendall(b"HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\n\\r\\n")',
        "    finally:",
        "        c.close()",
        "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        's.bind(("127.0.0.1", 8888)); s.listen(16)',
        "while True:",
        "    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()",
        "PY",
        "python3 /tmp/deny-proxy.py & sleep 1",
        "awk '/# nemoclaw-policy-denial-hint begin/{f=1} f{print} /# nemoclaw-policy-denial-hint end/{f=0}' /work/scripts/nemoclaw-start.sh > /tmp/stanza.sh",
        "{ echo 'export OPENSHELL_SANDBOX=qa-5978'; echo 'export HTTPS_PROXY=http://127.0.0.1:8888'; cat /tmp/stanza.sh; } > /tmp/nemoclaw-proxy-env.sh",
        "chmod 444 /tmp/nemoclaw-proxy-env.sh",
        // Interactive connect session: the breadcrumb prints once at login, then
        // both reporter commands are denied. Each must keep its OWN native error
        // and non-zero exit status — the hint never wraps or rewrites the tools.
        "SHLVL=0 bash -lic '",
        '  curl -sS https://example.com/; echo "CURL_EXIT=$?"',
        '  git clone https://github.com/torvalds/linux /tmp/linux-clone; echo "GIT_EXIT=$?"',
        '  printf "CURL_TYPE=%s\\n" "$(type -t curl || echo none)"',
        '  printf "GIT_TYPE=%s\\n" "$(type -t git || echo none)"',
        "'",
        // Noninteractive execution (scripts / `openshell sandbox exec`) must stay
        // silent even with proxy vars set — proven by the single-breadcrumb count.
        "SHLVL=0 bash -lc 'curl -sS https://example.com/ >/dev/null 2>&1; echo NONINTERACTIVE_DONE'",
        "",
      ].join("\n");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-5978-e2e-"));
      const insideFile = path.join(dir, "inside.sh");
      fs.writeFileSync(insideFile, inside);
      try {
        const result = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "-t",
            "-v",
            `${REPO_ROOT}:/work:ro`,
            "-v",
            `${insideFile}:/inside.sh:ro`,
            SANDBOX_BASE_IMAGE,
            "bash",
            "/inside.sh",
          ],
          { encoding: "utf-8", timeout: 180_000 },
        );
        const out = (result.stdout ?? "").replace(/\r/g, "");
        // Breadcrumb shown by the real image hooks, naming the logs command…
        expect(out).toContain("nemoclaw qa-5978 logs --tail 50");
        // …exactly once across the whole run: both /etc/profile.d and
        // /etc/bash.bashrc source it in the login shell, and the later
        // noninteractive shell must not re-emit it.
        expect(out.split("nemoclaw qa-5978 logs --tail 50").length - 1).toBe(1);
        // Denied real curl: its native 403 signature and a non-zero exit survive
        // (the tool is informational-hinted, never wrapped).
        expect(out).toContain("CONNECT tunnel failed, response 403");
        expect(out).toMatch(/CURL_EXIT=[1-9][0-9]*/);
        // Denied real `git clone` (the other reporter command): its own native
        // error and non-zero exit likewise survive unchanged.
        expect(out).toContain("fatal: unable to access");
        expect(out).toMatch(/GIT_EXIT=[1-9][0-9]*/);
        // Proactive-only contract in the real image: neither tool became a shell
        // function or alias — both still resolve to the on-disk binary.
        expect(out).toContain("CURL_TYPE=file");
        expect(out).toContain("GIT_TYPE=file");
        // The noninteractive shell ran (marker present) but added no breadcrumb,
        // as proven by the single-occurrence count asserted above.
        expect(out).toContain("NONINTERACTIVE_DONE");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
