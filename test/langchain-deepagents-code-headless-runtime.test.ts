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
  it("requires bare connect to resolve the expected registry default (#7034)", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-default-"));
    const cliFixture = path.join(fixtureDir, "nemoclaw");
    const callLog = path.join(fixtureDir, "calls.log");

    try {
      fs.writeFileSync(
        cliFixture,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          '[ "${SANDBOX_NAME+x}" != x ]',
          '[ "${NEMOCLAW_SANDBOX_NAME+x}" != x ]',
          '[ "${NEMOCLAW_SANDBOX+x}" != x ]',
          'printf "%s\\n" "$*" >>"$TEST_CALL_LOG"',
          'if [ "$#" -eq 2 ] && [ "$1" = list ] && [ "$2" = --json ]; then',
          '  [ "$TEST_LIST_EXIT" = 0 ] || exit "$TEST_LIST_EXIT"',
          '  printf "%s\\n" "$TEST_LIST_JSON"',
          "  exit 0",
          "fi",
          'if [ "$#" -eq 2 ] && [ "$1" = connect ] && [ "$2" = --probe-only ]; then',
          '  printf "  Probe complete: LangChain Deep Agents Code terminal smoke checks passed in \'%s\' (dcode).\\n" "$TEST_CONNECT_SANDBOX"',
          '  [ "$TEST_CONNECT_EXIT" = 0 ] || exit "$TEST_CONNECT_EXIT"',
          "  exit 0",
          "fi",
          "exit 64",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.chmodSync(cliFixture, 0o755);

      const runGuardedProbe = (
        inventoryJson: string,
        listExit = 0,
        connectExit = 0,
        connectSandbox = "dcode-managed",
      ) => {
        fs.writeFileSync(callLog, "", "utf8");
        const output = runHeadlessCheckSnippet(
          [
            'if output="$(guarded_bare_connect_probe 2>&1)"; then',
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
            SANDBOX_NAME: "dcode-managed",
            TEST_CALL_LOG: callLog,
            TEST_CONNECT_EXIT: String(connectExit),
            TEST_CONNECT_SANDBOX: connectSandbox,
            TEST_LIST_EXIT: String(listExit),
            TEST_LIST_JSON: inventoryJson,
          },
        );
        const callText = fs.readFileSync(callLog, "utf8").trim();
        return { calls: callText ? callText.split("\n") : [], output };
      };

      const matchingInventory = JSON.stringify({
        defaultSandbox: "dcode-managed",
        readyDefaultSandbox: "dcode-managed",
        sandboxes: [],
      });
      expect(runGuardedProbe(matchingInventory)).toEqual({
        calls: ["list --json", "connect --probe-only"],
        output:
          "pass:NEMOCLAW_DCODE_DEFAULT_SANDBOX_OK\n  Probe complete: LangChain Deep Agents Code terminal smoke checks passed in 'dcode-managed' (dcode).",
      });
      expect(runGuardedProbe(matchingInventory, 0, 0, "another-sandbox")).toEqual({
        calls: ["list --json", "connect --probe-only"],
        output:
          "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_OK\n  Probe complete: LangChain Deep Agents Code terminal smoke checks passed in 'another-sandbox' (dcode).\nNEMOCLAW_DCODE_CONNECT_FAIL:sandbox-mismatch",
      });
      expect(
        runGuardedProbe(
          JSON.stringify({
            defaultSandbox: "another-sandbox",
            readyDefaultSandbox: "dcode-managed",
            sandboxes: [],
          }),
        ),
      ).toEqual({
        calls: ["list --json"],
        output: "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_FAIL:display-mismatch",
      });
      expect(
        runGuardedProbe(
          JSON.stringify({
            defaultSandbox: "dcode-managed",
            readyDefaultSandbox: "another-sandbox",
            sandboxes: [],
          }),
        ),
      ).toEqual({
        calls: ["list --json"],
        output: "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_FAIL:ready-mismatch",
      });
      expect(
        runGuardedProbe(
          JSON.stringify({ defaultSandbox: "dcode-managed", readyDefaultSandbox: null }),
        ),
      ).toEqual({
        calls: ["list --json"],
        output: "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_FAIL:missing",
      });
      expect(runGuardedProbe("not-json")).toEqual({
        calls: ["list --json"],
        output: "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_FAIL:unparseable",
      });
      expect(runGuardedProbe(matchingInventory, 71)).toEqual({
        calls: ["list --json"],
        output: "fail:1:NEMOCLAW_DCODE_DEFAULT_SANDBOX_FAIL:list-command",
      });
      expect(runGuardedProbe(matchingInventory, 0, 72)).toEqual({
        calls: ["list --json", "connect --probe-only"],
        output:
          "fail:72:NEMOCLAW_DCODE_DEFAULT_SANDBOX_OK\n  Probe complete: LangChain Deep Agents Code terminal smoke checks passed in 'dcode-managed' (dcode).",
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
