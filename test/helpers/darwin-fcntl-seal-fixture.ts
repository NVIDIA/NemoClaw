// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DARWIN_FCNTL_FIXTURE_MARKER = "# NemoClaw test-only Darwin fcntl seal constants.";

export function addDarwinFcntlSealConstants(
  helper: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const shouldPatch = platform === "darwin" && !helper.includes(DARWIN_FCNTL_FIXTURE_MARKER);
  const patched = helper.replace(
    "import fcntl\n",
    `import fcntl

${DARWIN_FCNTL_FIXTURE_MARKER}
for _name, _value in (
    ("F_ADD_SEALS", 1033),
    ("F_GET_SEALS", 1034),
    ("F_SEAL_SEAL", 0x0001),
    ("F_SEAL_SHRINK", 0x0002),
    ("F_SEAL_GROW", 0x0004),
    ("F_SEAL_WRITE", 0x0008),
):
    if not hasattr(fcntl, _name):
        setattr(fcntl, _name, _value)
`,
  );
  if (shouldPatch && patched === helper) {
    throw new Error("Darwin fcntl seal shim injection point not found in helper module");
  }
  return shouldPatch ? patched : helper;
}
