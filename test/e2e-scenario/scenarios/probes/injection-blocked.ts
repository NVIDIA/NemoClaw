// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeContext, ProbeFn, ProbeOutcome } from "./types.ts";
import { runSandboxCmd, writeProbeEvidence } from "./util.ts";

/**
 * Probe: security.injection.blocked (`injectionBlockedProbe`).
 *
 * Mirrors the contract in
 * test/e2e-scenario/validation_suites/lib/security_policy_credentials.sh
 * `spc_assert_telegram_payload_not_shell_executed`, which itself
 * encodes the test-credential-sanitization.sh / test-brave-search-e2e.sh
 * lesson: when an external content channel (chat message, web fetch
 * response, document body) flows into the agent, it MUST be treated
 * as data, never as a shell command.
 *
 * Implementation:
 *   1. Pre-clean a unique marker file inside the sandbox.
 *   2. Send a payload designed to exploit naive shell expansion:
 *        $(touch <marker> && echo INJECTED)
 *      via stdin to a remote `sh -c 'MSG=$(cat); printf "%s\\n" "$MSG"'`
 *      that's responsible for echoing the bytes back without
 *      evaluation.
 *   3. Verify the echoed output contains the literal payload
 *      (proves the bytes were preserved, not interpreted).
 *   4. Verify the marker file does NOT exist (proves the
 *      command-substitution operator did not fire on the host
 *      side or the sandbox-side shell).
 *
 * If either invariant is violated the probe fails closed: the
 * scenario must NEVER pass on a fake-green injection check.
 *
 * Evidence: structured JSON capturing the payload, the marker path,
 * the echo response tail, and the marker existence query result.
 */

const PER_CALL_SECONDS = 25;

interface InjectionEvidence {
  payload: string;
  markerPath: string;
  echoExitCode: number | null;
  echoStdoutTail: string;
  echoStderrTail: string;
  markerStateExitCode: number | null;
  markerStateStdout: string;
  payloadPreservedLiterally: boolean;
  markerAbsent: boolean;
}

function uniqueMarkerPath(): string {
  // `/tmp` is sandbox-writable; collisions across parallel scenarios
  // are avoided by mixing pid+random to keep the marker scoped to
  // this probe invocation.
  const rand = Math.floor(Math.random() * 0xffff_ffff).toString(16);
  return `/tmp/nemoclaw-injection-probe-${process.pid}-${rand}`;
}

export const injectionBlockedProbe: ProbeFn = async (ctx: ProbeContext): Promise<ProbeOutcome> => {
  if (!ctx.sandboxName) {
    return {
      status: "failed",
      message: "injectionBlockedProbe: E2E_SANDBOX_NAME missing in context.env",
    };
  }

  const markerPath = uniqueMarkerPath();
  // Single-quote the marker path inside the payload so the marker
  // string survives the host-side bash quoting layer; the test is
  // the COMMAND SUBSTITUTION operator surviving, not the path.
  const payload = `$(touch '${markerPath}' && echo INJECTED)`;

  const evidence: InjectionEvidence = {
    payload,
    markerPath,
    echoExitCode: null,
    echoStdoutTail: "",
    echoStderrTail: "",
    markerStateExitCode: null,
    markerStateStdout: "",
    payloadPreservedLiterally: false,
    markerAbsent: false,
  };

  // Step 1: pre-clean the marker. Best-effort; failure here doesn't
  // matter as long as Step 3 confirms the marker is absent at the
  // end.
  await runSandboxCmd(ctx, ["sh", "-c", `rm -f '${markerPath}'`], {
    perCallSeconds: PER_CALL_SECONDS,
  });

  // Step 2: send the payload via stdin to an in-sandbox shell that
  // reads it into a variable and echoes it back. The remote command
  // string must NOT use $() inside the literal; the host-side bash
  // wrapper passes the script verbatim and the sandbox shell reads
  // the payload as data.
  const echoResult = await runSandboxCmd(ctx, ["sh", "-c", 'MSG=$(cat); printf "%s\n" "$MSG"'], {
    perCallSeconds: PER_CALL_SECONDS,
    stdin: payload,
  });
  evidence.echoExitCode = echoResult.exitCode;
  evidence.echoStdoutTail = echoResult.stdout;
  evidence.echoStderrTail = echoResult.stderr;

  if (echoResult.exitCode !== 0) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      classifier: echoResult.signal === "SIGTERM" ? "gateway-transient" : undefined,
      message: `injectionBlockedProbe: echo command failed (exit ${echoResult.exitCode}); stderr: ${echoResult.stderr.slice(-300)}`,
    };
  }

  evidence.payloadPreservedLiterally = echoResult.stdout.includes(payload);
  if (!evidence.payloadPreservedLiterally) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `injectionBlockedProbe: payload was not preserved literally; stdout tail: ${echoResult.stdout.slice(-300)}`,
    };
  }

  // Step 3: confirm the marker file does NOT exist. A 'SAFE' result
  // means the command-substitution payload was treated as data; an
  // 'EXPLOITED' result means a shell somewhere in the chain
  // evaluated the substitution.
  const markerResult = await runSandboxCmd(
    ctx,
    ["sh", "-c", `test -f '${markerPath}' && echo EXPLOITED || echo SAFE`],
    { perCallSeconds: PER_CALL_SECONDS },
  );
  evidence.markerStateExitCode = markerResult.exitCode;
  evidence.markerStateStdout = markerResult.stdout;
  evidence.markerAbsent = markerResult.stdout.includes("SAFE");

  // Best-effort cleanup of the marker if it somehow got created
  // (an 'EXPLOITED' result is a probe failure but we still don't
  // want a stray file lingering between runs).
  await runSandboxCmd(ctx, ["sh", "-c", `rm -f '${markerPath}'`], {
    perCallSeconds: PER_CALL_SECONDS,
  });

  writeProbeEvidence(ctx, evidence);

  if (!evidence.markerAbsent) {
    return {
      status: "failed",
      message: `injectionBlockedProbe: marker file ${markerPath} present \u2014 command substitution executed; stdout: ${markerResult.stdout.slice(-200)}`,
    };
  }

  return {
    status: "passed",
    message: `injectionBlockedProbe: payload preserved as data, marker ${markerPath} absent`,
  };
};
