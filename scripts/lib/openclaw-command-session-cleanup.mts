// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { BROKER_SESSION_PROBE_SOURCE } from "./openclaw-broker-session-probe.mts";

// OpenClaw 2026.10.5 uses signal-zero group probes for scoped command cleanup.
// OpenShell 0.1.7 denies those probes. Remove this bridge when native cleanup
// supports the sandbox boundary. Scope admission still owns every command.
const MARKER = "// nemoclaw: observe scoped command session absence";
const RETAIN_SHA256 = "489532b0b5d94fd7a5046eee817ba77b2b327ea3468439991acc36ac268145eb";
const WAIT_SHA256 = "41f22cf723e054c4d7ce06212623f5e2a591210d8a9ad1a834bcf468956ca902";
const SPAWN_SHA256 = new Set([
  "a5b22d67b98b64ab80270df85b07eff89c9388e839eef152e995f39b5ced3e33",
  "40ac7faa91f58f9b5d54ab9f95f9ced5f27cf5ed34ab37c6c8269282eb047dfe",
]);

export const OPENCLAW_COMMAND_SESSION_MODULES = [
  "state/openclaw-state-read.worker.js",
  "native-hook-relay/exec-BpKFbNO4.mjs",
  "exec-spawn-DQCCtyab.mjs",
] as const;

function fingerprint(source: string): string {
  return createHash("sha256").update(source.replaceAll("process$1.", "process.")).digest("hex");
}

function nativeFunction(source: string, name: string): string {
  const matches = [
    ...source.matchAll(
      new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, "gu"),
    ),
  ];
  if (matches.length !== 1) throw new Error(`Expected one pinned ${name} function`);
  return matches[0]![0];
}

function attachInventory(
  source: string,
  current: string,
  patched: string,
  marked: boolean,
): string {
  const hasProbe = source.includes("function nemoclawPrivateBrokerSessionGone(");
  if (
    hasProbe &&
    (source.split(BROKER_SESSION_PROBE_SOURCE).length !== 2 ||
      source.split("function nemoclawPrivateBrokerSessionGone(").length !== 2)
  )
    throw new Error("Unreviewed private session inventory");
  if (marked && !hasProbe) throw new Error("Missing private session inventory");
  return source.replace(
    current,
    () => (hasProbe ? "" : BROKER_SESSION_PROBE_SOURCE + "\n") + patched,
  );
}

/** Only scoped commands receive Execa's mandatory private-session spawn option. */
export function patchScopedCommandSessionCleanup(source: string): string {
  const current = nativeFunction(source, "retainCommandProcess");
  const spawn = nativeFunction(source, "spawnCommandWithInvocation");
  const wait = nativeFunction(source, "waitForCommandProcessGroupExit");
  if (!SPAWN_SHA256.has(fingerprint(spawn)) || fingerprint(wait) !== WAIT_SHA256)
    throw new Error("Unreviewed scoped command ownership or exit deadline");

  const localWait = wait
    .replace("waitForCommandProcessGroupExit", "nemoclawWaitForOwnedCommandSessionExit")
    .replaceAll("isChildProcessTreeAlive({ pid })", "nemoclawOwnedCommandSessionAlive(pid)");
  const helper = `${MARKER}
function nemoclawOwnedCommandSessionAlive(pid) {
  if (process.platform !== "linux" || process.env.OPENSHELL_SANDBOX !== "1")
    return isChildProcessTreeAlive({ pid });
  try { return !nemoclawPrivateBrokerSessionGone(pid); }
  catch (error) {
    scope.failure ??= { error };
    return true;
  }
}
${localWait}
`
    .split("\n")
    .map((line) => (line ? "\t" + line : line))
    .join("\n");
  const marked = current.includes(MARKER);
  const original = marked
    ? current
        .replace(helper, "")
        .replaceAll("nemoclawOwnedCommandSessionAlive(pid)", "isChildProcessTreeAlive({ pid })")
        .replace(
          "nemoclawWaitForOwnedCommandSessionExit(groupPid,",
          "waitForCommandProcessGroupExit(groupPid,",
        )
    : current;
  if (fingerprint(original) !== RETAIN_SHA256)
    throw new Error("Unreviewed or incomplete scoped command cleanup");
  const patched = original
    .replaceAll("isChildProcessTreeAlive({ pid })", "nemoclawOwnedCommandSessionAlive(pid)")
    .replace(
      "waitForCommandProcessGroupExit(groupPid,",
      "nemoclawWaitForOwnedCommandSessionExit(groupPid,",
    )
    .replace(
      "function retainCommandProcess(scope, child, reservation) {\n",
      () => "function retainCommandProcess(scope, child, reservation) {\n" + helper,
    );
  if (marked && current !== patched) throw new Error("Incomplete scoped command session patch");
  return attachInventory(source, current, patched, marked);
}

export const OPENCLAW_COMMAND_TERMINATION_MODULES = [
  "state/openclaw-state-read.worker.js",
  "native-hook-relay/exec-BpKFbNO4.mjs",
  "exec-DbWo9rtV.mjs",
] as const;

const TERMINATION_MARKER = "// nemoclaw: observe explicitly owned command sessions";
const RUNNER_SESSION_FLAG =
  '\t\tnemoclawPrivateSession: Boolean(killProcessTree && process.platform !== "win32"),\n';
const SETTINGS_SESSION_FLAG = '\t\t\t\t\tnemoclawPrivateSession: process.platform !== "win32",\n';

/** Admit the inventory only from pinned callers that spawn detached commands. */
export function patchCommandSessionCaller(source: string, settings = false): string {
  const name = settings ? "execCommand" : "runCommandWithOutputEncoding";
  const expected = settings
    ? "548e329974a5998f8282dab7869b6f90555b0abc75c9d193bba57475b1197108"
    : "00a521ced419480a2c101bf482693f3e494f2462fe2cff1f991145b11e0ba44e";
  const flag = settings ? SETTINGS_SESSION_FLAG : RUNNER_SESSION_FLAG;
  const current = nativeFunction(source, name);
  const marked = current.includes("nemoclawPrivateSession:");
  const original = marked ? current.replace(flag, "") : current;
  if (fingerprint(original) !== expected) throw new Error("Unreviewed detached command caller");
  const boundary = settings
    ? '\t\t\t\t\tprocessTree: { mode: "graceful" },\n'
    : '\t\tprocessTree: killProcessTree ? { mode: "graceful" } : void 0,\n';
  const patched = original.replace(boundary, () => boundary + flag);
  if (patched === original || (marked && current !== patched))
    throw new Error("Incomplete detached command caller patch");
  return source.replace(current, () => patched);
}

/** Keep the shared observer native; adapt only explicitly admitted detached commands. */
export function patchCommandTerminationSessionCleanup(source: string, waitModule: string): string {
  const wait = nativeFunction(waitModule, "waitForCommandProcessGroupExit");
  if (fingerprint(wait) !== WAIT_SHA256) throw new Error("Unreviewed command exit deadline");
  const current = nativeFunction(source, "createCommandTerminationController");
  const localWait = wait
    .replace("waitForCommandProcessGroupExit", "nemoclawWaitForAdmittedCommandSessionExit")
    .replaceAll("isChildProcessTreeAlive({ pid })", "nemoclawAdmittedCommandSessionAlive(pid)");
  const helper = `${TERMINATION_MARKER}
let nemoclawInventoryUncertain = false;
function nemoclawAdmittedCommandSessionAlive(pid) {
  if (params.nemoclawPrivateSession !== true || process.platform !== "linux" || process.env.OPENSHELL_SANDBOX !== "1")
    return isChildProcessTreeAlive({ pid });
  try { return !nemoclawPrivateBrokerSessionGone(pid); }
  catch {
    nemoclawInventoryUncertain = true;
    return true;
  }
}
${localWait}
`
    .split("\n")
    .map((line) => (line ? "\t" + line : line))
    .join("\n");
  const marked = current.includes(TERMINATION_MARKER);
  const original = marked
    ? current
        .replace(helper, "")
        .replace(
          "nemoclawAdmittedCommandSessionAlive(childPid)",
          "isChildProcessTreeAlive({ pid: childPid })",
        )
        .replace(
          "nemoclawWaitForAdmittedCommandSessionExit(childPid,",
          "waitForCommandProcessGroupExit(childPid,",
        )
        .replace('return nemoclawInventoryUncertain ? "uncertain" : cleanup;', "return cleanup;")
    : current;
  const digest = fingerprint(original.replaceAll("constants$1.", "constants."));
  if (digest !== "b623b02f9928d8e5405fa43ecdb6283b58530b89d88566e18aad0aa1d331a516")
    throw new Error("Unreviewed command termination controller");
  const patched = original
    .replace(
      "isChildProcessTreeAlive({ pid: childPid })",
      "nemoclawAdmittedCommandSessionAlive(childPid)",
    )
    .replace(
      "waitForCommandProcessGroupExit(childPid,",
      "nemoclawWaitForAdmittedCommandSessionExit(childPid,",
    )
    .replace("return cleanup;", 'return nemoclawInventoryUncertain ? "uncertain" : cleanup;')
    .replace(
      "function createCommandTerminationController(params) {\n",
      () => "function createCommandTerminationController(params) {\n" + helper,
    );
  if (marked && current !== patched)
    throw new Error("Incomplete command termination session patch");
  return patchCommandSessionCaller(attachInventory(source, current, patched, marked));
}
