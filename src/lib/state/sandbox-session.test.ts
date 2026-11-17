// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOpenshell: vi.fn<() => string | null>(),
}));

vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));

import {
  createSystemDeps,
  getActiveSandboxSessions,
  parseSshProcesses,
  type SessionDetectionDeps,
} from "./sandbox-session";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.resolveOpenshell.mockReset();
});

describe("parseSshProcesses", () => {
  it("returns empty array for empty input", () => {
    expect(parseSshProcesses("", "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(null, "my-sandbox")).toEqual([]);
  });

  it("returns empty array for empty sandbox name", () => {
    expect(parseSshProcesses("12345 ssh openshell-test.default", "")).toEqual([]);
  });

  it("detects SSH process targeting sandbox", () => {
    const output = `12345 ssh -F /tmp/config openshell-my-sandbox.default
67890 ssh -F /tmp/config openshell-other-sandbox.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sandboxName: "my-sandbox",
      pid: 12345,
      sshHost: "openshell-my-sandbox.default",
    });
  });

  // Newer OpenShell routes every sandbox through one fixed `sandbox` alias and
  // names the target only on its proxy command, so the SSH host carries no
  // sandbox reference at all (#9316).
  const PROXY = (id: string) =>
    `ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --gateway 'https://127.0.0.1:8080' --sandbox-id ${id} --token t --gateway-name nemoclaw -o StrictHostKeyChecking=no`;
  const SANDBOX_ID = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
  const interactiveLine = `12345 ${PROXY(SANDBOX_ID)} -tt -o RequestTTY=force -o SetEnv=TERM=xterm-256color sandbox`;
  const forwardLine = `12300 ${PROXY(SANDBOX_ID)} -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18789:127.0.0.1:18789 sandbox`;

  it("detects an interactive OpenShell exec session scoped to its sandbox (#12665)", () => {
    const interactiveExec =
      "45678 /usr/local/bin/openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i";
    expect(parseSshProcesses(interactiveExec, "my-sandbox")).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 45678,
        transport: "openshell-exec",
      },
    ]);
    expect(
      parseSshProcesses(
        "45679 openshell sandbox exec --name my-sandbox -g nemoclaw-9090 --tty -- /bin/bash -i",
        "my-sandbox",
      ),
    ).toEqual([{ sandboxName: "my-sandbox", pid: 45679, transport: "openshell-exec" }]);
    expect(
      parseSshProcesses(
        "45681 openshell sandbox exec --name=my-sandbox --tty -- /bin/bash -i",
        "my-sandbox",
      ),
    ).toEqual([{ sandboxName: "my-sandbox", pid: 45681, transport: "openshell-exec" }]);
    expect(parseSshProcesses(interactiveExec, "other-sandbox")).toEqual([]);
    expect(
      parseSshProcesses(
        "45680 openshell sandbox exec --name my-sandbox-extended --tty -- /bin/bash -i",
        "my-sandbox",
      ),
    ).toEqual([]);
  });

  it("scopes native exec sessions to the requested gateway (#12665)", () => {
    const output =
      "45679 openshell sandbox exec --name my-sandbox -g nemoclaw --tty -- /bin/bash -i\n" +
      "45680 openshell sandbox exec --name my-sandbox -g nemoclaw-9090 --tty -- /bin/bash -i\n" +
      "45682 openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i";

    expect(parseSshProcesses(output, "my-sandbox", null, "nemoclaw")).toEqual([
      { sandboxName: "my-sandbox", pid: 45679, transport: "openshell-exec" },
    ]);
    expect(parseSshProcesses(output, "my-sandbox", null, "nemoclaw-9090")).toEqual([
      { sandboxName: "my-sandbox", pid: 45680, transport: "openshell-exec" },
    ]);
    expect(
      parseSshProcesses(output, "my-sandbox", null, "nemoclaw", new Map([[45682, "nemoclaw"]])),
    ).toContainEqual({ sandboxName: "my-sandbox", pid: 45682, transport: "openshell-exec" });
    expect(parseSshProcesses(output, "my-sandbox")).toHaveLength(3);
    expect(
      parseSshProcesses(
        "45681 openshell sandbox exec --name my-sandbox -g nemoclaw-9090 --tty -- /bin/bash -i",
        "my-sandbox",
        null,
        "nemoclaw",
      ),
    ).toEqual([]);
  });

  it("ignores gateway selectors inside forwarded commands", () => {
    const nativeExec =
      "45683 openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i -g nemoclaw";
    const ssh = "45684 ssh -tt openshell-my-sandbox.default -- --gateway-name nemoclaw";

    expect(parseSshProcesses(nativeExec, "my-sandbox", null, "nemoclaw")).toEqual([]);
    expect(parseSshProcesses(ssh, "my-sandbox", null, "nemoclaw")).toEqual([]);
  });

  it("requires one sandbox name and TTY before the exec separator", () => {
    const wrongSandbox =
      "45685 openshell sandbox exec --name other-sandbox -g nemoclaw --tty -- /bin/bash -i --name my-sandbox";
    const fakeTty =
      "45686 openshell sandbox exec --name my-sandbox -g nemoclaw -- /bin/bash -i --tty";
    const conflictingNames =
      "45687 openshell sandbox exec --name other-sandbox --name my-sandbox -g nemoclaw --tty -- /bin/bash -i";

    expect(
      parseSshProcesses(
        [wrongSandbox, fakeTty, conflictingNames].join("\n"),
        "my-sandbox",
        null,
        "nemoclaw",
      ),
    ).toEqual([]);
  });

  it("does not count noninteractive exec or dashboard forwards (#12665)", () => {
    const noninteractiveExec = "45678 openshell sandbox exec --name my-sandbox -- id -un";
    const ttyNoninteractiveExec = "45680 openshell sandbox exec --name my-sandbox --tty -- id -un";
    const dashboardForward =
      "45679 /usr/local/bin/openshell --gateway nemoclaw-9090 --gateway-endpoint https://127.0.0.1:32665 --workspace default forward service my-sandbox --target-port 32760 --target-host 127.0.0.1 --local 127.0.0.1:32760";
    expect(parseSshProcesses(noninteractiveExec, "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(ttyNoninteractiveExec, "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(dashboardForward, "my-sandbox")).toEqual([]);
  });

  it("scopes SSH aliases and proxies to explicit gateway evidence when requested", () => {
    const knownTarget =
      "12345 ssh -F /tmp/config openshell-my-sandbox.default --gateway-name nemoclaw";
    const siblingTarget =
      "12346 ssh -F /tmp/config openshell-my-sandbox.default --gateway-name nemoclaw-9090";
    const unknownTarget = "12347 ssh -F /tmp/config openshell-my-sandbox.default";
    const knownProxy = interactiveLine.replace("12345", "12348");
    const siblingProxy = interactiveLine
      .replace("12345", "12349")
      .replace("--gateway-name nemoclaw", "--gateway-name nemoclaw-9090");
    const unknownProxy = interactiveLine
      .replace("12345", "12350")
      .replace("--gateway-name nemoclaw", "");

    expect(
      parseSshProcesses(
        [knownTarget, siblingTarget, unknownTarget].join("\n"),
        "my-sandbox",
        null,
        "nemoclaw",
      ).map(({ pid }) => pid),
    ).toEqual([12345]);
    expect(
      parseSshProcesses(
        [knownProxy, siblingProxy, unknownProxy].join("\n"),
        "my-sandbox",
        SANDBOX_ID,
        "nemoclaw",
      ).map(({ pid }) => pid),
    ).toEqual([12348]);
    // Callers without a gateway selector retain legacy alias matching.
    expect(parseSshProcesses(unknownTarget, "my-sandbox")).toHaveLength(1);
  });

  it("detects a proxied interactive session by sandbox ID (#9316)", () => {
    expect(parseSshProcesses(interactiveLine, "my-sandbox", SANDBOX_ID)).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 12345,
        sshHost: "openshell-my-sandbox.default",
      },
    ]);
  });

  it("does not count the dashboard forward as a session (#9316)", () => {
    // The forward runs through the same proxy and sandbox ID; only the
    // interactive session requests a TTY. Counting it would report a session
    // on every Ready sandbox.
    expect(parseSshProcesses(forwardLine, "my-sandbox", SANDBOX_ID)).toEqual([]);
    expect(
      parseSshProcesses(`${forwardLine}\n${interactiveLine}`, "my-sandbox", SANDBOX_ID),
    ).toHaveLength(1);
  });

  it("does not attribute a proxied session without a known sandbox ID (#9316)", () => {
    // The command line carries no sandbox name, so guessing would attribute one
    // sandbox's session to another.
    expect(parseSshProcesses(interactiveLine, "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(interactiveLine, "my-sandbox", "")).toEqual([]);
  });

  it("does not match another sandbox's ID (#9316)", () => {
    expect(
      parseSshProcesses(interactiveLine, "other-sandbox", "aaaaaaaa-0000-0000-0000-000000000000"),
    ).toEqual([]);
  });

  it("detects a legacy SSH process during the upgrade window", () => {
    const output = `12345 ssh -F /tmp/config openshell-my-sandbox
67890 ssh -F /tmp/config openshell-other-sandbox`;
    expect(parseSshProcesses(output, "my-sandbox")).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 12345,
        sshHost: "openshell-my-sandbox",
      },
    ]);
  });

  it("detects multiple SSH sessions to the same sandbox", () => {
    const output = `111 ssh -F /tmp/a.conf openshell-dev.default
222 ssh -F /tmp/b.conf openshell-dev.default
333 ssh -F /tmp/c.conf openshell-prod.default`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.pid)).toEqual([111, 222]);
  });

  it("ignores unrelated SSH processes", () => {
    const output = `100 ssh user@remote-host
200 ssh -F config openshell-my-sandbox.default
300 /usr/bin/ssh-agent`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(200);
  });

  it("does not match partial sandbox name prefixes", () => {
    // openshell-my-sandbox-extended.default should NOT match
    // openshell-my-sandbox.default
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox-extended.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    // Word-boundary matching ensures `openshell-my-sandbox.default` does not
    // match inside `openshell-my-sandbox-extended.default`.
    expect(sessions).toHaveLength(0);
  });

  it("does not match partial legacy sandbox name prefixes", () => {
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox-extended`;
    expect(parseSshProcesses(output, "my-sandbox")).toHaveLength(0);
  });

  it("matches sandbox name at end of line", () => {
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(100);
  });

  it("matches sandbox name followed by whitespace", () => {
    const output = `100 ssh -F /tmp/cfg -o StrictHostKeyChecking=no openshell-dev.default -t bash`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(1);
  });
});

describe("getActiveSandboxSessions", () => {
  it("attributes legacy native exec only to its extracted gateway and never exposes secrets", () => {
    const output =
      "45682 openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i\n" +
      "45683 openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i";
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => output,
      resolveNativeExecGateway: (pid) => (pid === 45682 ? "nemoclaw" : null),
    };
    const first = getActiveSandboxSessions("my-sandbox", deps, "nemoclaw");
    const sibling = getActiveSandboxSessions("my-sandbox", deps, "nemoclaw-9090");
    expect(first.sessions.map(({ pid }) => pid)).toEqual([45682]);
    expect(sibling.sessions).toEqual([]);
    expect(JSON.stringify([first, sibling])).not.toContain("SECRET");
  });

  it.skipIf(process.platform !== "linux")(
    "uses only OPENSHELL_GATEWAY from process env and does not expose another variable",
    () => {
      const secret = "session-test-secret-value";
      const command = "openshell sandbox exec --name my-sandbox --tty -- /bin/bash -i";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        argv0: command,
        env: { ...process.env, OPENSHELL_GATEWAY: "nemoclaw", SESSION_TEST_SECRET: secret },
        stdio: "ignore",
      });
      const log = vi.spyOn(console, "log");
      try {
        expect(child.pid).toBeDefined();
        const line = `${String(child.pid)} ${command} -e setInterval(() => {}, 1000)`;
        const deps = createSystemDeps(undefined, {
          spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: line, stderr: "" }) as never,
        });
        const result = getActiveSandboxSessions("my-sandbox", deps, "nemoclaw");
        expect(result.sessions).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        child.kill();
      }
    },
  );

  it("does not resolve gateway identity for unrelated or noninteractive processes", () => {
    const resolveNativeExecGateway = vi.fn(() => "nemoclaw");
    const resolveSshConfigGateway = vi.fn(() => "nemoclaw");
    const deps: SessionDetectionDeps = {
      getSshProcesses: () =>
        "12345 openshell sandbox exec --name other-sandbox --tty -- /bin/bash -i\n" +
        "12346 openshell sandbox exec --name my-sandbox -- id -un\n" +
        "12347 ssh -F /tmp/nemoclaw-acp-ssh-foo/ssh_config openshell-other-sandbox.default\n" +
        "12348 openshell sandbox exec --name my-sandbox -g nemoclaw --tty -- /bin/bash -i\n" +
        "12349 openshell sandbox exec --name other-sandbox --tty -- /bin/bash -i --name my-sandbox\n" +
        "12350 openshell sandbox exec --name my-sandbox -- /bin/bash -i --tty",
      resolveNativeExecGateway,
      resolveSshConfigGateway,
    };
    getActiveSandboxSessions("my-sandbox", deps, "nemoclaw");
    expect(resolveNativeExecGateway).not.toHaveBeenCalled();
    expect(resolveSshConfigGateway).not.toHaveBeenCalled();
  });

  it("reads gateway identity only from the NemoClaw ACP SSH config", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-acp-ssh-"));
    const config = join(directory, "ssh_config");
    writeFileSync(
      config,
      "Host openshell-my-sandbox.default\n  ProxyCommand openshell ssh-proxy --gateway-name nemoclaw\n",
      { mode: 0o600 },
    );
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: `12345 ssh -F ${config} -T openshell-my-sandbox.default\n12346 ssh -F ${join(directory, "foreign.conf")} -T openshell-my-sandbox.default`,
      stderr: "",
    });
    const deps = createSystemDeps(undefined, { spawnSync: spawn as never });
    try {
      expect(
        getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions.map(({ pid }) => pid),
      ).toEqual([12345]);
      expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw-9090").sessions).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects untrusted permissions and oversized ACP SSH configs", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-acp-ssh-"));
    const config = join(directory, "ssh_config");
    const output = `12349 ssh -F ${config} -T openshell-my-sandbox.default`;
    const deps = createSystemDeps(undefined, {
      spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: output, stderr: "" }) as never,
    });
    try {
      writeFileSync(config, "ProxyCommand openshell ssh-proxy --gateway-name nemoclaw\n", {
        mode: 0o600,
      });
      chmodSync(directory, 0o777);
      expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions).toEqual([]);

      chmodSync(directory, 0o700);
      chmodSync(config, 0o644);
      expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions).toEqual([]);

      chmodSync(config, 0o600);
      writeFileSync(config, Buffer.alloc(1_048_577), { mode: 0o600 });
      expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions).toEqual([]);

      rmSync(config);
      const target = join(directory, "other_config");
      writeFileSync(target, "ProxyCommand openshell ssh-proxy --gateway-name nemoclaw\n", {
        mode: 0o600,
      });
      symlinkSync(target, config);
      expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects conflicting and multiple native gateway selectors", () => {
    const output =
      "45684 openshell sandbox exec --name my-sandbox -g nemoclaw --gateway nemoclaw-9090 --tty -- /bin/bash -i";
    const deps: SessionDetectionDeps = { getSshProcesses: () => output };
    expect(getActiveSandboxSessions("my-sandbox", deps, "nemoclaw").sessions).toEqual([]);
  });

  it("includes interactive native exec processes in the system probe (#12665)", () => {
    mocks.resolveOpenshell.mockReturnValue(null);
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout:
        " 45678 /usr/local/bin/openshell sandbox exec --name my-sandbox -g nemoclaw --tty -- /bin/bash -i\n" +
        " 45679 /usr/local/bin/openshell sandbox exec --name my-sandbox -g nemoclaw-9090 --tty -- /bin/bash -i\n" +
        " 45680 openshell sandbox exec --name my-sandbox -- id -un\n" +
        " 45680 /usr/local/bin/openshell --gateway nemoclaw-9090 --gateway-endpoint https://127.0.0.1:32665 --workspace default forward service my-sandbox --target-port 32760 --target-host 127.0.0.1 --local 127.0.0.1:32760\n",
      stderr: "",
    });

    const result = getActiveSandboxSessions(
      "my-sandbox",
      createSystemDeps(undefined, { spawnSync: spawn as never }),
      "nemoclaw",
    );

    expect(result).toEqual({
      detected: true,
      sessions: [
        {
          sandboxName: "my-sandbox",
          pid: 45678,
          transport: "openshell-exec",
        },
      ],
    });
  });

  it("uses the default OpenShell resolver for proxied session lookup", () => {
    const sandboxId = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
    mocks.resolveOpenshell.mockReturnValue("/resolved/openshell");
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `12345 ssh -o ProxyCommand=/resolved/openshell ssh-proxy --sandbox-id ${sandboxId} --token t -tt -o RequestTTY=force sandbox`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: `Id: ${sandboxId}\n`, stderr: "" });

    const result = getActiveSandboxSessions(
      "my-sandbox",
      createSystemDeps(undefined, { spawnSync: spawn as never }),
    );

    expect(mocks.resolveOpenshell).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/resolved/openshell",
      ["sandbox", "get", "my-sandbox"],
      expect.any(Object),
    );
    expect(result.sessions).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 12345,
        sshHost: "openshell-my-sandbox.default",
      },
    ]);
  });

  it("preserves legacy session lookup when the default OpenShell resolver is unavailable", () => {
    const sandboxId = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
    mocks.resolveOpenshell.mockReturnValue(null);
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: `12345 ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --sandbox-id ${sandboxId} --token t -tt -o RequestTTY=force sandbox
67890 ssh -F /tmp/config openshell-my-sandbox.default`,
      stderr: "",
    });

    const result = getActiveSandboxSessions(
      "my-sandbox",
      createSystemDeps(undefined, { spawnSync: spawn as never }),
    );

    expect(mocks.resolveOpenshell).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(result).toEqual({
      detected: true,
      sessions: [
        {
          sandboxName: "my-sandbox",
          pid: 67890,
          sshHost: "openshell-my-sandbox.default",
        },
      ],
    });
  });

  it("pins a proxied session lookup to the recorded OpenShell target (#10514)", () => {
    const sandboxId = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `12345 ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --sandbox-id ${sandboxId} --token t -tt -o RequestTTY=force sandbox`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: `Id: ${sandboxId}\n`, stderr: "" });
    const runtimeSelection = {
      gatewayName: "nemoclaw-9090",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };

    const result = getActiveSandboxSessions(
      "my-sandbox",
      createSystemDeps("/usr/bin/openshell", {
        runtimeSelection,
        spawnSync: spawn as never,
      }),
    );

    expect(result.sessions).toHaveLength(1);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/openshell",
      ["sandbox", "get", "-g", "nemoclaw-9090", "my-sandbox"],
      expect.any(Object),
    );
    const openshellOptions = spawn.mock.calls[1]?.[2] as
      | { env?: Record<string, string> }
      | undefined;
    expect(openshellOptions?.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-9090",
      OPENSHELL_WORKSPACE: "default",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
    });
    expect(openshellOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(openshellOptions?.env).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("resolves and caches proxied session IDs by owning gateway (#12665)", () => {
    const outputs: Record<string, string> = {
      ps: [
        "120 ssh -tt -o ProxyCommand=openshell ssh-proxy --sandbox-id id-a --gateway-name gateway-a sandbox",
        "121 ssh -tt -o ProxyCommand=openshell ssh-proxy --sandbox-id id-b --gateway-name gateway-b sandbox",
      ].join("\n"),
      "gateway-a": "Id: id-a\n",
      "gateway-b": "Id: id-b\n",
    };
    const spawn = vi.fn((binary: string, args: string[]) => ({
      status: 0,
      stdout: outputs[binary === "ps" ? binary : args[args.indexOf("-g") + 1]!] ?? "",
      stderr: "",
    }));
    const deps = createSystemDeps("/usr/bin/openshell", { spawnSync: spawn as never });

    expect(
      getActiveSandboxSessions("same-name", deps, "gateway-a").sessions.map((s) => s.pid),
    ).toEqual([120]);
    expect(
      getActiveSandboxSessions("same-name", deps, "gateway-b").sessions.map((s) => s.pid),
    ).toEqual([121]);
    expect(
      getActiveSandboxSessions("same-name", deps, "gateway-a").sessions.map((s) => s.pid),
    ).toEqual([120]);
    expect(spawn.mock.calls.filter(([binary]) => binary !== "ps").map(([, args]) => args)).toEqual([
      ["sandbox", "get", "-g", "gateway-a", "same-name"],
      ["sandbox", "get", "-g", "gateway-b", "same-name"],
    ]);
  });

  it("returns detected=false when no deps available", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("returns detected=false for empty sandbox name", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "some output",
    };
    const result = getActiveSandboxSessions("", deps);
    expect(result.detected).toBe(false);
  });

  it("detects sessions from pgrep output", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "12345 ssh -F /tmp/cfg openshell-my-sandbox.default\n",
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(12345);
  });

  it("resolves a durable ID for a proxied interactive session (#9316)", () => {
    const sandboxId = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
    const resolveSandboxId = vi.fn(() => sandboxId);
    const deps: SessionDetectionDeps = {
      getSshProcesses: () =>
        `12345 ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --sandbox-id ${sandboxId} --token t -tt -o RequestTTY=force sandbox`,
      resolveSandboxId,
    };

    const result = getActiveSandboxSessions("my-sandbox", deps);

    expect(resolveSandboxId).toHaveBeenCalledExactlyOnceWith("my-sandbox", undefined);
    expect(result).toEqual({
      detected: true,
      sessions: [
        {
          sandboxName: "my-sandbox",
          pid: 12345,
          sshHost: "openshell-my-sandbox.default",
        },
      ],
    });
  });

  it("does not resolve a durable ID for a host-alias session (#9316)", () => {
    const resolveSandboxId = vi.fn(() => "unused-id");
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "12345 ssh -F /tmp/cfg openshell-my-sandbox.default\n",
      resolveSandboxId,
    };

    const result = getActiveSandboxSessions("my-sandbox", deps);

    expect(resolveSandboxId).not.toHaveBeenCalled();
    expect(result.sessions).toHaveLength(1);
  });

  it("returns detected=false when SSH process discovery is unavailable", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("returns discovered SSH sessions", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "200 ssh -F /tmp/cfg openshell-dev.default\n",
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(200);
  });
});
