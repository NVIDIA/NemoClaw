// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HERMES_SLACK_CREDENTIAL_FINGERPRINT_SCAN_SOURCE,
  hermesSlackCredentialFingerprints,
  hermesSlackCredentialScanScript,
} from "../live/hermes-slack-credential-transport.ts";
import { assertHermesSlackCredentialFingerprintScanResult } from "../live/hermes-slack-e2e-helpers.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runCredentialTransport(transportFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-hermes-slack-exec-"));
  temporaryDirectories.push(root);
  const openshell = join(root, "openshell");
  const calls = join(root, "openshell-calls.log");
  const ssh = join(root, "ssh");

  writeFileSync(
    openshell,
    [
      "#!/bin/sh",
      'printf "args=%s\\n" "$*" >>"$OPENSHELL_CALLS"',
      'payload="$(cat)"',
      'printf "payload=%s\\n" "$payload" >>"$OPENSHELL_CALLS"',
      '[ "${TRANSPORT_FAILURE:-0}" = 1 ] && exit 70',
      'printf "OK\\n"',
    ].join("\n"),
  );
  chmodSync(openshell, 0o755);
  writeFileSync(
    ssh,
    ["#!/bin/sh", 'printf "ssh-args=%s\\n" "$*" >>"$OPENSHELL_CALLS"', "exit 71"].join("\n"),
  );
  chmodSync(ssh, 0o755);

  const credentials = ["xoxb-test-credential", "xapp-test-credential"];
  const credentialFingerprints = hermesSlackCredentialFingerprints(credentials);
  const script = hermesSlackCredentialScanScript({
    credentialFingerprints,
    openshellCommandPath: openshell,
    remoteCommand: "cat >/dev/null",
    sandboxName: "e2e-hermes-slack",
  });
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      OPENSHELL_CALLS: calls,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      TRANSPORT_FAILURE: transportFailure ? "1" : "0",
    },
    timeout: 5_000,
  });
  return {
    calls: readFileSync(calls, "utf8"),
    credentialFingerprints,
    credentials,
    result,
  };
}

describe("Hermes Slack credential-fingerprint scan", () => {
  it("sends only derived fingerprints through the OpenShell sandbox exec boundary", () => {
    const { calls, credentialFingerprints, credentials, result } = runCredentialTransport();

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("args=sandbox exec --name e2e-hermes-slack -- sh -lc cat >/dev/null");
    const payload = calls.match(/^payload=(.+)$/mu)?.[1];
    expect(JSON.parse(payload ?? "null")).toEqual(credentialFingerprints);
    expect(calls).not.toContain(credentials[0]);
    expect(calls).not.toContain(credentials[1]);
    expect(calls).not.toContain("ssh-args=");
  });

  it("detects an exact credential substring without receiving the credential", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-hermes-slack-fingerprint-"));
    temporaryDirectories.push(root);
    const fixture = join(root, "fixture.log");
    const credential = "xoxb-test-fingerprint-only";
    const input = JSON.stringify(hermesSlackCredentialFingerprints([credential]));
    const scan = () =>
      spawnSync(
        "python3",
        ["-c", HERMES_SLACK_CREDENTIAL_FINGERPRINT_SCAN_SOURCE, JSON.stringify([fixture]), "files"],
        { encoding: "utf8", input },
      );

    writeFileSync(fixture, `prefix ${credential} suffix`);
    const leaked = scan();
    expect(leaked.status, leaked.stderr).toBe(0);
    expect(JSON.parse(leaked.stdout)).toEqual({ files: "LEAK", processes: "EMPTY" });

    writeFileSync(fixture, "only revision-scoped placeholders remain");
    const clean = scan();
    expect(clean.status, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ files: "OK", processes: "EMPTY" });
  });

  it("propagates an OpenShell sandbox exec transport failure", () => {
    const { calls, result } = runCredentialTransport(true);

    expect(result.status).not.toBe(0);
    expect(calls).toContain("args=sandbox exec --name e2e-hermes-slack");
  });

  it("rejects missing process-argument evidence", () => {
    expect(() =>
      assertHermesSlackCredentialFingerprintScanResult({ files: "OK", processes: "EMPTY" }),
    ).toThrow(/raw Slack token absent from process arguments/);
  });
});
