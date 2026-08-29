// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupFixtures,
  emittedOutput,
  fixture,
  gatewayChildJournal,
  run,
} from "../helpers/brev-launchable-e2e-fixture";

afterEach(cleanupFixtures);

describe("focused staging Brev Launchable failure diagnostics", () => {
  const classifierCases: Array<[string, string, string]> = [
    [
      "a primary address conflict",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        "Error: transport error: failed to bind to 127.0.0.1:8080: Address already in use (os error 98)",
      ]),
      "primary address in use",
    ],
    [
      "a callback address conflict",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Address already",
        "in use (os error 98)",
      ]),
      "callback address in use",
    ],
    [
      "an unavailable callback address",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Cannot assign requested",
        "address (os error 99)",
      ]),
      "callback address unavailable",
    ],
    [
      "another bind failure",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Permission denied (os error 13)",
      ]),
      "bind failure unclassified",
    ],
    [
      "a deceptive start marker",
      gatewayChildJournal([
        "Not Starting OpenShell server",
        "Error: transport error: failed to bind to 172.18.0.1:8080: Address already in use (os error 98)",
      ]),
      "bind failure unclassified",
    ],
    [
      "a deceptive primary-listener marker",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Not Gateway listener bound listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Cannot assign requested address (os error 99)",
      ]),
      "bind failure unclassified",
    ],
    [
      "an unrelated errno continuation",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Cannot assign requested",
        "database retry failed (os error 99)",
      ]),
      "bind failure unclassified",
    ],
    [
      "the latest completed attempt",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Cannot assign requested address (os error 99)",
        "Starting OpenShell server bind=127.0.0.1:8080",
        "Error: transport error: failed to bind to 127.0.0.1:8080: Address already in use (os error 98)",
      ]),
      "primary address in use",
    ],
    [
      "a message without a bind failure",
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "TLS error: guest-controlled detail",
      ]),
      "no bind failure",
    ],
    [
      "a matching message from another unit",
      gatewayChildJournal(
        [
          "Starting OpenShell server bind=127.0.0.1:8080",
          "Error: transport error: failed to bind to 127.0.0.1:8080: Address already in use (os error 98)",
        ],
        { unit: "guest-controlled.service" },
      ),
      "no bind failure",
    ],
    [
      "a matching message from another executable",
      gatewayChildJournal(
        [
          "Starting OpenShell server bind=127.0.0.1:8080",
          "Error: transport error: failed to bind to 127.0.0.1:8080: Address already in use (os error 98)",
        ],
        { executable: "/tmp/guest-controlled-gateway" },
      ),
      "no bind failure",
    ],
  ];
  let lifecycleCommand = "";

  beforeAll(() => {
    const created = fixture({ e2eFails: true });
    const result = run(created.env);
    expect(result.status, result.stderr).not.toBe(0);
    expect(
      fs.existsSync(created.gatewayLifecycleCommand),
      "the failing Launchable lane did not capture the OpenShell gateway diagnostic command",
    ).toBe(true);
    lifecycleCommand = fs.readFileSync(created.gatewayLifecycleCommand, "utf8");
    cleanupFixtures();
  });

  it("retains fixed OpenShell gateway classifications before deleting the failed Brev workspace (#6409)", () => {
    const { calls, env, state, workDir } = fixture({ e2eFails: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh preinstalled full-e2e.test.ts")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway state"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway state")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(commands.match(/ssh full-e2e diagnostic/gu)).toHaveLength(6);

    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("Full E2E failure diagnostics budget: up to 30 seconds");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway state: status 0; output:");
    expect(laneLog).toContain("ActiveState : inactive");
    expect(laneLog).toContain("NRestarts : 0");
    expect(laneLog).toContain("restart-policy is always: true");
    expect(laneLog).toContain("exec-start matches packaged gateway service: true");
    expect(laneLog).toContain("fragment-path is packaged unit path: true");
    expect(laneLog).toContain("drop-ins: absent");
    expect(laneLog).toContain("Full E2E failure diagnostic platform state: status 0; output:");
    expect(laneLog).toContain("gateway service requires Docker service: present");
    expect(laneLog).toContain("gateway service ordered after Docker service: present");
    expect(laneLog).toContain("Docker service wants gateway service: present");
    expect(laneLog).not.toContain("boot-id-prefix");
    expect(laneLog).toContain("boot-uptime-seconds 180");
    expect(laneLog).toContain("gateway-state-dir type=directory uid=1000 gid=1000 mode=750");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("1000 starting");
    expect(laneLog).toContain("1100 started");
    expect(laneLog).toContain("1200 other-systemd-event");
    expect(laneLog).toContain("1300 start-limit-hit");
    expect(laneLog).toContain("1400 restart-scheduled");
    expect(laneLog).toContain("1500 main-exited");
    expect(laneLog).toContain("1600 failed-result");
    expect(laneLog).toContain("1700 dependency-failed");
    expect(laneLog).toContain("2200 stopping");
    expect(laneLog).toContain("2300 deactivated");
    expect(laneLog).toContain("2400 stopped");
    expect(laneLog).toContain("gateway-child-bind callback address unavailable");
    expect(laneLog).toContain("Full E2E failure diagnostic Docker lifecycle: status 0; output:");
    expect(laneLog).toContain("900 docker-service starting");
    expect(laneLog).toContain("950 docker-service started");
    expect(laneLog).toContain("960 docker-socket started");
    expect(laneLog).toContain("970 docker-unit other-systemd-event");
    expect(laneLog).toContain("Full E2E failure diagnostic cloud-final state: status 0; output:");
    expect(laneLog).toContain("SubState : exited");
    expect(laneLog).toContain("active-enter-us: 1200");
    expect(laneLog).toContain("inactive-enter-us: 0");
    expect(laneLog).toContain("listener presence: present");
    expect(laneLog).toContain("listener owner: unexpected");
    expect(laneLog).not.toContain("s3cr3t");
    const diagnosticLines = laneLog
      .split("\n")
      .filter((line) => line.startsWith("Full E2E failure diagnostic "));
    expect(diagnosticLines).toHaveLength(6);
    diagnosticLines
      .filter((line) => line.includes("; output: "))
      .forEach((line) => {
        const payload = line.split("; output: ", 2)[1] ?? "";
        expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(512);
      });
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
        "s3cr3t",
        "gateway-child-test-secret",
        "child.hidden.internal",
        "172.18.0.1",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      fullE2e: "failed",
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "passed" },
        fullE2E: "failed",
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each(classifierCases)(
    "classifies %s without retaining OpenShell gateway journal text (#6409)",
    (_name, childJournal, expectedCategory) => {
      const { env } = fixture();
      const classified = spawnSync("bash", ["-c", lifecycleCommand], {
        encoding: "utf8",
        env: { ...env, FAKE_GATEWAY_CHILD_JOURNAL: childJournal },
      });

      expect(classified.status, classified.stderr).toBe(0);
      expect(classified.stdout.trimEnd().split("\n").at(-1)).toBe(
        `gateway-child-bind\t${expectedCategory}`,
      );
      expect(classified.stderr).toBe("");
    },
  );

  it("retains only a fixed classification from hostile OpenShell gateway journal fields (#6409)", () => {
    const { env, workDir } = fixture();
    const commandMarker = path.join(path.dirname(workDir), "journal-command-executed");
    const injectedValues = [
      "gateway-child-api-secret",
      "gateway-child-bearer-secret",
      "gateway-child-private-key",
      "203.0.113.61",
      "gateway-child.hidden.internal",
      "guest-process-label",
      "/guest-controlled/cgroup",
      commandMarker,
    ];
    const privateKeyMarker = `-----BEGIN ${"PRIVATE KEY"}-----`;
    const maliciousJournal = JSON.stringify({
      _PID: "77",
      _SYSTEMD_UNIT: "openshell-gateway.service",
      _EXE: "/usr/local/bin/openshell-gateway",
      MESSAGE: [
        "No bind failure",
        "api_key=gateway-child-api-secret",
        "Authorization: Bearer gateway-child-bearer-secret",
        `${privateKeyMarker} gateway-child-private-key -----END PRIVATE KEY-----`,
        "203.0.113.61 gateway-child.hidden.internal guest-process-label",
        "/guest-controlled/cgroup",
        `$(touch ${commandMarker})`,
        "x".repeat(5000),
      ].join(" "),
      PROCESS_LABEL: "guest-process-label",
      CGROUP: "/guest-controlled/cgroup",
    });
    const classified = spawnSync("bash", ["-c", lifecycleCommand], {
      encoding: "utf8",
      env: { ...env, FAKE_GATEWAY_CHILD_JOURNAL: maliciousJournal },
    });

    expect(classified.status, classified.stderr).toBe(0);
    expect(classified.stdout.trimEnd().split("\n").at(-1)).toBe(
      "gateway-child-bind\tno bind failure",
    );
    expect(
      injectedValues.filter((value) =>
        `${classified.stdout}\n${classified.stderr}`.includes(value),
      ),
    ).toEqual([]);
    expect(fs.existsSync(commandMarker)).toBe(false);
  });

  it("preserves the E2E failure and confirms Brev workspace absence when OpenShell gateway journal parsing fails (#6409)", () => {
    const { env, state, workDir } = fixture({
      e2eFails: true,
      gatewayChildJournal: "not-json password=gateway-parser-secret 203.0.113.62",
    });
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain(
      "Full E2E failure diagnostic gateway lifecycle: status 42; output: no diagnostic output",
    );
    expect(emittedOutput(result, workDir)).not.toContain("gateway-parser-secret");
    expect(emittedOutput(result, workDir)).not.toContain("203.0.113.62");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("continues bounded diagnostics and cleanup after a probe error (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eFails: true,
      platformDiagnosticFails: true,
    });
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("Full E2E failure diagnostic platform state: status 42; output:");
    expect(laneLog).toContain("platform diagnostic safe detail");
    expect(laneLog).toContain("[REDACTED PRIVATE KEY]");
    expect(laneLog).toContain("[REDACTED LONG LINE]");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("Full E2E failure diagnostic port 8080 listener: status 0; output:");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh full-e2e diagnostic platform state")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway lifecycle"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway lifecycle")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["absent", "", ["listener presence: absent"]],
    [
      "expected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v2 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=97,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in an exact v1 cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=96,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v1 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=95,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "mixed owners",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        'LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=99,fd=4))',
      ].join("\n"),
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "mixed owners in one socket record",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3),("s3cr3t",pid=99,fd=4))',
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "unexpected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gatew",pid=94,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "unrelated cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("other-process",pid=93,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "owner unavailable",
      "LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*",
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "PID-like text inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t,pid=7,fd=8",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "an injected owner tuple inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=98,fd=3",pid=99,fd=4))',
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "one socket record without owner metadata",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        "LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:*",
      ].join("\n"),
      ["listener presence: present", "listener owner: unavailable"],
    ],
  ])(
    "classifies port 8080 listener evidence with %s (#6409)",
    (_name, listenerOutput, expectedEvidence) => {
      const { env, workDir } = fixture({
        e2eFails: true,
        listenerOutput,
      });
      const result = run(env);

      expect(result.status).not.toBe(0);
      const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
      expectedEvidence.forEach((entry) => expect(laneLog).toContain(entry));
      expect(laneLog).not.toContain("s3cr3t");
      expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject(
        { status: "ABSENT" },
      );
    },
  );

  it.each([
    [
      "a similarly prefixed executable",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; ignore_errors=no ; }",
      "nemoclaw-openshell-gateway-service-wrapper",
    ],
    [
      "an extra argument",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service --extra ; ignore_errors=no ; }",
      "--extra",
    ],
    [
      "a second serialized command",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service ; ignore_errors=no ; } { path=/usr/bin/true ; argv[]=/usr/bin/true ; ignore_errors=no ; }",
      "/usr/bin/true",
    ],
  ])("rejects gateway ExecStart with %s (#6409)", (_name, gatewayExecStart, rawValue) => {
    const { env, workDir } = fixture({ e2eFails: true, gatewayExecStart });
    const result = run(env);

    expect(result.status).not.toBe(0);
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("exec-start matches packaged gateway service: false");
    expect(laneLog).not.toContain(rawValue);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("keeps the E2E failure and cleanup when the diagnostic budget expires (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eDiagnosticTimesOut: true,
      e2eFails: true,
    });
    const result = run({
      ...env,
      FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain(
      "Full E2E failure diagnostic gateway state: status 124; output: probe timed out",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic platform state: not run; output: diagnostic budget exhausted",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic port 8080 listener: not run; output: diagnostic budget exhausted",
    );
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).not.toContain("ssh full-e2e diagnostic platform state");
    expect(commands.indexOf("ExecMainCode")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });
});
