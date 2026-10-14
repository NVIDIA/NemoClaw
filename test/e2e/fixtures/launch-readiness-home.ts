// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import {
  launchReadinessReceiptPath,
  readLaunchReadinessLease,
} from "../../../src/lib/state/launch-readiness-lease.ts";

/** Exercise cloud-image home permissions only when the caller owns the disposable CI host. */
export async function withGroupWritableReadinessHome(
  input: { enabled: boolean; sandboxName: string; gatewayName: string; gatewayPort: number },
  launch: () => Promise<void>,
): Promise<void> {
  if (!input.enabled) return launch();

  const home = os.userInfo().homedir;
  const descriptor = fs.openSync(
    home,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let originalMode: number | undefined;
  const originalUmask = process.umask();
  try {
    originalMode = fs.fstatSync(descriptor).mode & 0o7777;
    fs.fchmodSync(descriptor, 0o775);
    process.umask(0o002);
    fs.rmSync(launchReadinessReceiptPath(input.sandboxName, input.gatewayPort, home), {
      force: true,
    });
    console.log(
      `Launch-readiness home qualification: mode=${(fs.fstatSync(descriptor).mode & 0o777).toString(8)} umask=${process.umask().toString(8)} receipt=absent`,
    );
    await launch();
    const lease = readLaunchReadinessLease(input.sandboxName, input.gatewayName, input.gatewayPort);
    console.log(
      `Launch-readiness home qualification: mode=${(fs.fstatSync(descriptor).mode & 0o777).toString(8)} lease=${lease.kind} sessions=2`,
    );
    if (lease.kind !== "valid") {
      throw new Error(`Launch readiness did not qualify: ${lease.kind}`);
    }
  } finally {
    process.umask(originalUmask);
    try {
      if (originalMode !== undefined) fs.fchmodSync(descriptor, originalMode);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}
