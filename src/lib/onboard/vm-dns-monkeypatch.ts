// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  applyOpenShellVmDnsMonkeypatch,
  type VmDnsMonkeypatchResult,
} from "../actions/sandbox/vm-dns-monkeypatch";

type OnboardVmDnsMonkeypatchDeps = {
  apply?: typeof applyOpenShellVmDnsMonkeypatch;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export function applyOnboardVmDnsMonkeypatch(
  sandboxName: string,
  runtime: { openshellDriver?: string | null },
  deps: OnboardVmDnsMonkeypatchDeps = {},
): void {
  const apply = deps.apply ?? applyOpenShellVmDnsMonkeypatch;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  const vmDnsPatch: VmDnsMonkeypatchResult = apply(sandboxName, {
    openshellDriver: runtime.openshellDriver,
  });
  if (vmDnsPatch.ok && vmDnsPatch.changed) {
    log("  ✓ Applied OpenShell VM DNS monkeypatch");
  } else if (vmDnsPatch.ok && vmDnsPatch.attempted) {
    log("  OpenShell VM DNS monkeypatch already present");
  } else if (
    vmDnsPatch.status === "skipped" &&
    runtime.openshellDriver === "vm" &&
    vmDnsPatch.reason
  ) {
    log(`  OpenShell VM DNS monkeypatch skipped: ${vmDnsPatch.reason}`);
  } else if (vmDnsPatch.attempted && !vmDnsPatch.ok && vmDnsPatch.reason) {
    warn(`  Warning: OpenShell VM DNS monkeypatch did not apply: ${vmDnsPatch.reason}`);
  }
}
