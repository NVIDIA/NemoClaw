// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasConfirmedOpenShellPolicyDenial } from "../live/deepagents-observability-contract.ts";

const hostname = "host.openshell.internal";
const dnsFailure = "FAILED:URLError:<urlopen error [Errno -5] No address associated with hostname>";
const dnsEvent = `[2.0] [sandbox] [OCSF ] NET:REFUSE [MED] DENIED ${hostname} [reason:policy_dns_no_valid_address]`;
const port = 4319;
const mappingEvent = `[2.0] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /opt/venv/bin/python3(0) -> 198.18.0.11:${port} [reason:transparent_tcp_mapping_denied]`;
const mappingFailure = `NEMOCLAW_OTLP_PROBE_DNS=${JSON.stringify({ hostname, port, addresses: ["198.18.0.11"] })}\nFAILED:URLError:<urlopen error [Errno 13] Permission denied>`;
const policyEvent = `[2.0] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /opt/venv/bin/python3(0) -> ${hostname}:${port} [reason:transparent_tcp_policy_denied]`;

describe("Deep Agents observability TCP policy denial evidence", () => {
  it.each([
    ["fresh matching denial", "", policyEvent, true],
    ["stale denial", policyEvent, policyEvent, false],
    ["missing denial", "", "", false],
    ["different host", "", policyEvent.replace(hostname, "other.example.test"), false],
    ["different port", "", policyEvent.replace(":4319", ":4318"), false],
    [
      "different executable",
      "",
      policyEvent.replace("/opt/venv/bin/python3", "/usr/bin/python3"),
      false,
    ],
    [
      "unproven identity",
      "",
      policyEvent.replace("transparent_tcp_policy_denied", "identity_unavailable"),
      false,
    ],
  ] as const)("classifies %s with Python permission denial", (_label, before, after, expected) => {
    expect(
      hasConfirmedOpenShellPolicyDenial(mappingFailure, 7, { hostname, port, before, after }),
    ).toBe(expected);
  });
});

describe("Deep Agents observability native mapping denial evidence", () => {
  it("accepts a fresh denial for the probe's resolved synthetic address and port", () => {
    expect(
      hasConfirmedOpenShellPolicyDenial(mappingFailure, 7, {
        hostname,
        port,
        before: "",
        after: mappingEvent,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing audit", mappingFailure, "", "", 7],
    ["stale event", mappingFailure, mappingEvent, mappingEvent, 7],
    [
      "different address",
      mappingFailure,
      "",
      mappingEvent.replace("198.18.0.11", "198.18.0.12"),
      7,
    ],
    ["different port", mappingFailure, "", mappingEvent.replace(":4319", ":4318"), 7],
    [
      "different executable",
      mappingFailure,
      "",
      mappingEvent.replace("/opt/venv/bin/python3", "/usr/bin/python3"),
      7,
    ],
    [
      "unproven identity",
      mappingFailure,
      "",
      mappingEvent.replace("transparent_tcp_mapping_denied", "identity_unavailable"),
      7,
    ],
    ["different host", mappingFailure.replace(hostname, "other.example.test"), "", mappingEvent, 7],
    [
      "unresolved address",
      mappingFailure.replace('"198.18.0.11"', '"192.0.2.1"'),
      "",
      mappingEvent,
      7,
    ],
    [
      "non-synthetic address",
      mappingFailure.replace("198.18.0.11", "192.0.2.1"),
      "",
      mappingEvent.replace("198.18.0.11", "192.0.2.1"),
      7,
    ],
    ["missing DNS record", mappingFailure.split("\n")[1], "", mappingEvent, 7],
    [
      "duplicate DNS record",
      mappingFailure + "\n" + mappingFailure.split("\n")[0],
      "",
      mappingEvent,
      7,
    ],
    [
      "malformed DNS record",
      mappingFailure.replace('{"hostname"', '{broken"hostname"'),
      "",
      mappingEvent,
      7,
    ],
    [
      "null DNS record",
      "NEMOCLAW_OTLP_PROBE_DNS=null\n" + mappingFailure.split("\n")[1],
      "",
      mappingEvent,
      7,
    ],
    [
      "transport failure",
      mappingFailure.replace("[Errno 13] Permission denied", "timed out"),
      "",
      mappingEvent,
      7,
    ],
    ["successful process", mappingFailure, "", mappingEvent, 0],
  ] as const)("rejects %s", (_label, output, before, after, status) => {
    expect(
      hasConfirmedOpenShellPolicyDenial(output, status, { hostname, port, before, after }),
    ).toBe(false);
  });
});

describe("Deep Agents observability DNS denial evidence", () => {
  it("preserves the Python URL error when the probe DNS lookup is denied", () => {
    const shell = fs.readFileSync(
      "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      "utf8",
    );
    const source = shell.match(/python_probe_source\(\) \{\n  cat <<'PY'\n([\s\S]*?)\nPY/u)?.[1];
    expect(source).toBeDefined();
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import socket
def deny_dns(*args, **kwargs):
    raise socket.gaierror(-5, "No address associated with hostname")
socket.getaddrinfo = deny_dns
${source}
`,
        "POST",
        `http://${hostname}:${port}/v1/traces`,
        "probe",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(7);
    expect(
      hasConfirmedOpenShellPolicyDenial(result.stdout, result.status ?? undefined, {
        hostname,
        port,
        before: "",
        after: dnsEvent,
      }),
    ).toBe(true);
  });
  it.each(["policy_dns_ineligible", "policy_dns_no_valid_address"])(
    "accepts a fresh matching %s event with the failed Python probe",
    (reason) => {
      expect(
        hasConfirmedOpenShellPolicyDenial(dnsFailure, 7, {
          hostname,
          before: "",
          after: dnsEvent.replace("policy_dns_no_valid_address", reason),
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["stale event", dnsFailure, dnsEvent, dnsEvent, 7],
    ["missing event", dnsFailure, "", "", 7],
    ["different host", dnsFailure, "", dnsEvent.replace(hostname, "other.example.test"), 7],
    [
      "unrelated reason",
      dnsFailure,
      "",
      dnsEvent.replace("policy_dns_no_valid_address", "timeout"),
      7,
    ],
    ["transport failure", "FAILED:URLError:<urlopen error timed out>", "", dnsEvent, 7],
    ["successful process", dnsFailure, "", dnsEvent, 0],
  ] as const)("rejects %s", (_label, output, before, after, status) => {
    expect(hasConfirmedOpenShellPolicyDenial(output, status, { hostname, before, after })).toBe(
      false,
    );
  });

  it.each([
    ["DNS", dnsFailure, dnsEvent],
    ["mapping", mappingFailure, mappingEvent],
    ["TCP policy", mappingFailure, policyEvent],
  ])("reads %s audit files through the live classifier command", (_label, input, event) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-dns-audit-"));
    const before = path.join(directory, "before.log");
    const after = path.join(directory, "after.log");
    fs.writeFileSync(before, "");
    fs.writeFileSync(after, event);
    try {
      const result = spawnSync(
        path.join(process.cwd(), "node_modules/.bin/tsx"),
        [
          "test/e2e/live/deepagents-observability-contract.ts",
          "denial-state",
          "7",
          before,
          after,
          `http://${hostname}:${port}/v1/traces`,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH }, input },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("policy-denied");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
