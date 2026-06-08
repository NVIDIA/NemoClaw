// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listRegisteredProbes,
  lookupProbe,
  registerProbe,
  resetProbeRegistry,
} from "../scenarios/probes/registry.ts";
import type { ProbeContext, ProbeOutcome } from "../scenarios/probes/types.ts";
import { registerBuiltinProbes } from "../scenarios/probes/builtin.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("probe registry", () => {
  // The orchestrator side-effect-imports builtin.ts at module load,
  // so the registry already contains the built-ins. Each test resets
  // and re-registers explicitly so order independence holds.
  beforeEach(() => {
    resetProbeRegistry();
  });

  afterEach(() => {
    // Restore the production wiring so subsequent test files don't
    // see an empty registry (vitest shares module state across files
    // within a worker).
    resetProbeRegistry();
    registerBuiltinProbes();
  });

  it("registerProbe_lookupProbe_round_trip", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    registerProbe("myProbe", fn);
    expect(lookupProbe("myProbe")).toBe(fn);
  });

  it("lookupProbe_returns_undefined_for_unknown_ref", () => {
    expect(lookupProbe("nonexistent")).toBeUndefined();
  });

  it("registerProbe_rejects_duplicate_registration", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    registerProbe("dup", fn);
    expect(() => registerProbe("dup", fn)).toThrow(/already registered/);
  });

  it("registerProbe_rejects_empty_name", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    expect(() => registerProbe("", fn)).toThrow(/name is required/);
  });

  it("listRegisteredProbes_returns_sorted_names", () => {
    registerProbe("zeta", async () => ({ status: "passed" }));
    registerProbe("alpha", async () => ({ status: "passed" }));
    registerProbe("mu", async () => ({ status: "passed" }));
    expect(listRegisteredProbes()).toEqual(["alpha", "mu", "zeta"]);
  });

  it("registerBuiltinProbes_is_idempotent", () => {
    registerBuiltinProbes();
    const first = listRegisteredProbes();
    expect(first).toContain("diagnosticsProbe");
    expect(first).toContain("docsValidationProbe");
    // Calling again must not throw on duplicate names.
    expect(() => registerBuiltinProbes()).not.toThrow();
    expect(listRegisteredProbes()).toEqual(first);
  });

  it("registerBuiltinProbes_registers_security_probes", () => {
    // shieldsConfig / networkPolicy / injectionBlocked are marked
    // `required: true` in scenarios/assertions/registry.ts. The
    // orchestrator fails closed when a required probe is missing,
    // so registering all three turns the security suites from
    // 'silently skipped' into 'actually verified'.
    registerBuiltinProbes();
    const registered = listRegisteredProbes();
    expect(registered).toContain("shieldsConfigProbe");
    expect(registered).toContain("networkPolicyProbe");
    expect(registered).toContain("injectionBlockedProbe");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diagnosticsProbe — uses a fake `nemoclaw` on PATH so this test runs
// reproducibly without depending on a real nemoclaw install.
// ─────────────────────────────────────────────────────────────────────────────

function makeProbeCtx(tmp: string, evidenceFile = "diag-evidence.json"): ProbeContext {
  // contextDir doubles as the parent of the evidence file when the
  // step does not specify an explicit path. Tests pass an explicit
  // path here to keep the file under tmp.
  return {
    contextDir: tmp,
    evidencePath: path.join(tmp, evidenceFile),
    contextEnv: {},
    sandboxName: null,
    gatewayUrl: null,
    repoRoot: REPO_ROOT,
  };
}

function installFakeOnPath(
  binDir: string,
  name: string,
  script: string,
): { restore: () => void } {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, name), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  return {
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

describe("diagnosticsProbe", () => {
  it("passes_when_nemoclaw_debug_quick_writes_a_non_empty_archive", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-pass-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash
# Stub: locate the --output value and write a small non-empty archive there.
out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] || { echo "no --output" >&2; exit 2; }
printf 'fake-archive-bytes' > "$out"
exit 0
`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("passed");
      expect(outcome.message).toMatch(/bundle ok/);
      // Evidence JSON must exist and parse.
      const ev = JSON.parse(fs.readFileSync(path.join(tmp, "diag-evidence.json"), "utf8"));
      expect(ev.exitCode).toBe(0);
      expect(ev.archiveSize).toBeGreaterThan(0);
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_nemoclaw_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-fail-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/exited 7/);
      const ev = JSON.parse(fs.readFileSync(path.join(tmp, "diag-evidence.json"), "utf8"));
      expect(ev.exitCode).toBe(7);
      expect(ev.stderrTail).toContain("boom");
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_archive_is_empty", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-empty-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash
out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in --output) out="$2"; shift 2 ;; *) shift ;; esac
done
: > "$out"  # zero-byte archive
exit 0
`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/empty/);
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// docsValidationProbe — substitutes a fake check-docs.sh by overriding
// the repoRoot in the ProbeContext so the resolved path points at a
// scratch dir we control.
// ─────────────────────────────────────────────────────────────────────────────

describe("docsValidationProbe", () => {
  function setupFakeCheckDocs(
    tmp: string,
    cliExit: number,
    linksExit: number,
  ): { ctx: ProbeContext } {
    const scriptDir = path.join(tmp, "test/e2e/e2e-cloud-experimental");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptDir, "check-docs.sh"),
      `#!/usr/bin/env bash
case "$1" in
  --only-cli)            exit ${cliExit} ;;
  --only-links)          exit ${linksExit} ;;
  *)                     echo "unknown: $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    return {
      ctx: {
        contextDir: tmp,
        evidencePath: path.join(tmp, "docs-evidence.json"),
        contextEnv: {},
        sandboxName: null,
        gatewayUrl: null,
        repoRoot: tmp, // probe resolves check-docs.sh against this
      },
    };
  }

  it("passes_when_both_cli_and_links_checks_exit_zero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-pass-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 0, 0);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("passed");
      const ev = JSON.parse(fs.readFileSync(ctx.evidencePath, "utf8"));
      expect(ev.results).toHaveLength(2);
      expect(ev.results[0].phase).toBe("cli-parity");
      expect(ev.results[0].exitCode).toBe(0);
      expect(ev.results[1].phase).toBe("links-local");
      expect(ev.results[1].exitCode).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_cli_parity_check_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-cli-fail-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 3, 0);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/CLI\/docs parity failed.*exit 3/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_links_check_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-links-fail-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 0, 5);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/markdown link check failed.*exit 5/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_with_actionable_message_when_check_docs_script_missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-missing-"));
    try {
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const ctx: ProbeContext = {
        contextDir: tmp,
        evidencePath: path.join(tmp, "docs-evidence.json"),
        contextEnv: {},
        sandboxName: null,
        gatewayUrl: null,
        repoRoot: tmp, // no test/e2e/... tree under tmp
      };
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/check-docs\.sh not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Security probes — stub `nemoclaw` (host CLI) and `openshell` so the
// canonical sandbox-exec wrapper resolves through the stub. The
// wrapper's openshell-fallback path is exercised because the stub
// does not implement `sandbox ssh-config`.
// ──────────────────────────────────────────────────────────────────────────

function makeProbeCtxFor(
  tmp: string,
  sandboxName: string,
  contextEnv: Record<string, string> = {},
): ProbeContext {
  // Write context.env so spawned bash scripts that source the
  // wrapper can pick up E2E_SANDBOX_NAME if needed.
  const lines = Object.entries({ E2E_SANDBOX_NAME: sandboxName, ...contextEnv })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(tmp, "context.env"), lines + "\n");
  return {
    contextDir: tmp,
    evidencePath: path.join(tmp, "probe-evidence.json"),
    contextEnv: { E2E_SANDBOX_NAME: sandboxName, ...contextEnv },
    sandboxName,
    gatewayUrl: null,
    repoRoot: REPO_ROOT,
  };
}

describe("shieldsConfigProbe", () => {
  it("passes_when_shields_status_matches_expected_and_perms_match_state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shields-probe-pass-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
# nemoclaw <sandbox> shields status
if [[ "$2" == "shields" && "$3" == "status" ]]; then
  echo "Shields: DOWN"
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
# Stub openshell. Reject ssh-config so wrapper falls back to sandbox exec.
# Then implement 'sandbox exec --name <sb> -- <cmd>' by stripping args
# until '--' and running what's left.
if [[ "$1" == "sandbox" && "$2" == "ssh-config" ]]; then
  exit 1
fi
if [[ "$1" == "sandbox" && "$2" == "exec" ]]; then
  shift 2
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
  shift || true
  # The 'stat -c %a %U:%G <path>' invocation: emit a fake permissions
  # line that matches a DOWN-state sandbox config (sandbox-owned).
  if [[ "$1" == "stat" ]]; then
    echo "644 sandbox:sandbox"
    exit 0
  fi
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    try {
      const { shieldsConfigProbe } = await import("../scenarios/probes/shields-config.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1", {
        E2E_AGENT: "openclaw",
        E2E_SHIELDS_EXPECTED_STATE: "down",
      });
      const outcome = await shieldsConfigProbe(ctx);
      expect(outcome.status).toBe("passed");
      expect(outcome.message).toMatch(/shields=down/);
      const ev = JSON.parse(fs.readFileSync(ctx.evidencePath, "utf8"));
      expect(ev.observed).toBe("down");
      expect(ev.expected).toBe("down");
      expect(ev.permissionsLine).toBe("644 sandbox:sandbox");
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_observed_state_disagrees_with_expected", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shields-probe-mismatch-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "$2" == "shields" && "$3" == "status" ]]; then
  echo "Shields: UP"
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    try {
      const { shieldsConfigProbe } = await import("../scenarios/probes/shields-config.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1", {
        E2E_AGENT: "openclaw",
        E2E_SHIELDS_EXPECTED_STATE: "down",
      });
      const outcome = await shieldsConfigProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/expected shields 'down', observed 'up'/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_perms_dont_match_observed_state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shields-probe-perms-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "$2" == "shields" && "$3" == "status" ]]; then
  # Shields claim UP, but the stub openshell will report sandbox-owned
  # perms below — a mismatch the probe must catch.
  echo "Shields: UP"
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [[ "$1" == "sandbox" && "$2" == "ssh-config" ]]; then exit 1; fi
if [[ "$1" == "sandbox" && "$2" == "exec" ]]; then
  shift 2
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
  shift || true
  # Sandbox-owned perms: would pass for DOWN, must FAIL for UP.
  echo "644 sandbox:sandbox"
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    try {
      const { shieldsConfigProbe } = await import("../scenarios/probes/shields-config.ts");
      // Don't declare expected state — the probe should still fail on
      // perms-vs-observed mismatch alone.
      const ctx = makeProbeCtxFor(tmp, "sb1", { E2E_AGENT: "openclaw" });
      const outcome = await shieldsConfigProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/shields are 'up' but .* permissions are/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("networkPolicyProbe", () => {
  function fakeOpenshellEmittingHttpStatus(
    binDir: string,
    httpStatus: string,
    curlExitCode: number = 0,
  ): void {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      `#!/usr/bin/env bash
# Opt out of ssh-config; force wrapper to use 'sandbox exec' fallback.
if [[ "$1" == "sandbox" && "$2" == "ssh-config" ]]; then exit 1; fi
if [[ "$1" == "sandbox" && "$2" == "exec" ]]; then
  shift 2
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
  shift || true
  # We're being asked to run curl inside the sandbox. Emit the test's
  # chosen status to stdout (mirrors curl -w '%{http_code}') and exit
  # with the test's chosen curl exit code.
  printf '%s' "${httpStatus}"
  exit ${curlExitCode}
fi
exit 99
`,
      { mode: 0o755 },
    );
  }

  it("passes_when_blocked_url_returns_403", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netpolicy-probe-403-"));
    fakeOpenshellEmittingHttpStatus(path.join(tmp, "bin"), "403", 0);
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.join(tmp, "bin")}:${oldPath ?? ""}`;
    try {
      const { networkPolicyProbe } = await import("../scenarios/probes/network-policy.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await networkPolicyProbe(ctx);
      expect(outcome.status).toBe("passed");
      expect(outcome.message).toMatch(/blocked .*http_code=403/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes_when_curl_exits_nonzero_and_no_http_response", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netpolicy-probe-conn-"));
    // curl exit 7 = couldn't connect; status '000' = no HTTP response.
    fakeOpenshellEmittingHttpStatus(path.join(tmp, "bin"), "000", 7);
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.join(tmp, "bin")}:${oldPath ?? ""}`;
    try {
      const { networkPolicyProbe } = await import("../scenarios/probes/network-policy.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await networkPolicyProbe(ctx);
      expect(outcome.status).toBe("passed");
      expect(outcome.message).toMatch(/curl exit 7/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_blocked_url_returns_200", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netpolicy-probe-200-"));
    fakeOpenshellEmittingHttpStatus(path.join(tmp, "bin"), "200", 0);
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.join(tmp, "bin")}:${oldPath ?? ""}`;
    try {
      const { networkPolicyProbe } = await import("../scenarios/probes/network-policy.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await networkPolicyProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/reachable from sandbox.*http_code=200/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_blocked_url_returns_401_indicating_policy_bypass", async () => {
    // 401 means the request reached upstream auth, NOT that gateway
    // dropped it. The probe must classify this as a policy bypass.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netpolicy-probe-401-"));
    fakeOpenshellEmittingHttpStatus(path.join(tmp, "bin"), "401", 0);
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.join(tmp, "bin")}:${oldPath ?? ""}`;
    try {
      const { networkPolicyProbe } = await import("../scenarios/probes/network-policy.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await networkPolicyProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/reachable from sandbox.*http_code=401/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("injectionBlockedProbe", () => {
  // For the injection probe we need a stub openshell that simulates a
  // sandbox shell honestly: pre-clean, echo back stdin, and respond
  // SAFE/EXPLOITED based on whether the marker file exists. We give
  // each test its own tmp dir and stub script.
  function setupInjectionStub(tmp: string, exploited: boolean): { restore: () => void } {
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Use a state file in tmp to track whether the 'exploit' branch
    // should claim the marker exists.
    const stateFile = path.join(tmp, "exploit.state");
    fs.writeFileSync(stateFile, exploited ? "yes" : "no");
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      `#!/usr/bin/env bash
state=\$(cat "${stateFile}" 2>/dev/null || echo no)
if [[ "\$1" == "sandbox" && "\$2" == "ssh-config" ]]; then exit 1; fi
if [[ "\$1" == "sandbox" && "\$2" == "exec" ]]; then
  shift 2
  while [[ "\$#" -gt 0 && "\$1" != "--" ]]; do shift; done
  shift || true
  # Recognize the three operations the probe issues:
  #   1. sh -c 'rm -f <marker>'              — cleanup; always succeeds
  #   2. sh -c 'MSG=\$(cat); printf %s\\n "\$MSG"'  — echo back stdin
  #   3. sh -c 'test -f <marker> && echo EXPLOITED || echo SAFE'
  cmd="\$*"
  case "\$cmd" in
    *"MSG="*"printf"*)
      cat
      ;;
    *"test -f"*"EXPLOITED"*"SAFE"*)
      if [[ "\$state" == "yes" ]]; then echo EXPLOITED; else echo SAFE; fi
      ;;
    *"rm -f"*)
      :
      ;;
    *)
      echo "unrecognized cmd: \$cmd" >&2
      exit 64
      ;;
  esac
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    return {
      restore: () => {
        process.env.PATH = oldPath;
      },
    };
  }

  it("passes_when_payload_is_preserved_and_marker_absent", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inj-probe-pass-"));
    const stub = setupInjectionStub(tmp, false);
    try {
      const { injectionBlockedProbe } = await import("../scenarios/probes/injection-blocked.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await injectionBlockedProbe(ctx);
      expect(outcome.status).toBe("passed");
      const ev = JSON.parse(fs.readFileSync(ctx.evidencePath, "utf8"));
      expect(ev.payloadPreservedLiterally).toBe(true);
      expect(ev.markerAbsent).toBe(true);
    } finally {
      stub.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_marker_file_was_created_indicating_command_substitution_executed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inj-probe-fail-"));
    const stub = setupInjectionStub(tmp, true);
    try {
      const { injectionBlockedProbe } = await import("../scenarios/probes/injection-blocked.ts");
      const ctx = makeProbeCtxFor(tmp, "sb1");
      const outcome = await injectionBlockedProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/marker file .* present/);
      expect(outcome.message).toMatch(/command substitution executed/);
      const ev = JSON.parse(fs.readFileSync(ctx.evidencePath, "utf8"));
      expect(ev.markerAbsent).toBe(false);
    } finally {
      stub.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
