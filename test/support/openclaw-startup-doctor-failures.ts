// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function seedRetiredAdmissionFailure(packageRoot: string, failure: string): void {
  const admission = path.join(packageRoot, "dist", "doctor-retired-state-admission-test.mjs");
  if (failure === "missing admission module") {
    fs.unlinkSync(admission);
  } else if (failure === "ambiguous admission module") {
    fs.copyFileSync(admission, admission.replace("-test.mjs", "-duplicate.mjs"));
  } else if (failure === "missing admission export") {
    fs.writeFileSync(admission, "export const unrelated = () => {};\n");
  } else if (failure === "invalid admission export") {
    fs.writeFileSync(
      admission,
      "const assertDoctorRetiredStateAdmission = null;\nexport { assertDoctorRetiredStateAdmission };\n",
    );
  } else if (failure === "retired source rejection") {
    fs.writeFileSync(
      admission,
      'function assertDoctorRetiredStateAdmission() { throw new Error("retired source requires prior Doctor migration"); }\nexport { assertDoctorRetiredStateAdmission };\n',
    );
  } else {
    throw new Error(`Unknown admission fixture: ${failure}`);
  }
}

export function seedRepairOrLeaseFailure(packageRoot: string, failure: string): void {
  const schema = path.join(packageRoot, "dist", "openclaw-state-db-test.mjs");
  const lease = path.join(packageRoot, "dist", "startup-migration-checkpoint-test.mjs");
  const repairStatements: Record<string, string> = {
    "async repair rejection": 'throw new Error("repair refused");',
    "repair warning": 'return { changes: [], warnings: ["repair incomplete"] };',
    "invalid repair result": "return undefined;",
  };
  if (Object.hasOwn(repairStatements, failure)) {
    fs.writeFileSync(
      schema,
      fs
        .readFileSync(schema, "utf8")
        .replace('return { changes: ["migrated"], warnings: [] };', repairStatements[failure]),
    );
  } else if (failure === "missing lease export") {
    fs.writeFileSync(lease, "export const unrelated = () => false;\n");
  } else if (failure === "invalid lease result") {
    fs.writeFileSync(
      lease,
      "function hasActiveStartupMigrationLease() { return null; }\nexport { hasActiveStartupMigrationLease as i };\n",
    );
  } else {
    throw new Error(`Unknown repair fixture: ${failure}`);
  }
}

export function seedNativeRetiredAdmission(
  packageRoot: string,
  moduleExtension: string,
  native105: boolean,
): void {
  if (native105) {
    fs.writeFileSync(
      path.join(packageRoot, "dist", `doctor-retired-state-admission-test.${moduleExtension}`),
      [
        'import fs from "node:fs";',
        'function assertDoctorRetiredStateAdmission() { fs.appendFileSync(new URL("../schema-repair-calls", import.meta.url), "admission\\n"); }',
        "export { assertDoctorRetiredStateAdmission };",
        "",
      ].join("\n"),
    );
  }
}
