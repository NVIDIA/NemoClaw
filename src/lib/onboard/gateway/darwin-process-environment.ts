// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// KERN_PROCARGS2 preserves NUL boundaries between arguments and environment values.
// Emit only ownership keys; other process credentials must not cross this boundary.
const READ_ENVIRONMENT = String.raw`
import ctypes, json, sys
try:
    pid = int(sys.argv[1])
    if not 0 < pid < 2147483648:
        raise ValueError()
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    capacity = 1048576
    size = ctypes.c_size_t(capacity)
    buffer = ctypes.create_string_buffer(capacity)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise ValueError()
    data = buffer.raw[:size.value]
    if len(data) < 5 or len(data) >= capacity:
        raise ValueError()
    argc = int.from_bytes(data[:4], sys.byteorder, signed=True)
    if argc < 1 or argc > len(data):
        raise ValueError()
    offset = data.index(b'\0', 4) + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    for _ in range(argc):
        offset = data.index(b'\0', offset) + 1
    environment = {}
    for entry in data[offset:].split(b'\0'):
        if not entry:
            continue
        key, separator, value = entry.partition(b'=')
        if key not in (b'OPENSHELL_DB_URL', b'NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE'):
            continue
        if not separator or key.decode() in environment:
            raise ValueError()
        environment[key.decode()] = value.decode('utf-8', errors='strict')
    print(json.dumps(environment or None))
except Exception:
    print('null')
`;

export function readDarwinGatewayProcessEnvironment(
  pid: number,
  capture: (
    args: readonly string[],
    options: { timeout: number; maxBuffer: number },
  ) => {
    stdout: string;
    exitCode: number | null;
    timedOut: boolean;
  },
): Record<string, string> | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  try {
    const result = capture(["/usr/bin/python3", "-I", "-c", READ_ENVIRONMENT, String(pid)], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    if (result.timedOut || result.exitCode !== 0) return null;
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (
      entries.length === 0 ||
      entries.some(
        ([key, entry]) =>
          !["OPENSHELL_DB_URL", "NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE"].includes(key) ||
          typeof entry !== "string",
      )
    )
      return null;
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}
