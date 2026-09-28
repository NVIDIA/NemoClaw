// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Read the running gateway, not the environment of an early CLI wrapper.
// No credential value is printed. Missing/unreadable process evidence fails.
export const BRAVE_PROCESS_BOUNDARY = String.raw`
import pathlib, sys
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/proc")
observed = 0
for process in root.glob("[0-9]*"):
    try:
        argv = process.joinpath("cmdline").read_bytes().split(b"\0")
    except (FileNotFoundError, ProcessLookupError):
        continue
    executable = pathlib.Path(argv[0].decode(errors="replace")).name
    gateway = executable.startswith("openclaw-gateway") or (
        executable in ("node", "openclaw", "openclaw.real") and
        any(b"openclaw" in arg for arg in argv) and b"gateway" in argv)
    if not gateway:
        continue
    observed += 1
    entries = process.joinpath("environ").read_bytes().split(b"\0")
    values = [entry.split(b"=", 1)[1] for entry in entries if entry.startswith(b"BRAVE_API_KEY=")]
    if any(value and not value.startswith(b"openshell:resolve:env:") for value in values):
        sys.exit(98)
sys.exit(0 if observed else 97)
`;

export const BRAVE_SHELL_BOUNDARY = String.raw`
value="$(printenv BRAVE_API_KEY 2>/dev/null || true)"
case "$value" in
  ''|openshell:resolve:env:*) exit 0 ;;
  *) exit 98 ;;
esac
`;
