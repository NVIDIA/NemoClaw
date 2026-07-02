// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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

type RuntimeEnvMetadataCase =
  | "valid"
  | "symlink"
  | "writable"
  | "wrong-user"
  | "wrong-owner"
  | "root-user";

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

function mustReplace(source: string, search: string, replacement: string): string {
  assert.ok(source.includes(search), `headless proxy fixture is missing ${JSON.stringify(search)}`);
  return source.replaceAll(search, replacement);
}

function validateLoginProxyContract(
  proxyUrl: string,
  noProxy: string,
  lowerProxy = proxyUrl,
  runtimeEnvMetadata: RuntimeEnvMetadataCase = "valid",
  allProxy: string | null = null,
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
  const runtimeEnvText = [
    "export HOME=/sandbox",
    `export HTTP_PROXY=${JSON.stringify(proxyUrl)}`,
    `export HTTPS_PROXY=${JSON.stringify(proxyUrl)}`,
    `export http_proxy=${JSON.stringify(lowerProxy)}`,
    `export https_proxy=${JSON.stringify(lowerProxy)}`,
    `export NO_PROXY=${JSON.stringify(noProxy)}`,
    `export no_proxy=${JSON.stringify(noProxy)}`,
    ...(allProxy === null
      ? ["unset ALL_PROXY all_proxy"]
      : [
          `export ALL_PROXY=${JSON.stringify(allProxy)}`,
          `export all_proxy=${JSON.stringify(allProxy)}`,
        ]),
    "",
  ].join("\n");
  switch (runtimeEnvMetadata) {
    case "symlink": {
      const runtimeEnvTarget = path.join(loginHome, "proxy-env-target.sh");
      fs.writeFileSync(runtimeEnvTarget, runtimeEnvText, "utf8");
      fs.chmodSync(runtimeEnvTarget, 0o444);
      fs.symlinkSync(runtimeEnvTarget, runtimeEnvFile);
      break;
    }
    default:
      fs.writeFileSync(runtimeEnvFile, runtimeEnvText, "utf8");
      fs.chmodSync(runtimeEnvFile, runtimeEnvMetadata === "writable" ? 0o644 : 0o444);
  }
  let checkSource = fs.readFileSync(headlessCheckPath, "utf8");
  checkSource = mustReplace(checkSource, "/usr/local/share/nemoclaw/dcode-proxy-host", hostFile);
  checkSource = mustReplace(checkSource, "/usr/local/share/nemoclaw/dcode-proxy-port", portFile);
  checkSource = mustReplace(checkSource, "/tmp/nemoclaw-proxy-env.sh", runtimeEnvFile);
  checkSource = mustReplace(checkSource, '= "0:444"', `= "${process.getuid?.() ?? 0}:444"`);
  checkSource = mustReplace(
    checkSource,
    'sandbox_uid="$(id -u sandbox)"',
    'sandbox_uid="$(id -u)"',
  );
  switch (runtimeEnvMetadata) {
    case "wrong-user":
      checkSource = mustReplace(checkSource, 'sandbox_uid="$(id -u)"', "sandbox_uid=99999");
      break;
    case "wrong-owner":
      checkSource = mustReplace(checkSource, 'runtime_uid="$(id -u)"', "runtime_uid=99999");
      checkSource = mustReplace(checkSource, 'sandbox_uid="$(id -u)"', "sandbox_uid=99999");
      break;
    case "root-user":
      checkSource = mustReplace(checkSource, 'runtime_uid="$(id -u)"', "runtime_uid=0");
      checkSource = mustReplace(checkSource, 'sandbox_uid="$(id -u)"', "sandbox_uid=0");
      break;
  }
  fs.writeFileSync(checkFixture, checkSource, "utf8");
  fs.writeFileSync(
    path.join(loginHome, ".profile"),
    ["export HOME=/sandbox", `. ${JSON.stringify(runtimeEnvFile)}`, ""].join("\n"),
    "utf8",
  );
  try {
    return runHeadlessCheckHelper(
      [
        "sandbox_login_exec() {",
        "  case \"$1\" in *$'\\n'*|*$'\\r'*) return 97 ;; esac",
        '  env -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u no_proxy -u ALL_PROXY -u all_proxy HOME="$TEST_LOGIN_HOME" bash -lc "$1"',
        "}",
        "if sandbox_login_proxy_contract >/dev/null 2>&1; then printf pass; else printf fail; fi",
      ].join("\n"),
      {
        TEST_LOGIN_HOME: loginHome,
        ALL_PROXY: "socks5://all-user:all-password@all-proxy.example:1080",
        all_proxy: "socks5://lower-all-user:lower-all-password@lower-all-proxy.example:1080",
      },
      checkFixture,
    );
  } finally {
    fs.rmSync(loginHome, { force: true, recursive: true });
  }
}

describe("Deep Agents Code login-shell proxy contract", () => {
  it("sources normalized proxy values and rejects runtime metadata drift (#6191)", () => {
    const managedProxy = "http://10.200.0.1:3128";
    const managedNoProxy = "localhost,127.0.0.1,::1,10.200.0.1";
    expect(validateLoginProxyContract(managedProxy, managedNoProxy)).toBe("pass");
    for (const runtimeEnvMetadata of [
      "symlink",
      "writable",
      "wrong-user",
      "wrong-owner",
      "root-user",
    ] as const) {
      expect(
        validateLoginProxyContract(managedProxy, managedNoProxy, managedProxy, runtimeEnvMetadata),
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
    expect(
      validateLoginProxyContract(
        "http://attacker-proxy.internal:9999",
        "localhost,127.0.0.1,::1,attacker-proxy.internal",
      ),
    ).toBe("fail");
    expect(
      validateLoginProxyContract(
        managedProxy,
        managedNoProxy,
        managedProxy,
        "valid",
        "socks5://all-user:all-password@all-proxy.example:1080",
      ),
    ).toBe("fail");
  });
});
