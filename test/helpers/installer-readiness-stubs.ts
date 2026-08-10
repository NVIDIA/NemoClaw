// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function writeInstallerReadinessModuleStubs(readinessDir: string): void {
  fs.mkdirSync(readinessDir, { recursive: true });
  fs.writeFileSync(
    `${readinessDir}/host.js`,
    `exports.createHostReadinessReport = (_options, collection) => ({ host: collection.assess() });\n`,
  );
  fs.writeFileSync(
    `${readinessDir}/onboard-admission.js`,
    `exports.evaluateOnboardReadinessAdmission = (report) => {
  const host = report.host;
  const unsupportedRuntime = host.runtime === "podman" || host.isUnsupportedRuntime === true;
  const cdiBlocks = host.cdiNvidiaGpuSpecNeedsRepair && !(host.isWsl && host.runtime === "docker-desktop");
  return { admitted: !unsupportedRuntime && !cdiBlocks };
};
`,
  );
}
