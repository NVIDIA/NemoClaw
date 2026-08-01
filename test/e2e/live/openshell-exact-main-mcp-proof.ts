// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import { prepareExactMainDriverConfigProof } from "./openshell-exact-main-driver-config.ts";
import { assertExactMainOpenShellContracts } from "./openshell-exact-main-exec.ts";
import {
  assertExactMainMcpLogPrivacy,
  assertExactMainPolicyNftAndIdentityContracts,
} from "./openshell-exact-main-runtime-contracts.ts";

const DCODE_MCP_SNAPSHOT_TMPFS = "/run/nemoclaw-dcode-mcp";

async function assertDcodeMcpSnapshotPlatformContract(
  sandbox: SandboxClient,
  sandboxName: string,
  phase: string,
): Promise<void> {
  const script = trustedSandboxShellScript(`set -eu
python3 -I - <<'PY'
import errno
import fcntl
import os
import stat
from pathlib import Path

from deepagents_code import _nemoclaw_managed as managed

try:
    os.memfd_create("nemoclaw-dcode-mcp-proof", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
except PermissionError as exc:
    assert exc.errno == errno.EPERM
else:
    raise AssertionError("OpenShell did not block memfd_create")

payload = b'{"mcpServers":{"proof":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer openshell:resolve:env:PROOF_TOKEN"}}}}' + bytes([10])
real_open = managed.os.open
opened_directories = []

def reject_primary_tmpfile(path, flags, *args, **kwargs):
    if flags & os.O_TMPFILE:
        directory = Path(path)
        opened_directories.append(directory)
        if directory == managed._MCP_ANONYMOUS_DIRECTORY:
            raise OSError(errno.EOPNOTSUPP, "O_TMPFILE unavailable for primary snapshot directory")
    return real_open(path, flags, *args, **kwargs)

managed.os.open = reject_primary_tmpfile
try:
    descriptor, binding = managed._managed_mcp_snapshot(payload)
finally:
    managed.os.open = real_open

assert opened_directories == [
    managed._MCP_ANONYMOUS_DIRECTORY,
    managed._MCP_PRIVATE_ANONYMOUS_DIRECTORY,
]
snapshot_path = f"/proc/self/fd/{descriptor}"
try:
    metadata = os.fstat(descriptor)
    assert binding["kind"] == managed._MCP_ANONYMOUS_KIND
    assert metadata.st_nlink == 0
    assert stat.S_IMODE(metadata.st_mode) == 0
    assert fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY
    assert managed._read_bound_managed_mcp_descriptor(descriptor, binding) == payload

    os.fchmod(descriptor, 0o600)
    writer = os.open(snapshot_path, os.O_RDWR | os.O_CLOEXEC)
    try:
        os.pwrite(writer, b"!" + payload[1:], 0)
    finally:
        os.close(writer)
    os.fchmod(descriptor, 0)
    try:
        managed._read_bound_managed_mcp_descriptor(descriptor, binding)
    except RuntimeError as exc:
        assert "contents changed" in str(exc)
    else:
        raise AssertionError("same-size anonymous snapshot tampering was accepted")
finally:
    os.close(descriptor)

assert list(Path("${DCODE_MCP_SNAPSHOT_TMPFS}").iterdir()) == []
print("dcode-mcp-snapshot-platform-contract-ok")
PY`);
  const result = await sandbox.execShell(sandboxName, script, {
    artifactName: `exact-main-dcode-mcp-snapshot-${phase}`,
    env: sandboxAccessEnv(),
    timeoutMs: 60_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).toContain("dcode-mcp-snapshot-platform-contract-ok");
}

async function assertDcodeMcpSnapshotResidue(
  sandbox: SandboxClient,
  sandboxName: string,
  phase: string,
): Promise<void> {
  const script = trustedSandboxShellScript(
    `test -z "$(find ${DCODE_MCP_SNAPSHOT_TMPFS} -mindepth 1 -maxdepth 1 -print -quit)"`,
  );
  const result = await sandbox.execShell(sandboxName, script, {
    artifactName: `exact-main-dcode-mcp-snapshot-residue-${phase}`,
    env: sandboxAccessEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
}

export function prepareExactMainMcpProof(
  fixture: {
    artifacts: ArtifactSink;
    cleanup: CleanupRegistry;
    host: HostCliClient;
    lifecycle: LifecyclePhaseFixture;
    sandbox: SandboxClient;
  },
  sandboxName: string,
  mcpUrl: string,
) {
  const { artifacts, cleanup, host, sandbox } = fixture;
  const driverConfig = prepareExactMainDriverConfigProof(fixture, sandboxName);
  return {
    envOverlay: driverConfig.envOverlay,
    async afterOnboard(): Promise<void> {
      await driverConfig.assertAfterOnboard();
      if (driverConfig.active) {
        await assertDcodeMcpSnapshotPlatformContract(sandbox, sandboxName, "after-onboard");
      }
      await assertExactMainOpenShellContracts(host, sandboxName);
      await assertExactMainPolicyNftAndIdentityContracts({
        artifacts,
        cleanup,
        host,
        mcpUrl,
        sandbox,
        sandboxName,
      });
    },
    async afterRebuild(): Promise<void> {
      await driverConfig.assertAfterRebuild();
      if (driverConfig.active) {
        await assertDcodeMcpSnapshotPlatformContract(sandbox, sandboxName, "after-rebuild");
      }
    },
    async assertSnapshotResidue(phase: string): Promise<void> {
      if (driverConfig.active) {
        await assertDcodeMcpSnapshotResidue(sandbox, sandboxName, phase);
      }
    },
    async assertLogPrivacy(argumentCanaries: string[], expectedTool: string): Promise<void> {
      await assertExactMainMcpLogPrivacy({
        argumentCanaries,
        artifacts,
        expectedTool,
        sandbox,
        sandboxName,
      });
    },
  };
}
