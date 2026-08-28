// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sshArgs } from "../../src/lib/state/sandbox";

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-ssh-host-"));

function writeSshConfig(name: string, contents: string): string {
  const configFile = path.join(TEMP_ROOT, name);
  fs.writeFileSync(configFile, contents, { mode: 0o600 });
  return configFile;
}

afterAll(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("snapshot SSH host selection", () => {
  it("uses the unqualified alias declared by OpenShell v0.0.85 (#8497)", () => {
    const configFile = writeSshConfig(
      "legacy-ssh-config",
      "Host openshell-alpha\n  HostName 127.0.0.1\n",
    );

    expect(sshArgs(configFile, "alpha").at(-1)).toBe("openshell-alpha");
  });

  it("uses the workspace-qualified alias declared by OpenShell v0.0.99 (#8497)", () => {
    const configFile = writeSshConfig(
      "current-ssh-config",
      "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
    );

    expect(sshArgs(configFile, "alpha").at(-1)).toBe("openshell-alpha.default");
  });

  it.each([
    ["wildcard", "Host openshell-*\n  HostName 127.0.0.1\n"],
    ["unrelated", "Host openshell-other.default\n  HostName 127.0.0.1\n"],
  ])("rejects a %s SSH config without an exact sandbox alias (#8497)", (name, contents) => {
    const configFile = writeSshConfig(`${name}-ssh-config`, contents);

    expect(() => sshArgs(configFile, "alpha")).toThrow(
      "OpenShell SSH config does not declare an exact host alias for sandbox 'alpha'",
    );
  });
});
