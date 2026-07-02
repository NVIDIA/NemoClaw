// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const headlessCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "07-deepagents-code-headless-inference.sh",
);

type RuntimeEnvTrustCase = "valid" | "symlink" | "writable" | "wrong-user" | "root-user";

function runHeadlessCheckHelper(
  snippet: string,
  env: NodeJS.ProcessEnv,
  sourcePath: string,
): string {
  return execFileSync("bash", ["-c", `source "$1"; ${snippet}`, "bash", sourcePath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function validateLoginProxyContract(
  proxyUrl: string,
  noProxy: string,
  lowerProxy = proxyUrl,
  runtimeEnvTrust: RuntimeEnvTrustCase = "valid",
): string {
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-login-"));
  const hostFile = path.join(loginHome, "trusted-proxy-host");
  const portFile = path.join(loginHome, "trusted-proxy-port");
  const runtimeEnvFile = path.join(loginHome, "proxy-env.sh");
  const checkFixture = path.join(loginHome, "headless-check.sh");
  fs.writeFileSync(hostFile, "10.200.0.1\n", "utf8");
  fs.writeFileSync(portFile, "3128\n", "utf8");
  fs.chmodSync(hostFile, 0o444);
  fs.chmodSync(portFile, 0o444);
  switch (runtimeEnvTrust) {
    case "symlink": {
      const runtimeEnvTarget = path.join(loginHome, "proxy-env-target.sh");
      fs.writeFileSync(runtimeEnvTarget, "export HOME=/sandbox\n", "utf8");
      fs.chmodSync(runtimeEnvTarget, 0o444);
      fs.symlinkSync(runtimeEnvTarget, runtimeEnvFile);
      break;
    }
    default:
      fs.writeFileSync(runtimeEnvFile, "export HOME=/sandbox\n", "utf8");
      fs.chmodSync(runtimeEnvFile, runtimeEnvTrust === "writable" ? 0o644 : 0o444);
  }
  let checkSource = fs
    .readFileSync(headlessCheckPath, "utf8")
    .replaceAll("/usr/local/share/nemoclaw/dcode-proxy-host", hostFile)
    .replaceAll("/usr/local/share/nemoclaw/dcode-proxy-port", portFile)
    .replaceAll("/tmp/nemoclaw-proxy-env.sh", runtimeEnvFile)
    .replace('= "0:444"', `= "${process.getuid?.() ?? 0}:444"`)
    .replace('sandbox_uid="$(id -u sandbox)"', 'sandbox_uid="$(id -u)"');
  switch (runtimeEnvTrust) {
    case "wrong-user":
      checkSource = checkSource.replace('sandbox_uid="$(id -u)"', "sandbox_uid=99999");
      break;
    case "root-user":
      checkSource = checkSource
        .replace('runtime_uid="$(id -u)"', "runtime_uid=0")
        .replace('sandbox_uid="$(id -u)"', "sandbox_uid=0");
      break;
  }
  fs.writeFileSync(checkFixture, checkSource, "utf8");
  fs.writeFileSync(
    path.join(loginHome, ".profile"),
    [
      "export HOME=/sandbox",
      `export HTTP_PROXY=${JSON.stringify(proxyUrl)}`,
      `export HTTPS_PROXY=${JSON.stringify(proxyUrl)}`,
      `export http_proxy=${JSON.stringify(lowerProxy)}`,
      `export https_proxy=${JSON.stringify(lowerProxy)}`,
      `export NO_PROXY=${JSON.stringify(noProxy)}`,
      `export no_proxy=${JSON.stringify(noProxy)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return runHeadlessCheckHelper(
    [
      "sandbox_login_exec() {",
      "  case \"$1\" in *$'\\n'*|*$'\\r'*) return 97 ;; esac",
      '  env -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u no_proxy HOME="$TEST_LOGIN_HOME" bash -lc "$1"',
      "}",
      "if sandbox_login_proxy_contract >/dev/null 2>&1; then printf pass; else printf fail; fi",
    ].join("\n"),
    { TEST_LOGIN_HOME: loginHome },
    checkFixture,
  );
}

describe("Deep Agents Code login-shell proxy contract", () => {
  it("accepts only normalized proxy values and a trusted non-root runtime file (#6191)", () => {
    const managedProxy = "http://10.200.0.1:3128";
    const managedNoProxy = "localhost,127.0.0.1,::1,10.200.0.1";
    expect(validateLoginProxyContract(managedProxy, managedNoProxy)).toBe("pass");
    for (const runtimeEnvTrust of ["symlink", "writable", "wrong-user", "root-user"] as const) {
      expect(
        validateLoginProxyContract(managedProxy, managedNoProxy, managedProxy, runtimeEnvTrust),
      ).toBe("fail");
    }
    expect(validateLoginProxyContract(managedProxy, `${managedNoProxy},inference.local`)).toBe(
      "fail",
    );
    expect(
      validateLoginProxyContract(
        "http://corp-user:corp-password@proxy.example:8080",
        managedNoProxy,
      ),
    ).toBe("fail");
    expect(
      validateLoginProxyContract(managedProxy, managedNoProxy, "http://other-proxy.example:3128"),
    ).toBe("fail");
  });
});
