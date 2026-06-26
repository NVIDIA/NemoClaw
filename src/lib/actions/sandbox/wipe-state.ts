// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { YW, R } from "../../cli/terminal-style";
import { shellQuote } from "../../core/shell-quote";
import * as registry from "../../state/registry";

type RunOpenshellResult = { status: number | null };
type RunOpenshell = (args: string[], opts?: Record<string, unknown>) => RunOpenshellResult;

type AgentStateInfo = {
  configPaths: { dir: string };
  stateDirs: string[];
  stateFiles: { path: string }[];
};

export type WipeSandboxStateDeps = {
  getSandbox?: typeof registry.getSandbox;
  loadAgent?: (name: string) => AgentStateInfo;
  runOpenshell?: RunOpenshell;
  /**
   * Optional warning sink. Defaults to `console.warn`. Matches the
   * `removeShieldsState` pattern so tests can capture warnings without
   * spying on the console global (#5455 Ultra PRA-2).
   */
  warn?: (message: string) => void;
};

/**
 * Wipe a sandbox's persistent state (the agent-manifest state dirs/files such
 * as `workspace/USER.md`) while the sandbox is still live, before
 * `openshell sandbox delete`.
 *
 * Source-of-truth review for the PVC wipe workaround (#5449 / #5455 PRA-5):
 *
 * - Invalid state: `openshell sandbox delete` tears down the pod but leaves
 *   the per-sandbox persistent volume (a k3s local-path PVC keyed by sandbox
 *   name, living inside the shared `openshell-cluster-nemoclaw` Docker
 *   volume) intact. Re-onboarding with the same name rebinds that PVC and
 *   resurrects the old workspace files (USER.md, SOUL.md, ...).
 * - Source boundary: the durable PVC retention is owned upstream by
 *   OpenShell's `sandbox delete` semantics. This wipe is a host-side
 *   workaround so destroy is the inverse of `backupSandboxState`: it removes
 *   exactly the set the snapshot/backup path treats as durable state, plus
 *   the discovered multi-agent `workspace-*` dirs.
 * - Source-fix constraint: making `openshell sandbox delete` purge the PVC
 *   by default is an upstream OpenShell change and would also affect
 *   non-NemoClaw consumers that rely on PVC retention. NemoClaw needs the
 *   clean-re-onboard contract today, so the wipe issues `sandbox exec` while
 *   the sandbox is still live and lets the subsequent `sandbox delete` tear
 *   the pod down.
 * - Regression test: test/destroy-wipe-sandbox-state.test.ts covers the
 *   workspace target, the multi-agent glob, the best-effort warn path, the
 *   path-escape rejection (state_dirs + state_files), and the contract
 *   assertion that the script targets workspace/ under the config dir with
 *   no `..` segments or quoted absolute path arguments.
 * - Removal condition: drop this wipe when OpenShell's `sandbox delete`
 *   removes the per-sandbox PVC by default or exposes a documented
 *   delete-with-pvc flag NemoClaw can pass, and the agent-manifest schema
 *   exposes a typed state-target API so the path normalization here can
 *   move into the manifest loader.
 *
 * Best-effort: a stopped sandbox (e.g. gateway down) makes the exec fail; we
 * warn and let destroy proceed rather than block teardown. Mirrors the
 * `removeShieldsState` pattern.
 *
 * Must be called AFTER `selectGatewayForSandboxDestroy()` so the exec runs
 * against the sandbox's recorded gateway, not whichever gateway happened to
 * be active when destroy was invoked (#5455 PRA-5).
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/5449
 */
export function wipeSandboxState(sandboxName: string, deps: WipeSandboxStateDeps = {}): void {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const loadAgentDef =
    deps.loadAgent ??
    ((name: string) =>
      (require("../../agent/defs") as { loadAgent: (n: string) => AgentStateInfo }).loadAgent(
        name,
      ));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const runOpenshell =
    deps.runOpenshell ??
    ((args: string[], opts?: Record<string, unknown>) => {
      const runtime = require("../../adapters/openshell/runtime") as { runOpenshell: RunOpenshell };
      return runtime.runOpenshell(args, opts);
    });

  const agentName = getSandbox(sandboxName)?.agent || "openclaw";
  let agent: AgentStateInfo;
  try {
    agent = loadAgentDef(agentName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`  ${YW}⚠${R} Could not resolve agent '${agentName}' to wipe workspace state: ${message}`);
    return;
  }

  const dir = agent.configPaths?.dir;
  if (!dir) return;

  // Reject unsafe agent config roots before constructing the wipe command
  // (#5455 PRA-2). The script issues `cd ${dir} && rm -rf -- ...` so a
  // manifest that declared a top-level dir like `/`, `/etc`, even `/sandbox`
  // (no subdirectory), or anything that uses `..` / `.` / extra slashes to
  // escape after the prefix (e.g. `/sandbox/../etc`) would let the rm phase
  // delete outside the intended agent scope.
  //
  // Normalize `dir` via path.posix.resolve() first so `..`/`.`/`//` are folded
  // away, then enforce two invariants on the normalized form:
  //   1. absolute and under `/sandbox/` with at least one more segment
  //   2. the original (un-normalized) input must equal the normalized form,
  //      so a manifest declaring `/sandbox/../etc` is rejected even though
  //      it resolves to `/etc` which is not under `/sandbox/` anyway -- this
  //      makes the rejection reason explicit instead of relying on the
  //      startsWith check.
  //
  // Every shipped agent manifest declares `/sandbox/.<agent>` today
  // (openclaw, hermes, langchain-deepagents-code), so this is a precondition
  // for the existing fleet, not a behavior change.
  const SANDBOX_ROOT = "/sandbox/";
  const normalizedDir = path.posix.resolve(dir);
  // Distinguish the two failure modes for Ultra PRA-8: the un-normalized form
  // (contains `..`, `.`, `//`, or is a relative path) vs the resolved form
  // escaping `/sandbox/`.
  const notAbsoluteOrNormalized = !path.posix.isAbsolute(dir) || normalizedDir !== dir;
  const escapesSandboxRoot =
    !normalizedDir.startsWith(SANDBOX_ROOT) || normalizedDir === SANDBOX_ROOT.replace(/\/$/, "");
  if (notAbsoluteOrNormalized || escapesSandboxRoot) {
    const reason = notAbsoluteOrNormalized
      ? `was not a normalized absolute path (contains '..', '.', '//', or is relative)`
      : `resolves outside ${SANDBOX_ROOT}<agent-name>`;
    warn(
      `  ${YW}⚠${R} Refusing to wipe workspace state for '${sandboxName}': ` +
        `agent '${agentName}' declared config dir '${dir}' which ${reason}`,
    );
    return;
  }

  // Validate every manifest-derived relative path resolves under `dir`. A
  // manifest declaring `state_dirs: ["../etc"]` or an absolute path like
  // `/etc/passwd` would otherwise be shell-quoted and fed straight into
  // `rm -rf -- ...` inside `cd ${dir}`, where the relative form would
  // traverse outside the agent config directory. Use POSIX semantics
  // explicitly so the boundary check matches the Linux sandbox shell that
  // will execute the script, not the host OS the CLI happens to run on
  // (#5455 PRA-3).
  const resolvedDir = path.posix.resolve(dir);
  const validateManifestPath = (p: string): string | null => {
    // Reject `..` segments and absolute paths up-front, BEFORE normalization
    // resolves them away. `path.posix.resolve()` happily folds `../<dir>/foo`
    // into a path under `dir` if the basenames align, but the raw `..` would
    // still reach the destructive shell command and the manifest contract
    // says state targets must be relative names under the agent config dir
    // (#5455 PRA-1 / CodeRabbit security). Defense-in-depth.
    if (path.posix.isAbsolute(p) || p.split("/").includes("..")) {
      warn(
        `  ${YW}⚠${R} Skipping state path '${p}' from agent '${agentName}' manifest: ` +
          `must be relative and contain no '..' segments`,
      );
      return null;
    }
    // Second-line check: even relative paths without `..` must resolve under
    // the config dir. Catches symbolic edge cases this validator does not
    // model explicitly.
    const resolved = path.posix.resolve(resolvedDir, p);
    if (resolved !== resolvedDir && !resolved.startsWith(`${resolvedDir}/`)) {
      warn(
        `  ${YW}⚠${R} Skipping state path '${p}' from agent '${agentName}' manifest: ` +
          `resolves outside ${dir}`,
      );
      return null;
    }
    return p;
  };
  const validStateDirs = agent.stateDirs
    .map(validateManifestPath)
    .filter((p): p is string => p !== null);
  const validStateFiles = agent.stateFiles
    .map((file) => validateManifestPath(file.path))
    .filter((p): p is string => p !== null);

  const targets = [
    ...validStateDirs.map(shellQuote),
    ...validStateFiles.map(shellQuote),
    // Left unquoted so the sandbox shell expands the multi-agent
    // `workspace-<name>` glob (#1260). A no-match leaves the literal token,
    // which `rm -rf` silently ignores.
    "workspace-*",
  ];

  // cd into the config dir first so relative names and the glob resolve there;
  // `exit 0` keeps a partially provisioned (dir-absent) sandbox a clean no-op.
  const script = `cd ${shellQuote(dir)} 2>/dev/null || exit 0; rm -rf -- ${targets.join(" ")}`;

  const result = runOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
    {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  if (result.status !== 0) {
    // #5455 PRA-2 (best-effort failure semantics, justified): destroy must
    // remove the registry entry and tear down the OpenShell pod even when
    // the wipe exec returns non-zero. The most common nonzero path is "the
    // sandbox is no longer live" (gateway down, container already stopped,
    // openshell connectivity transient): blocking destroy there would leave
    // the user with an unkillable broken sandbox. The next re-onboard with
    // the same name is the only path where stale workspace state actually
    // surfaces, so the contract is: warn loudly here, let destroy proceed,
    // and the re-onboard banner re-surfaces the warning if the PVC is
    // detected as non-empty. The behavioral validation for that full
    // destroy -> re-onboard -> clean-workspace contract (#5455 PRA-1) is an
    // E2E concern -- the helper-level test below pins the warning and the
    // CLI-level lifecycle test in test/cli/destroy-gateway-cleanup.test.ts
    // pins the gateway-select-then-exec-then-delete order.
    warn(
      `  ${YW}⚠${R} Could not wipe workspace state for '${sandboxName}' (sandbox not live?); ` +
        "re-onboarding with the same name may resurface old files.",
    );
  }
}
