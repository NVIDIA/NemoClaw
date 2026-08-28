// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MANAGED_STARTUP_AGENTS } from "../../../src/lib/onboard/managed-startup/profile";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENTRYPOINT_SOURCE = path.join(ROOT, "scripts", "managed-bootstrap-entrypoint.c");
const TRAMPOLINE = path.join(ROOT, "scripts", "managed-bootstrap-trampoline.sh");
const MAX_ENVIRONMENT_ENTRIES = 1024;
const MAX_ENVIRONMENT_ENTRY_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_BYTES = 512 * 1024;

function executable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

function compileEntrypoint(directory: string, body: string): string {
  const entrypoint = path.join(directory, "nemoclaw-managed-bootstrap");
  const result = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-DNEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING=1",
      "-ffreestanding",
      "-fno-asynchronous-unwind-tables",
      "-fno-builtin",
      "-fno-ident",
      "-fno-pie",
      "-fno-stack-protector",
      "-fno-unwind-tables",
      "-no-pie",
      "-nostdlib",
      "-static",
      "-Wl,--build-id=none",
      "-Wl,-z,noexecstack",
      `-DNEMOCLAW_MANAGED_BOOTSTRAP_BODY=${JSON.stringify(body)}`,
      `-DNEMOCLAW_MANAGED_BOOTSTRAP_SELF=${JSON.stringify(entrypoint)}`,
      ENTRYPOINT_SOURCE,
      "-o",
      entrypoint,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return entrypoint;
}

function compileExactEnvironmentLauncher(directory: string, entries: string[]): string {
  const source = path.join(directory, "exact-environment-launcher.c");
  const launcher = path.join(directory, "exact-environment-launcher");
  fs.writeFileSync(
    source,
    `#include <stdio.h>\n#include <unistd.h>\nstatic char *const exact_environment[] = {${entries
      .map((entry) => JSON.stringify(entry))
      .join(
        ",",
      )}, NULL};\nint main(int argc, char **argv) { if (argc < 2) return 2; execve(argv[1], &argv[1], exact_environment); perror("execve"); return 126; }\n`,
  );
  const result = spawnSync(
    "cc",
    ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", launcher],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return launcher;
}

function writePassThroughBody(directory: string): string {
  const body = path.join(directory, "pass-through-body.sh");
  fs.writeFileSync(
    body,
    `set -euo pipefail
[ "$1" = "--nemoclaw-supervisor-environment" ]
[ "$2" = "9" ]
count="$3"
bytes="$4"
[ "$5" = "--" ]
shift 5
exec /usr/bin/env -i NEMOCLAW_MANAGED_BOOTSTRAP_RESUME=1 ${JSON.stringify(
      path.join(directory, "nemoclaw-managed-bootstrap"),
    )} --nemoclaw-resume-supervisor 9 "$count" "$bytes" -- "$@"
`,
    { mode: 0o644 },
  );
  return body;
}

function environmentWithEntryCount(count: number): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `ENTRY_${index.toString().padStart(4, "0")}`,
      "x",
    ]),
  );
}

function environmentWithEntryLength(length: number): NodeJS.ProcessEnv {
  const prefix = "BOUNDARY=";
  return { BOUNDARY: "x".repeat(length - prefix.length) };
}

function environmentWithSerializedBytes(byteCount: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  let remaining = byteCount;
  let index = 0;
  while (remaining > 0) {
    const name = `BYTES_${index.toString().padStart(4, "0")}`;
    const assignmentOverhead = name.length + 2; // '=' plus the terminating NUL.
    const serializedLength = Math.min(60_000, remaining);
    environment[name] = "x".repeat(serializedLength - assignmentOverhead);
    remaining -= serializedLength;
    index += 1;
  }
  return environment;
}

function compileResumeTransportLauncher(directory: string): string {
  const source = path.join(directory, "resume-transport-launcher.c");
  const launcher = path.join(directory, "resume-transport-launcher");
  fs.writeFileSync(
    source,
    `#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int install_transport(const char *mode) {
  static const char valid[] = {'A', '=', '1', '\\0'};
  static const char truncated[] = {'A', '=', '1'};
  static const char extra[] = {'A', '=', '1', '\\0', 'B', '=', '2', '\\0'};
  if (strcmp(mode, "missing") == 0) {
    (void)close(9);
    return 0;
  }
  int descriptor;
  if (strcmp(mode, "substituted") == 0) {
    descriptor = open("/dev/null", O_RDONLY);
  } else {
    descriptor = memfd_create("nemoclaw-test-environment", MFD_ALLOW_SEALING);
    if (descriptor >= 0) {
      const char *payload = valid;
      size_t payload_bytes = sizeof(valid);
      if (strcmp(mode, "truncated") == 0) {
        payload = truncated;
        payload_bytes = sizeof(truncated);
      } else if (strcmp(mode, "extra") == 0) {
        payload = extra;
        payload_bytes = sizeof(extra);
      } else if (strcmp(mode, "valid") != 0 && strcmp(mode, "unsealed") != 0) {
        return -1;
      }
      if (write(descriptor, payload, payload_bytes) != (ssize_t)payload_bytes) return -1;
      if (strcmp(mode, "unsealed") != 0 &&
          fcntl(descriptor, F_ADD_SEALS,
                F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE) != 0) {
        return -1;
      }
    }
  }
  if (descriptor < 0) return -1;
  if (descriptor != 9) {
    if (dup3(descriptor, 9, 0) != 9) return -1;
    (void)close(descriptor);
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 6 || install_transport(argv[1]) != 0) return 2;
  char *const child_argv[] = {argv[2], "--nemoclaw-resume-supervisor", "9", argv[3],
                              argv[4], "--", argv[5], NULL};
  char *const child_environment[] = {"NEMOCLAW_MANAGED_BOOTSTRAP_RESUME=1", NULL};
  execve(argv[2], child_argv, child_environment);
  perror("execve");
  return 126;
}
`,
  );
  const result = spawnSync(
    "cc",
    ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", launcher],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return launcher;
}

function hostileLoader(
  directory: string,
  protectedRequest: string,
): { afterTrace: string; earlyTrace: string; library: string } {
  const source = path.join(directory, "hostile-loader.c");
  const library = path.join(directory, "hostile-loader.so");
  const earlyTrace = path.join(directory, "hostile-loader-ran-early");
  const afterTrace = path.join(directory, "hostile-loader-ran-after-validation");
  fs.writeFileSync(
    source,
    `#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void loaded(void) { const char *trace = access(${JSON.stringify(
      protectedRequest,
    )}, F_OK) == 0 ? ${JSON.stringify(earlyTrace)} : ${JSON.stringify(
      afterTrace,
    )}; int fd = open(trace, O_WRONLY | O_CREAT | O_APPEND, 0600); if (fd >= 0) { (void)write(fd, "loaded\\n", 7); (void)close(fd); } }\n`,
  );
  const result = spawnSync("cc", ["-shared", "-fPIC", source, "-o", library], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return { afterTrace, earlyTrace, library };
}

function compileEnvironmentReporter(directory: string): string {
  const source = path.join(directory, "environment-reporter.c");
  const reporter = path.join(directory, "environment-reporter");
  fs.writeFileSync(
    source,
    `#include <stddef.h>
#if defined(__x86_64__)
static long write_bytes(long descriptor, const char *bytes, size_t length) { register long result __asm__("rax") = 1L; register long first __asm__("rdi") = descriptor; register long second __asm__("rsi") = (long)bytes; register long third __asm__("rdx") = (long)length; __asm__ volatile("syscall" : "+r"(result) : "r"(first), "r"(second), "r"(third) : "rcx", "r11", "memory"); return result; }
__attribute__((noreturn)) static void exit_process(long code) { register long result __asm__("rax") = 231L; register long status __asm__("rdi") = code; __asm__ volatile("syscall" : "+r"(result) : "r"(status) : "rcx", "r11", "memory"); __builtin_unreachable(); }
__asm__(".global _start\\n.type _start,@function\\n_start:\\nmov %rsp,%rdi\\nandq $-16,%rsp\\ncall report_environment\\nud2\\n");
#elif defined(__aarch64__)
static long write_bytes(long descriptor, const char *bytes, size_t length) { register long result __asm__("x0") = descriptor; register long second __asm__("x1") = (long)bytes; register long third __asm__("x2") = (long)length; register long number __asm__("x8") = 64L; __asm__ volatile("svc 0" : "+r"(result) : "r"(second), "r"(third), "r"(number) : "memory"); return result; }
__attribute__((noreturn)) static void exit_process(long code) { register long result __asm__("x0") = code; register long number __asm__("x8") = 94L; __asm__ volatile("svc 0" : "+r"(result) : "r"(number) : "memory"); __builtin_unreachable(); }
__asm__(".global _start\\n.type _start,%function\\n_start:\\nmov x0,sp\\nmov x29,xzr\\nmov x30,xzr\\nbl report_environment\\nbrk #0\\n");
#else
#error unsupported architecture
#endif
static void write_all(const char *bytes, size_t length) { size_t offset = 0U; while (offset < length) { const long written = write_bytes(1L, bytes + offset, length - offset); if (written == -4L) continue; if (written <= 0L) exit_process(1L); offset += (size_t)written; } }
__attribute__((noreturn, used, visibility("hidden"))) void report_environment(size_t *stack) { const size_t argc = stack[0]; char **argv = (char **)&stack[1]; char **environment = &argv[argc + 1U]; for (size_t index = 0U; environment[index] != NULL; index += 1U) { size_t length = 0U; while (environment[index][length] != '\\0') length += 1U; write_all(environment[index], length); write_all("\\n", 1U); } exit_process(0L); }
`,
  );
  const result = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-ffreestanding",
      "-fno-asynchronous-unwind-tables",
      "-fno-builtin",
      "-fno-ident",
      "-fno-pie",
      "-fno-stack-protector",
      "-fno-unwind-tables",
      "-no-pie",
      "-nostdlib",
      "-static",
      "-Wl,--build-id=none",
      "-Wl,-z,noexecstack",
      source,
      "-o",
      reporter,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return reporter;
}

describe.skipIf(process.platform !== "linux")("managed bootstrap image trampoline", () => {
  it("keeps the Bash body non-executable and starts absolute Bash outside attacker PATH", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-path-"));
    try {
      const attackerTrace = path.join(directory, "attacker-trace");
      executable(
        path.join(directory, "bash"),
        `#!/bin/sh\nprintf 'attacker bash ran\\n' >${JSON.stringify(attackerTrace)}\n`,
      );
      const entrypoint = compileEntrypoint(directory, TRAMPOLINE);
      const result = spawnSync(entrypoint, [], {
        encoding: "utf8",
        env: { HOME: "/root", LANG: "C.UTF-8", PATH: directory },
      });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(attackerTrace)).toBe(false);
      const trampolineDescriptor = fs.openSync(TRAMPOLINE, "r");
      try {
        expect(fs.fstatSync(trampolineDescriptor).mode & 0o111).toBe(0);
        expect(fs.readFileSync(trampolineDescriptor, "utf8").startsWith("#!")).toBe(false);
      } finally {
        fs.closeSync(trampolineDescriptor);
      }
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "links the freestanding native boundary without runtime or loader dependencies",
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-static-"));
      try {
        const entrypoint = compileEntrypoint(directory, TRAMPOLINE);
        const programHeaders = spawnSync("readelf", ["-l", entrypoint], {
          encoding: "utf8",
        });
        expect(programHeaders.status, programHeaders.stderr).toBe(0);
        expect(programHeaders.stdout).not.toMatch(/\bINTERP\b/u);

        const dynamicSection = spawnSync("readelf", ["-d", entrypoint], {
          encoding: "utf8",
        });
        expect(dynamicSection.status, dynamicSection.stderr).toBe(0);
        expect(dynamicSection.stdout).toContain("There is no dynamic section");

        const undefinedSymbols = spawnSync("nm", ["--undefined-only", entrypoint], {
          encoding: "utf8",
        });
        expect(undefinedSymbols.status, undefinedSymbols.stderr).toBe(0);
        expect(undefinedSymbols.stdout).toBe("");
      } finally {
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it("removes inherited shell controls before the root Bash interpreter starts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-bash-env-"));
    try {
      const attackerTrace = path.join(directory, "attacker-trace");
      const attackerFunction = path.join(directory, "attacker-function-ran");
      const xtrace = path.join(directory, "xtrace-ran");
      const bashEnv = path.join(directory, "bash-env");
      const request = path.join(directory, "protected-request");
      fs.writeFileSync(request, "protected\n");
      fs.writeFileSync(
        bashEnv,
        `attacker\nprintf 'attacker startup ran\\n' >${JSON.stringify(attackerTrace)}\n`,
      );

      const entrypoint = compileEntrypoint(directory, TRAMPOLINE);
      const loader = hostileLoader(directory, request);
      const result = spawnSync(entrypoint, [], {
        encoding: "utf8",
        env: {
          BASH_ENV: bashEnv,
          "BASH_FUNC_attacker%%": `() { /usr/bin/touch ${attackerFunction}; }`,
          HOME: "/root",
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
          PS4: `$(/usr/bin/touch ${xtrace})`,
          SHELLOPTS: "xtrace",
          LD_AUDIT: loader.library,
          LD_LIBRARY_PATH: directory,
          LD_PRELOAD: loader.library,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Managed bootstrap trampoline");
      expect(fs.existsSync(attackerTrace)).toBe(false);
      expect(fs.existsSync(attackerFunction)).toBe(false);
      expect(fs.existsSync(xtrace)).toBe(false);
      expect(fs.existsSync(loader.earlyTrace)).toBe(false);
      expect(fs.existsSync(loader.afterTrace)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("restores the exact supervisor environment only through the fixed resume mode", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-resume-"));
    try {
      const reporter = compileEnvironmentReporter(directory);
      const exactEnvironment = [
        "LD_LIBRARY_PATH=/gpu/lib",
        "NVIDIA_VISIBLE_DEVICES=all",
        "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        "OLLAMA_HOST=http://host.containers.internal:11434",
        "NIM_HOST=http://host.containers.internal:8000",
        "NEMOCLAW_VLLM_PORT=18000",
        "GLIBC_TUNABLES=glibc.malloc.check=3",
        "DUPLICATE=first",
        "DUPLICATE=second",
        "PS4=$(touch /must-not-run)",
        "SECRET_SENTINEL=must-not-appear-in-bootstrap-argv",
        "SHELLOPTS=xtrace",
      ];
      const body = path.join(directory, "transport-body.sh");
      fs.writeFileSync(
        body,
        `set -euo pipefail
[ "$1" = "--nemoclaw-supervisor-environment" ]
[ "$2" = "9" ]
count="$3"
bytes="$4"
[ "$5" = "--" ]
while IFS= read -r -d '' argument; do
  [ "$argument" != "SECRET_SENTINEL=must-not-appear-in-bootstrap-argv" ]
done </proc/$$/cmdline
shift 5
exec /usr/bin/env -i NEMOCLAW_MANAGED_BOOTSTRAP_RESUME=1 ${JSON.stringify(
          path.join(directory, "nemoclaw-managed-bootstrap"),
        )} --nemoclaw-resume-supervisor 9 "$count" "$bytes" -- "$@"
`,
        { mode: 0o644 },
      );
      const entrypoint = compileEntrypoint(directory, body);
      const launcher = compileExactEnvironmentLauncher(directory, exactEnvironment);
      const result = spawnSync(launcher, [entrypoint, reporter], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(exactEnvironment);

      const ambientResume = spawnSync(
        entrypoint,
        ["--nemoclaw-resume-supervisor", "9", "0", "0", "--", reporter],
        {
          encoding: "utf8",
          env: {
            NEMOCLAW_MANAGED_BOOTSTRAP_RESUME: "1",
            PATH: "/usr/bin:/bin",
          },
        },
      );
      expect(ambientResume.status).not.toBe(0);
      expect(ambientResume.stderr).toContain("resume environment is invalid");

      const malformedLauncher = compileExactEnvironmentLauncher(directory, ["MALFORMED"]);
      const malformedStart = spawnSync(malformedLauncher, [entrypoint, reporter], {
        encoding: "utf8",
      });
      expect(malformedStart.status).not.toBe(0);
      expect(malformedStart.stderr).toContain(
        "supervisor environment contains a malformed assignment",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("enforces supervisor environment count, entry, and aggregate byte boundaries", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-bootstrap-environment-bounds-"),
    );
    try {
      const entrypoint = compileEntrypoint(directory, writePassThroughBody(directory));
      const cases: readonly {
        name: string;
        environment: () => NodeJS.ProcessEnv;
        accepted: boolean;
        error?: string;
      }[] = [
        {
          name: "1024 entries",
          environment: () => environmentWithEntryCount(MAX_ENVIRONMENT_ENTRIES),
          accepted: true,
        },
        {
          name: "1025 entries",
          environment: () => environmentWithEntryCount(MAX_ENVIRONMENT_ENTRIES + 1),
          accepted: false,
          error: "supervisor environment contains too many entries",
        },
        {
          name: "64 KiB entry",
          environment: () => environmentWithEntryLength(MAX_ENVIRONMENT_ENTRY_BYTES),
          accepted: true,
        },
        {
          name: "64 KiB plus one entry",
          environment: () => environmentWithEntryLength(MAX_ENVIRONMENT_ENTRY_BYTES + 1),
          accepted: false,
          error: "supervisor environment entry exceeds its bound",
        },
        {
          name: "512 KiB aggregate",
          environment: () => environmentWithSerializedBytes(MAX_ENVIRONMENT_BYTES),
          accepted: true,
        },
        {
          name: "512 KiB plus one aggregate",
          environment: () => environmentWithSerializedBytes(MAX_ENVIRONMENT_BYTES + 1),
          accepted: false,
          error: "supervisor environment exceeds its transport bound",
        },
      ];

      cases.forEach((testCase) => {
        const result = spawnSync(entrypoint, ["/bin/true"], {
          encoding: "utf8",
          env: testCase.environment(),
        });
        expect(result.status, `${testCase.name}: ${result.stderr}`).toBe(
          testCase.accepted ? 0 : 126,
        );
        expect(result.stderr, testCase.name).toContain(testCase.error ?? "");
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("rejects invalid sealed-descriptor metadata and adversarial FD 9 transports", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-environment-fd-"));
    try {
      const entrypoint = compileEntrypoint(directory, writePassThroughBody(directory));
      const launcher = compileResumeTransportLauncher(directory);
      const cases: readonly {
        name: string;
        mode: "valid" | "missing" | "unsealed" | "substituted" | "truncated" | "extra";
        count: string;
        bytes: string;
        error?: string;
      }[] = [
        {
          name: "valid sealed transport control",
          mode: "valid",
          count: "1",
          bytes: "4",
        },
        {
          name: "missing FD 9",
          mode: "missing",
          count: "1",
          bytes: "4",
          error: "supervisor environment transport is not the sealed bootstrap transport",
        },
        {
          name: "unsealed memfd",
          mode: "unsealed",
          count: "1",
          bytes: "4",
          error: "supervisor environment transport is not the sealed bootstrap transport",
        },
        {
          name: "substituted regular FD 9",
          mode: "substituted",
          count: "1",
          bytes: "4",
          error: "supervisor environment transport is not the sealed bootstrap transport",
        },
        {
          name: "truncated sealed transport",
          mode: "truncated",
          count: "1",
          bytes: "4",
          error: "supervisor environment transport ended early",
        },
        {
          name: "extra sealed transport bytes",
          mode: "extra",
          count: "1",
          bytes: "4",
          error: "supervisor environment transport exceeds its declared size",
        },
        {
          name: "entry-count metadata mismatch",
          mode: "valid",
          count: "2",
          bytes: "4",
          error: "supervisor environment transport has too few entries",
        },
        {
          name: "byte-count metadata mismatch",
          mode: "valid",
          count: "1",
          bytes: "3",
          error: "supervisor environment transport exceeds its declared size",
        },
        {
          name: "extra sealed transport entry",
          mode: "extra",
          count: "1",
          bytes: "8",
          error: "supervisor environment transport entry count is invalid",
        },
      ];

      cases.forEach((testCase) => {
        const result = spawnSync(
          launcher,
          [testCase.mode, entrypoint, testCase.count, testCase.bytes, "/bin/true"],
          { encoding: "utf8" },
        );
        expect(result.status, `${testCase.name}: ${result.stderr}`).toBe(
          testCase.error === undefined ? 0 : 126,
        );
        expect(result.stderr, testCase.name).toContain(testCase.error ?? "");
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("consumes the protected %s request or recovered claim before exact supervisor exec and drops bootstrap variables", (agent) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-trampoline-"));
    try {
      const request = path.join(directory, "request.json");
      const claimDirectory = path.join(directory, ".request.json.nemoclaw-claim");
      const claim = path.join(claimDirectory, "request");
      const completion = path.join(directory, "completion");
      const runtime = path.join(directory, "runtime.cjs");
      const sandbox = path.join(directory, "sandbox");
      const trace = path.join(directory, "trace");
      const script = path.join(directory, "trampoline.sh");
      const supervisor = path.join(directory, "supervisor");
      const injection = path.join(directory, "injection");
      const attackerFunction = path.join(directory, "attacker-function-ran");
      fs.mkdirSync(sandbox);
      fs.writeFileSync(runtime, "");
      fs.writeFileSync(request, "{}\n", { mode: 0o400 });
      const loader = hostileLoader(directory, request);
      executable(
        path.join(directory, "id"),
        `#!/bin/sh
test ! -e /proc/self/fd/9
case "$*" in
  "-u") printf '0\\n' ;;
  "-g") printf '0\\n' ;;
  "-u sandbox") printf '1000\\n' ;;
  "-g sandbox") printf '1000\\n' ;;
  *) exit 1 ;;
esac
`,
      );
      executable(
        path.join(directory, "stat"),
        "#!/bin/sh\ntest ! -e /proc/self/fd/9\nprintf '0:0:400:1\\n'\n",
      );
      executable(
        path.join(directory, "rm"),
        '#!/bin/sh\ntest ! -e /proc/self/fd/9\nexec /bin/rm "$@"\n',
      );
      executable(
        path.join(directory, "node"),
        `#!/bin/sh
test ! -e /proc/self/fd/9
printf 'node:%s:home=%s:path=%s:lang=%s:capability=%s\\n' "$*" "$HOME" "$PATH" "$LANG" "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" >>${JSON.stringify(trace)}
case "$*" in
  *--apply-bootstrap-file*)
    /bin/rm -f ${JSON.stringify(request)} ${JSON.stringify(claim)}
    if test -d ${JSON.stringify(claimDirectory)}; then /bin/rmdir ${JSON.stringify(claimDirectory)}; fi
    printf '%s\\n' '${agent}:${"a".repeat(64)}:${"b".repeat(64)}' >${JSON.stringify(completion)}
    ;;
  *--verify-bootstrap-completion*)
    test "$(/bin/cat ${JSON.stringify(completion)})" = '${agent}:${"a".repeat(64)}:${"b".repeat(64)}'
    ;;
esac
`,
      );
      executable(
        supervisor,
        `#!/bin/bash
set -e
test ! -e /proc/self/fd/9
test ! -e "$REQUEST"
test ! -e "$CLAIM"
test "$#" -eq 3
test "$1" = "supervise"
test "$2" = "two words"
test "$3" = "\\$(touch ${injection})"
test ! -e ${JSON.stringify(injection)}
test "$BASH_ENV" = ${JSON.stringify(path.join(directory, "bash-env"))}
test "$LD_LIBRARY_PATH" = ${JSON.stringify(directory)}
test "$LD_PRELOAD" = ${JSON.stringify(loader.library)}
attacker
test -e ${JSON.stringify(attackerFunction)}
test -z "\${NEMOCLAW_MANAGED_BOOTSTRAP_ENTRYPOINT+x}"
test -z "\${NEMOCLAW_MANAGED_BOOTSTRAP_RESUME+x}"
test -z "\${NEMOCLAW_MANAGED_BOOTSTRAP_RESUME_EXECUTABLE+x}"
printf 'supervisor:%s|%s|%s:identity=%s:request=%s:home=%s:path=%s:lang=%s:capability=%s:bash-env=%s\\n' "$1" "$2" "$3" "\${_nemoclaw_bootstrap_identity-unset}" "\${_nemoclaw_request-unset}" "$HOME" "$PATH" "$LANG" "\${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION-unset}" "\${BASH_ENV+x}" >>"$TRACE"
`,
      );
      const source = fs
        .readFileSync(TRAMPOLINE, "utf8")
        .replaceAll("/usr/bin/id", path.join(directory, "id"))
        .replaceAll("/usr/bin/stat", path.join(directory, "stat"))
        .replaceAll("/usr/bin/rm", path.join(directory, "rm"))
        .replace(
          '_nemoclaw_runtime="/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs"',
          `_nemoclaw_runtime=${JSON.stringify(runtime)}`,
        )
        .replaceAll("/var/lib/nemoclaw-managed-bootstrap-request.json", request)
        .replaceAll("/sandbox", sandbox)
        .replaceAll("/usr/local/bin/node", path.join(directory, "node"));
      fs.writeFileSync(script, source, { mode: 0o644 });
      fs.chmodSync(script, 0o644);
      const entrypoint = compileEntrypoint(directory, script);
      fs.writeFileSync(
        path.join(directory, "bash-env"),
        `printf 'startup after validation\\n' >>${JSON.stringify(trace)}\nset +x\n`,
      );
      const fingerprint = "a".repeat(64);
      const identity = "b".repeat(64);
      const argv = [
        "--agent",
        agent,
        "--profile-fingerprint",
        fingerprint,
        "--bootstrap-identity",
        identity,
        "--agent-uid",
        "1000",
        "--agent-gid",
        "1000",
        "--agent-workdir",
        sandbox,
        "--request-file",
        request,
        "--",
        supervisor,
        "supervise",
        "two words",
        `$(touch ${injection})`,
      ];
      const environment = {
        REQUEST: request,
        CLAIM: claim,
        TRACE: trace,
        BASH_ENV: path.join(directory, "bash-env"),
        "BASH_FUNC_attacker%%": `() { /usr/bin/touch ${attackerFunction}; }`,
        HOME: "/preserved-home",
        PATH: "/preserved-path",
        PS4: "hostile-ps4",
        SHELLOPTS: "xtrace",
        LANG: "zz_TEST",
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "preserved-capability",
        LD_LIBRARY_PATH: directory,
        LD_PRELOAD: loader.library,
        DYLD_INSERT_LIBRARIES: loader.library,
        LD_AUDIT: loader.library,
      };

      execFileSync(entrypoint, argv, { env: environment });

      expect(fs.existsSync(request)).toBe(false);
      expect(fs.existsSync(injection)).toBe(false);
      expect(fs.existsSync(attackerFunction)).toBe(true);
      expect(fs.existsSync(loader.earlyTrace)).toBe(false);
      expect(fs.existsSync(loader.afterTrace)).toBe(true);
      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        `node:${runtime} --recover-bootstrap-claim --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        `node:${runtime} --apply-bootstrap-file --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        `node:${runtime} --verify-bootstrap-completion --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        "startup after validation",
        `supervisor:supervise|two words|$(touch ${injection}):identity=unset:request=unset:home=/preserved-home:path=/preserved-path:lang=zz_TEST:capability=preserved-capability:bash-env=x`,
      ]);

      execFileSync(entrypoint, argv, { env: environment });
      let lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--recover-bootstrap-claim"))).toHaveLength(2);
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(2);
      expect(lines.filter((line) => line === "startup after validation")).toHaveLength(2);

      fs.rmSync(completion);
      fs.mkdirSync(claimDirectory, { mode: 0o700 });
      fs.writeFileSync(claim, "{}\n", { mode: 0o400 });
      execFileSync(entrypoint, argv, { env: environment });
      expect(fs.existsSync(request)).toBe(false);
      expect(fs.existsSync(claim)).toBe(false);
      expect(fs.existsSync(claimDirectory)).toBe(false);
      lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--recover-bootstrap-claim"))).toHaveLength(3);
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(3);
      expect(lines.filter((line) => line === "startup after validation")).toHaveLength(3);

      fs.writeFileSync(completion, `${agent}:${fingerprint}:${"c".repeat(64)}\n`);
      const tamperedRestart = spawnSync(entrypoint, argv, {
        encoding: "utf8",
        env: environment,
      });
      expect(tamperedRestart.status).not.toBe(0);
      lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(3);
      expect(lines.filter((line) => line === "startup after validation")).toHaveLength(3);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);
});
