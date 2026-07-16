// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  headlessCheckPath,
  runHeadlessCheckHelper,
  runHeadlessCheckSnippet,
} from "./helpers/langchain-deepagents-code-headless.ts";

describe("LangChain Deep Agents Code headless runtime contracts", () => {
  it("binds bare connect to every observed OpenShell sandbox exec target (#7034)", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-connect-target-"));
    const cliFixture = path.join(fixtureDir, "nemoclaw");
    const openshellFixture = path.join(fixtureDir, "openshell");
    const cliCallLog = path.join(fixtureDir, "cli-calls.log");
    const openshellCallLog = path.join(fixtureDir, "openshell-calls.log");

    try {
      fs.writeFileSync(
        cliFixture,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          '[ "${SANDBOX_NAME+x}" != x ]',
          '[ "${NEMOCLAW_SANDBOX_NAME+x}" != x ]',
          '[ "${NEMOCLAW_SANDBOX+x}" != x ]',
          'printf "%s\\n" "$*" >>"$TEST_CLI_CALL_LOG"',
          '[ "$#" -eq 2 ] && [ "$1" = connect ] && [ "$2" = --probe-only ]',
          "for target in $TEST_CONNECT_TARGETS; do",
          '  "$NEMOCLAW_OPENSHELL_BIN" sandbox exec -n "$target" -- true',
          "done",
          'printf "%s\\n" NEMOCLAW_DCODE_CONNECT_OK',
          'exit "$TEST_CONNECT_EXIT"',
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        openshellFixture,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          'printf "%s\\n" "$*" >>"$TEST_OPENSHELL_CALL_LOG"',
          "",
        ].join("\n"),
        "utf8",
      );
      fs.chmodSync(cliFixture, 0o755);
      fs.chmodSync(openshellFixture, 0o755);

      const runCommandProbe = (targets: string, connectExit = 0) => {
        fs.writeFileSync(cliCallLog, "", "utf8");
        fs.writeFileSync(openshellCallLog, "", "utf8");
        const output = runHeadlessCheckSnippet(
          [
            'if output="$(nemoclaw_connect_probe 2>&1)"; then',
            '  printf "pass:%s" "$output"',
            "else",
            "  status=$?",
            '  printf "fail:%s:%s" "$status" "$output"',
            "fi",
          ].join("\n"),
          {
            NEMOCLAW_CLI_BIN: cliFixture,
            NEMOCLAW_SANDBOX: "legacy-environment-shortcut",
            NEMOCLAW_SANDBOX_NAME: "environment-shortcut",
            PATH: `${fixtureDir}:/usr/bin:/bin`,
            SANDBOX_NAME: "dcode-managed",
            TEST_CLI_CALL_LOG: cliCallLog,
            TEST_CONNECT_EXIT: String(connectExit),
            TEST_CONNECT_TARGETS: targets,
            TEST_OPENSHELL_CALL_LOG: openshellCallLog,
            TMPDIR: fixtureDir,
          },
        );
        const readCalls = (file: string) => {
          const text = fs.readFileSync(file, "utf8").trim();
          return text ? text.split("\n") : [];
        };
        expect(
          fs.readdirSync(fixtureDir).filter((entry) => entry.startsWith("nemoclaw-dcode-connect.")),
        ).toEqual([]);
        return {
          cliCalls: readCalls(cliCallLog),
          openshellCalls: readCalls(openshellCallLog),
          output,
        };
      };

      const matchingTarget = runCommandProbe("dcode-managed");
      expect(matchingTarget).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: ["sandbox exec -n dcode-managed -- true"],
        output: "pass:NEMOCLAW_DCODE_CONNECT_OK",
      });
      const repeatedMatchingTarget = runCommandProbe("dcode-managed dcode-managed");
      expect(repeatedMatchingTarget).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: [
          "sandbox exec -n dcode-managed -- true",
          "sandbox exec -n dcode-managed -- true",
        ],
        output: "pass:NEMOCLAW_DCODE_CONNECT_OK",
      });
      const wrongTarget = runCommandProbe("another-sandbox");
      expect(wrongTarget).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: ["sandbox exec -n another-sandbox -- true"],
        output: "fail:1:NEMOCLAW_DCODE_CONNECT_OK\nNEMOCLAW_DCODE_CONNECT_TARGET_FAIL:mismatch",
      });
      const missingTarget = runCommandProbe("");
      expect(missingTarget).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: [],
        output: "fail:1:NEMOCLAW_DCODE_CONNECT_OK\nNEMOCLAW_DCODE_CONNECT_TARGET_FAIL:missing",
      });
      const mixedTargets = runCommandProbe("dcode-managed another-sandbox");
      expect(mixedTargets).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: [
          "sandbox exec -n dcode-managed -- true",
          "sandbox exec -n another-sandbox -- true",
        ],
        output: "fail:1:NEMOCLAW_DCODE_CONNECT_OK\nNEMOCLAW_DCODE_CONNECT_TARGET_FAIL:mismatch",
      });
      const failedConnect = runCommandProbe("dcode-managed", 72);
      expect(failedConnect).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: ["sandbox exec -n dcode-managed -- true"],
        output: "fail:72:NEMOCLAW_DCODE_CONNECT_OK",
      });
      const failedConnectToWrongTarget = runCommandProbe("another-sandbox", 72);
      expect(failedConnectToWrongTarget).toEqual({
        cliCalls: ["connect --probe-only"],
        openshellCalls: ["sandbox exec -n another-sandbox -- true"],
        output: "fail:1:NEMOCLAW_DCODE_CONNECT_OK\nNEMOCLAW_DCODE_CONNECT_TARGET_FAIL:mismatch",
      });
    } finally {
      fs.rmSync(fixtureDir, { force: true, recursive: true });
    }
  });

  it("requires exit zero and PONG from Deep Agents Code headless inference (#6191)", () => {
    const classify = (exitCode: string, output: string) =>
      runHeadlessCheckHelper("classify-output", {
        DCODE_EXIT: exitCode,
        HEADLESS_OUTPUT: output,
      });

    expect(classify("0", "startup log\n  PONG  \nDCODE_EXIT:0")).toBe("pass:pong");
    expect(
      classify("1", "OpenAI provider returned HTTP 401 for inference.local\nDCODE_EXIT:1"),
    ).toBe("fail:actionable-inference-error");
    expect(classify("1", "PONG\nDCODE_EXIT:1")).toBe("fail:nonzero-exit");
    expect(classify("1", "openai.APIConnectionError\nDCODE_EXIT:1")).toBe(
      "fail:inference-connection-failure",
    );
    expect(classify("1", "Could not resolve host inference.local\nDCODE_EXIT:1")).toBe(
      "fail:inference-connection-failure",
    );
    expect(classify("0", "OpenAI provider unavailable\nDCODE_EXIT:0")).toBe(
      "fail:actionable-inference-error",
    );
    expect(classify("0", "dcode version 0.1.12\nOpenAI provider unavailable\nDCODE_EXIT:0")).toBe(
      "fail:actionable-inference-error",
    );
    expect(classify("124", "still waiting\nDCODE_EXIT:124")).toBe("fail:timeout");
    expect(classify("1", "usage: dcode [-h]\nDCODE_EXIT:1")).toBe("fail:local-execution-failure");
    expect(classify("1", "Traceback (most recent call last):\nDCODE_EXIT:1")).toBe(
      "fail:local-execution-failure",
    );
    expect(classify("127", "bash: dcode: command not found\nDCODE_EXIT:127")).toBe(
      "fail:wrapper-missing",
    );
    expect(classify("1", "No module named deepagents_code\nDCODE_EXIT:1")).toBe(
      "fail:wrapper-missing",
    );
    // The word 'dcode' appearing in a non-error context (e.g. a version
    // banner) must not be misclassified as a wrapper-missing failure. The
    // is_dcode_wrapper_failure regex requires a specific error indicator
    // ("command not found", "No such file or directory", "Permission denied",
    // or "No module named deepagents_code") after the dcode path segment.
    // See PR #6206 / advisor PRA-2.
    expect(classify("0", "  PONG  \nDCODE_EXIT:0")).toBe("pass:pong");
    expect(classify("0", "dcode version 0.1.12\nPONG\nDCODE_EXIT:0")).toBe("pass:pong");
    expect(classify("0", "something happened\nDCODE_EXIT:0")).toBe("fail:ambiguous-output");
    expect(classify("0", "Reply with exactly one word: PONG\nDCODE_EXIT:0")).toBe(
      "fail:ambiguous-output",
    );
    expect(classify("0", "PONG because the route works\nDCODE_EXIT:0")).toBe(
      "fail:ambiguous-output",
    );
    expect(classify("1", "something happened\nDCODE_EXIT:1")).toBe("fail:nonzero-exit");
  });

  it("accepts only the normalized login-shell proxy contract (#6191)", () => {
    const validate = (proxyUrl: string, noProxy: string, lowerProxy = proxyUrl) => {
      const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-login-"));
      const hostFile = path.join(loginHome, "trusted-proxy-host");
      const portFile = path.join(loginHome, "trusted-proxy-port");
      const proxyEnvFile = path.join(loginHome, "proxy-env.sh");
      const checkFixture = path.join(loginHome, "headless-check.sh");
      const runtimeUid = process.getuid?.() ?? 0;
      fs.writeFileSync(hostFile, "10.200.0.1\n", "utf8");
      fs.writeFileSync(portFile, "3128\n", "utf8");
      fs.chmodSync(hostFile, 0o444);
      fs.chmodSync(portFile, 0o444);
      fs.writeFileSync(
        checkFixture,
        fs
          .readFileSync(headlessCheckPath, "utf8")
          .replaceAll("/usr/local/share/nemoclaw/dcode-proxy-host", hostFile)
          .replaceAll("/usr/local/share/nemoclaw/dcode-proxy-port", portFile)
          .replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnvFile)
          .replace('= "0:444"', `= "${runtimeUid}:444"`)
          .replace(
            'runtime_uid="$(id -u)" || contract_fail runtime-user; sandbox_uid="$(id -u sandbox)" || contract_fail runtime-user;',
            `runtime_uid=${runtimeUid}; sandbox_uid=${runtimeUid};`,
          ),
        "utf8",
      );
      fs.writeFileSync(
        proxyEnvFile,
        [
          `export HTTP_PROXY=${JSON.stringify(proxyUrl)}`,
          `export HTTPS_PROXY=${JSON.stringify(proxyUrl)}`,
          `export http_proxy=${JSON.stringify(lowerProxy)}`,
          `export https_proxy=${JSON.stringify(lowerProxy)}`,
          `export NO_PROXY=${JSON.stringify(noProxy)}`,
          `export no_proxy=${JSON.stringify(noProxy)}`,
          "unset ALL_PROXY all_proxy",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.chmodSync(proxyEnvFile, 0o444);
      fs.writeFileSync(
        path.join(loginHome, ".profile"),
        `export HOME=/sandbox\n. ${JSON.stringify(proxyEnvFile)}\n`,
        "utf8",
      );
      return runHeadlessCheckSnippet(
        [
          "sandbox_login_exec() {",
          "  case \"$1\" in *$'\\n'*|*$'\\r'*) return 97 ;; esac",
          '  env -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u no_proxy -u ALL_PROXY -u all_proxy HOME="$TEST_LOGIN_HOME" bash -lc "$1"',
          "}",
          "if sandbox_login_proxy_contract >/dev/null 2>&1; then printf pass; else printf fail; fi",
        ].join("\n"),
        { TEST_LOGIN_HOME: loginHome },
        checkFixture,
      );
    };

    const managedProxy = "http://10.200.0.1:3128";
    const managedNoProxy = "localhost,127.0.0.1,::1,10.200.0.1";
    expect(validate(managedProxy, managedNoProxy)).toBe("pass");
    expect(validate(managedProxy, `${managedNoProxy},inference.local`)).toBe("fail");
    expect(validate("http://corp-user:corp-password@proxy.example:8080", managedNoProxy)).toBe(
      "fail",
    );
    expect(validate(managedProxy, managedNoProxy, "http://other-proxy.example:3128")).toBe("fail");
  });
});
