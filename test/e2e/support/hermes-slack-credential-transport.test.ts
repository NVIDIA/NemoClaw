// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hermesSlackCredentialScanScript } from "../live/hermes-slack-credential-transport.ts";

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

  const script = hermesSlackCredentialScanScript({
    openshellCommandPath: openshell,
    remoteCommand: "cat >/dev/null",
    sandboxName: "e2e-hermes-slack",
  });
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENSHELL_CALLS: calls,
      SLACK_APP_TOKEN: "xapp-test-credential",
      SLACK_BOT_TOKEN: "xoxb-test-credential",
      TRANSPORT_FAILURE: transportFailure ? "1" : "0",
    },
    timeout: 5_000,
  });
  return {
    calls: readFileSync(calls, "utf8"),
    result,
    script,
  };
}

describe("Hermes Slack credential-scan transport", () => {
  it("sends credentials through the OpenShell sandbox exec boundary", () => {
    const { calls, result, script } = runCredentialTransport();

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("args=sandbox exec --name e2e-hermes-slack -- sh -lc cat >/dev/null");
    expect(calls).toContain("payload=xoxb-test-credential\nxapp-test-credential");
    expect(script).not.toContain("sandbox ssh-config");
    expect(script).not.toMatch(/(?:^|\s)ssh(?:\s|$)/u);
    expect(script).not.toContain("StrictHostKeyChecking=no");
    expect(script).not.toContain("UserKnownHostsFile=/dev/null");
  });

  it("propagates an OpenShell sandbox exec transport failure", () => {
    const { calls, result } = runCredentialTransport(true);

    expect(result.status).not.toBe(0);
    expect(calls).toContain("args=sandbox exec --name e2e-hermes-slack");
  });
});
