// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pi's supported credential-command resolver reads this at request time.
// Never return raw credentials or fabricate an unversioned OpenShell handle.
const allowedKeys = new Set([
  "NVIDIA_INFERENCE_API_KEY",
  "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
]);
const key = process.argv[2] ?? "";
const value = process.env[key] ?? "";
if (
  process.argv.length !== 3 ||
  !allowedKeys.has(key) ||
  !new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}|s[0-9a-f]{64})_${key}$`).test(value) ||
  /[\r\n]/u.test(value)
) {
  console.error("Native inference requires an issued OpenShell credential handle");
  process.exit(1);
}
process.stdout.write(value);

export {};
