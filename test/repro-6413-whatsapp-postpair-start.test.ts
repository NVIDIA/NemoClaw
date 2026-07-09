// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Repro for NemoClaw#6413: OpenClaw's `channels login --channel whatsapp`
// saves credentials locally and then asks the running gateway to restart the
// channel via the `channels.start` RPC, which the gateway gates behind
// `operator.admin` (OpenClaw 2026.6.10 core-descriptors). When the login runs
// without the ambient gateway token (ordinary exec/one-shot argv drop it; see
// src/lib/actions/sandbox/runtime-env.ts), the client falls back to device
// auth, NemoClaw's device approval policy deliberately never grants
// `operator.admin`, and the post-pair restart is always denied:
//
//   Local login saved auth for whatsapp/default, but the running gateway did
//   not restart it: missing scope: operator.admin
//
// The guard must re-issue that same bounded RPC as a NemoClaw-owned one-shot
// with gateway-token auth after a successful token-less login, without
// auto-approving `operator.admin` and without failing the login when the
// reconcile itself cannot run.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "nemoclaw-start.sh");

const PRIVATE_GATEWAY_URL = "ws://10.222.0.2:18789";
const GATEWAY_TOKEN = "unit-test-gateway-token";

// The upstream line the reconcile repairs, verbatim from the OpenClaw
// 2026.6.10 dist (channel-auth reconcileGatewayRuntimeAfterLocalLogin).
const UPSTREAM_DENIAL_LINE =
  "Local login saved auth for whatsapp/default, but the running gateway did not restart it: missing scope: operator.admin";

function extractGuardFunction(src: string, trustedGatewayUrl: string): string {
  const beginMarker = "# nemoclaw-configure-guard begin";
  const endMarker = "# nemoclaw-configure-guard end";
  const begin = src.indexOf(beginMarker);
  const end = src.indexOf(endMarker);
  assert(
    begin !== -1 && end !== -1 && begin < end,
    "Expected nemoclaw-configure-guard markers in scripts/nemoclaw-start.sh",
  );
  const guardSource = src.slice(begin, end);
  const injectionStartMarker =
    "GUARDENVEOF\n    # nemoclaw-trusted-gateway-literal-injection begin";
  const injectionEndMarker =
    "    # nemoclaw-trusted-gateway-literal-injection end\n    cat <<'GUARDENVEOF'\n";
  const injectionStart = guardSource.indexOf(injectionStartMarker);
  const injectionEnd = guardSource.indexOf(injectionEndMarker, injectionStart);
  assert(
    injectionStart !== -1 && injectionEnd !== -1,
    "Expected the generated trusted gateway literal injection markers",
  );
  return `${guardSource.slice(0, injectionStart)}            _nemoclaw_whatsapp_trusted_url=${JSON.stringify(trustedGatewayUrl)}\n${guardSource.slice(injectionEnd + injectionEndMarker.length)}`;
}

interface ReconcileRunOptions {
  loginArgs?: string[];
  ambientToken?: string;
  configuredToken?: string | undefined;
  fakeLoginExit?: number;
  fakeGatewayCallExit?: number;
  // Caller-supplied OPENCLAW_GATEWAY_URL override. When set and different from
  // the trusted private URL, the token-bearing reconcile must be skipped.
  callerGatewayUrl?: string;
  // Spoof the caller-mutable NEMOCLAW_* compatibility alias after the readonly
  // trust anchor has been installed. Security decisions must ignore it.
  callerPrivateGatewayAlias?: string;
  // Set `set -e` in the wrapper before invoking the login, to prove the login
  // exit status is still captured and the reconcile guarantees hold.
  errexit?: boolean;
}

interface ReconcileRunResult {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

describe("WhatsApp post-pair gateway channel start (#6413)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const guard = extractGuardFunction(src, PRIVATE_GATEWAY_URL);

  function runLoginThroughGuard(opts: ReconcileRunOptions): ReconcileRunResult {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-postpair-"));
    try {
      const binDir = path.join(tempDir, "bin");
      const stateDir = path.join(tempDir, "state");
      const callLog = path.join(tempDir, "openclaw-calls.log");
      fs.mkdirSync(binDir);
      fs.mkdirSync(stateDir, { recursive: true });

      // The mutable OpenClaw config the token reader must consult; the env
      // unset in ordinary argv paths is documented as "not a secrecy boundary
      // against a command that deliberately reads the file".
      const config =
        opts.configuredToken === undefined
          ? { gateway: { auth: {} } }
          : { gateway: { auth: { token: opts.configuredToken } } };
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));

      // Fake `openclaw` records every invocation with the env that matters
      // (gateway URL, private-WS marker, token) and replays the real
      // 2026.6.10 post-pair denial on token-less logins.
      fs.writeFileSync(
        path.join(binDir, "openclaw"),
        [
          "#!/usr/bin/env bash",
          `printf 'ARGS=%s URL=%s WS=%s TOKEN=%s\\n' "$*" "\${OPENCLAW_GATEWAY_URL:-unset}" "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-unset}" "\${OPENCLAW_GATEWAY_TOKEN:-unset}" >> ${JSON.stringify(callLog)}`,
          'if [ "$1" = "channels" ] && [ "$2" = "login" ]; then',
          '  if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then',
          `    echo ${JSON.stringify(UPSTREAM_DENIAL_LINE)} >&2`,
          "  fi",
          `  exit ${opts.fakeLoginExit ?? 0}`,
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "call" ]; then',
          `  if [ ${JSON.stringify(String(opts.fakeGatewayCallExit ?? 0))} != "0" ]; then`,
          '    echo "Gateway call failed: gateway unreachable" >&2',
          `    exit ${opts.fakeGatewayCallExit ?? 0}`,
          "  fi",
          '  echo "{}"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const wrapperLines = [
        "#!/usr/bin/env bash",
        `export PATH=${JSON.stringify(binDir)}:"$PATH"`,
        `export OPENCLAW_STATE_DIR=${JSON.stringify(stateDir)}`,
        opts.callerGatewayUrl === undefined
          ? "unset OPENCLAW_GATEWAY_URL"
          : `export OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.callerGatewayUrl)}`,
        "unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
        `export NEMOCLAW_OPENCLAW_GATEWAY_URL=${JSON.stringify(PRIVATE_GATEWAY_URL)}`,
        `_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=${JSON.stringify(PRIVATE_GATEWAY_URL)}`,
        "builtin readonly _NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL",
        "export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
        opts.ambientToken === undefined
          ? "unset OPENCLAW_GATEWAY_TOKEN"
          : `export OPENCLAW_GATEWAY_TOKEN=${JSON.stringify(opts.ambientToken)}`,
        guard,
        ...(opts.callerPrivateGatewayAlias === undefined
          ? []
          : [
              `export NEMOCLAW_OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.callerPrivateGatewayAlias)}`,
            ]),
        ...(opts.errexit ? ["set -e"] : []),
        `openclaw ${(opts.loginArgs ?? ["channels", "login", "--channel", "whatsapp"])
          .map((arg) => JSON.stringify(arg))
          .join(" ")}`,
        // Under `set -e` a nonzero login aborts the wrapper here (the caller
        // shell's own contract), so this line only runs on success; assert on
        // stderr for the failing-login-under-errexit case instead.
        "__rc=$?",
        ...(opts.errexit ? ["set +e"] : []),
        'echo "GUARD_EXIT=$__rc"',
      ];
      const wrapperPath = path.join(tempDir, "run.sh");
      fs.writeFileSync(wrapperPath, wrapperLines.join("\n"), { mode: 0o700 });

      const r = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 15000 });
      const calls = fs.existsSync(callLog)
        ? fs.readFileSync(callLog, "utf-8").split("\n").filter(Boolean)
        : [];
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        calls,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function gatewayCallLines(calls: string[]): string[] {
    return calls.filter((line) => line.startsWith("ARGS=gateway call "));
  }

  it("restarts the channel with gateway-token auth after a token-less login (#6413)", () => {
    const r = runLoginThroughGuard({ configuredToken: GATEWAY_TOKEN });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const reconcile = gatewayCallLines(r.calls);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain(
      'ARGS=gateway call channels.start --params {"channel":"whatsapp"} --json',
    );
    expect(reconcile[0]).toContain(`TOKEN=${GATEWAY_TOKEN}`);
    expect(reconcile[0]).toContain(`URL=${PRIVATE_GATEWAY_URL}`);
    expect(reconcile[0]).toContain("WS=1");
    expect(r.stderr).toContain(
      "Restarted the WhatsApp channel on the running gateway with the new credentials.",
    );
  });

  it("passes the login --account id through to channels.start", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      loginArgs: ["channels", "login", "--channel", "whatsapp", "--account", "biz"],
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const reconcile = gatewayCallLines(r.calls);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain('--params {"channel":"whatsapp","accountId":"biz"}');
  });

  it("supports the --account=<id> spelling", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      loginArgs: ["channels", "login", "--channel=whatsapp", "--account=biz.2"],
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const reconcile = gatewayCallLines(r.calls);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain('--params {"channel":"whatsapp","accountId":"biz.2"}');
  });

  it("accepts a 128-character account id at the RPC boundary (#6413)", () => {
    const accountId = "a".repeat(128);
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      loginArgs: ["channels", "login", "--channel", "whatsapp", "--account", accountId],
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const reconcile = gatewayCallLines(r.calls);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain(`--params {"channel":"whatsapp","accountId":"${accountId}"}`);
  });

  it("refuses an account id longer than 128 characters (#6413)", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      loginArgs: ["channels", "login", "--channel", "whatsapp", "--account", "a".repeat(129)],
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("account id exceeds 128 characters");
    expect(r.stderr).toContain("nemoclaw <sandbox> channels status --channel whatsapp");
  });

  it("refuses to embed an unsafe account id in the RPC params", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      loginArgs: ["channels", "login", "--channel", "whatsapp", "--account", 'biz"},"x":"y'],
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("account id contains unsupported characters");
    expect(r.stderr).toContain("nemoclaw <sandbox> channels status --channel whatsapp");
  });

  it("does NOT send the gateway token to a caller-supplied gateway URL — login or reconcile (#6413)", () => {
    // A login can carry a caller-chosen OPENCLAW_GATEWAY_URL. Neither the login
    // subprocess nor the reconcile may hand the gateway token to that endpoint,
    // or the token is exfiltrated. Here the token is configured but NOT ambient.
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      callerGatewayUrl: "ws://attacker.example.test:1234",
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    // The token must not appear in ANY recorded invocation env (login included).
    expect(r.calls.every((line) => !line.includes(GATEWAY_TOKEN))).toBe(true);
    expect(r.stderr).toContain("custom gateway URL");
    expect(r.stderr).toContain("nemoclaw <sandbox> channels status --channel whatsapp");
  });

  it("strips an AMBIENT gateway token before a login to a caller-supplied URL (#6413)", () => {
    // The connect shell exports OPENCLAW_GATEWAY_TOKEN ambiently. A caller that
    // redirects the login to an attacker URL must not have that ambient token
    // forwarded to the login subprocess. Covers the ambient + non-trusted case.
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      ambientToken: GATEWAY_TOKEN,
      callerGatewayUrl: "ws://attacker.example.test:1234",
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    // Login ran, but with the token stripped, and no reconcile fired.
    const loginCalls = r.calls.filter((line) => line.startsWith("ARGS=channels login "));
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0]).toContain("TOKEN=unset");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.calls.every((line) => !line.includes(GATEWAY_TOKEN))).toBe(true);
    expect(r.stderr).toContain("custom gateway URL");
  });

  it("rejects a caller that spoofs both mutable gateway URL aliases (#6413)", () => {
    const attackerUrl = "ws://attacker.example.test:1234";
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      ambientToken: GATEWAY_TOKEN,
      callerGatewayUrl: attackerUrl,
      callerPrivateGatewayAlias: attackerUrl,
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const loginCalls = r.calls.filter((line) => line.startsWith("ARGS=channels login "));
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0]).toContain(`URL=${attackerUrl}`);
    expect(loginCalls[0]).toContain("TOKEN=unset");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.calls.every((line) => !line.includes(GATEWAY_TOKEN))).toBe(true);
    expect(r.stderr).toContain("custom gateway URL");
  });

  it("reconciles against the trusted URL when the caller URL matches it", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      callerGatewayUrl: PRIVATE_GATEWAY_URL,
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const reconcile = gatewayCallLines(r.calls);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain(`URL=${PRIVATE_GATEWAY_URL}`);
    expect(reconcile[0]).toContain(`TOKEN=${GATEWAY_TOKEN}`);
  });

  it("captures the login exit and skips reconcile on a failed login under set -e (#6413)", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      fakeLoginExit: 5,
      errexit: true,
    });

    // The function body must run to completion under the caller's `set -e`:
    // the failure guidance is printed and no reconcile is attempted.
    expect(r.stderr).toContain("Pairing exited with code 5 before it completed");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.status).toBe(5);
  });

  it("reconciles normally when the caller shell has set -e and the login succeeds", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      errexit: true,
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(1);
  });

  it("keeps the token for a trusted-URL login and does not double-reconcile", () => {
    // Trusted URL + ambient token: the login authenticates with the token and
    // its own post-pair channels.start succeeds, so NemoClaw must NOT issue a
    // second restart (it would only bounce the freshly started session). The
    // token legitimately reaches the trusted URL here.
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      ambientToken: GATEWAY_TOKEN,
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    const loginCalls = r.calls.filter((line) => line.startsWith("ARGS=channels login "));
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0]).toContain(`TOKEN=${GATEWAY_TOKEN}`);
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
  });

  it("does not reconcile after a failed login and preserves its exit code", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      fakeLoginExit: 7,
    });

    expect(r.stdout).toContain("GUARD_EXIT=7");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
  });

  it("downgrades to host-side guidance when no gateway token is configured", () => {
    const r = runLoginThroughGuard({ configuredToken: undefined });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("the gateway token is unavailable in this shell");
    expect(r.stderr).toContain("nemoclaw <sandbox> channels status --channel whatsapp");
  });

  it("keeps the login successful and prints recovery guidance when the restart RPC fails", () => {
    const r = runLoginThroughGuard({
      configuredToken: GATEWAY_TOKEN,
      fakeGatewayCallExit: 1,
    });

    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(gatewayCallLines(r.calls)).toHaveLength(1);
    expect(r.stderr).toContain("restarting the channel on the running gateway failed");
    expect(r.stderr).toContain("Gateway call failed: gateway unreachable");
    expect(r.stderr).toContain("nemoclaw <sandbox> channels status --channel whatsapp");
  });
});
