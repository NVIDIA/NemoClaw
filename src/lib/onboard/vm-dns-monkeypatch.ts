// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { applyOpenShellVmDnsMonkeypatch } from "../actions/sandbox/vm-dns-monkeypatch";

export function applyOnboardVmDnsMonkeypatch(
  sandboxName: string,
  runtime: { openshellDriver?: string | null },
): void {
  const vmDnsPatch = applyOpenShellVmDnsMonkeypatch(sandboxName, {
    openshellDriver: runtime.openshellDriver,
  });
  if (vmDnsPatch.ok && vmDnsPatch.changed) {
    console.log("  ✓ Applied OpenShell VM DNS monkeypatch");
  } else if (vmDnsPatch.attempted && !vmDnsPatch.ok && vmDnsPatch.reason) {
    console.error(`  Warning: OpenShell VM DNS monkeypatch did not apply: ${vmDnsPatch.reason}`);
  }
}
