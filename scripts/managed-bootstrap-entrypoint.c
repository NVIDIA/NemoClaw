// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#include <stdbool.h>
#include <stddef.h>

#if !defined(NEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING) || !defined(__linux__)
#error "Managed bootstrap entrypoint requires a freestanding Linux build."
#endif

#ifndef NEMOCLAW_MANAGED_BOOTSTRAP_BASH
#define NEMOCLAW_MANAGED_BOOTSTRAP_BASH "/bin/bash"
#endif

#ifndef NEMOCLAW_MANAGED_BOOTSTRAP_BODY
#define NEMOCLAW_MANAGED_BOOTSTRAP_BODY                                                    \
  "/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh"
#endif

#ifndef NEMOCLAW_MANAGED_BOOTSTRAP_SELF
#define NEMOCLAW_MANAGED_BOOTSTRAP_SELF "/usr/local/bin/nemoclaw-managed-bootstrap"
#endif

#define MAX_ENVIRONMENT_ENTRIES 1024U
#define MAX_ENVIRONMENT_ENTRY_BYTES (64U * 1024U)
#define MAX_ENVIRONMENT_BYTES (512U * 1024U)
#define MAX_BOOTSTRAP_ARGUMENTS 4096U
/* Reserved across fixed Bash/env re-entry; helpers close it and resume makes it close-on-exec. */
#define ENVIRONMENT_FD 9L
#define MFD_ALLOW_SEALING 0x0002L
#define F_SETFD 2L
#define FD_CLOEXEC 1L
#define F_ADD_SEALS 1033L
#define F_GET_SEALS 1034L
#define REQUIRED_SEALS 0x000fL
#define SEEK_SET 0L
#define NEGATIVE_EINTR -4L
#define LINUX_CAPABILITY_VERSION_3 0x20080522U
#define PR_CAPBSET_READ 23L
#define PR_CAPBSET_DROP 24L
#define PR_CAP_AMBIENT 47L
#define PR_CAP_AMBIENT_CLEAR_ALL 4L
#define BOOTSTRAP_CAPABILITY_MASK 0x32U
#define CAP_DAC_OVERRIDE 1L
#define CAP_FSETID 4L
#define CAP_KILL 5L

#if defined(__x86_64__)
#define SYSCALL_READ 0L
#define SYSCALL_WRITE 1L
#define SYSCALL_CLOSE 3L
#define SYSCALL_LSEEK 8L
#define SYSCALL_EXECVE 59L
#define SYSCALL_FCNTL 72L
#define SYSCALL_CAPGET 125L
#define SYSCALL_CAPSET 126L
#define SYSCALL_PRCTL 157L
#define SYSCALL_EXIT_GROUP 231L
#define SYSCALL_DUP3 292L
#define SYSCALL_MEMFD_CREATE 319L

static long raw_syscall1(long number, long first) {
  register long result __asm__("rax") = number;
  register long argument __asm__("rdi") = first;
  __asm__ volatile("syscall"
                   : "+r"(result)
                   : "r"(argument)
                   : "rcx", "r11", "memory");
  return result;
}

static long raw_syscall3(long number, long first, long second, long third) {
  register long result __asm__("rax") = number;
  register long argument_one __asm__("rdi") = first;
  register long argument_two __asm__("rsi") = second;
  register long argument_three __asm__("rdx") = third;
  __asm__ volatile("syscall"
                   : "+r"(result)
                   : "r"(argument_one), "r"(argument_two), "r"(argument_three)
                   : "rcx", "r11", "memory");
  return result;
}

static long raw_syscall5(long number, long first, long second, long third, long fourth,
                         long fifth) {
  register long result __asm__("rax") = number;
  register long argument_one __asm__("rdi") = first;
  register long argument_two __asm__("rsi") = second;
  register long argument_three __asm__("rdx") = third;
  register long argument_four __asm__("r10") = fourth;
  register long argument_five __asm__("r8") = fifth;
  __asm__ volatile("syscall"
                   : "+r"(result)
                   : "r"(argument_one), "r"(argument_two), "r"(argument_three),
                     "r"(argument_four), "r"(argument_five)
                   : "rcx", "r11", "memory");
  return result;
}

__asm__(".global _start\n"
        ".type _start,@function\n"
        "_start:\n"
        "xor %rbp,%rbp\n"
        "mov %rsp,%rdi\n"
        "andq $-16,%rsp\n"
        "call nemoclaw_bootstrap_start\n"
        "ud2\n");

#elif defined(__aarch64__)
#define SYSCALL_DUP3 24L
#define SYSCALL_FCNTL 25L
#define SYSCALL_CLOSE 57L
#define SYSCALL_LSEEK 62L
#define SYSCALL_READ 63L
#define SYSCALL_WRITE 64L
#define SYSCALL_EXIT_GROUP 94L
#define SYSCALL_CAPGET 90L
#define SYSCALL_CAPSET 91L
#define SYSCALL_PRCTL 167L
#define SYSCALL_EXECVE 221L
#define SYSCALL_MEMFD_CREATE 279L

static long raw_syscall1(long number, long first) {
  register long result __asm__("x0") = first;
  register long syscall_number __asm__("x8") = number;
  __asm__ volatile("svc 0" : "+r"(result) : "r"(syscall_number) : "memory");
  return result;
}

static long raw_syscall3(long number, long first, long second, long third) {
  register long result __asm__("x0") = first;
  register long argument_two __asm__("x1") = second;
  register long argument_three __asm__("x2") = third;
  register long syscall_number __asm__("x8") = number;
  __asm__ volatile("svc 0"
                   : "+r"(result)
                   : "r"(argument_two), "r"(argument_three), "r"(syscall_number)
                   : "memory");
  return result;
}

static long raw_syscall5(long number, long first, long second, long third, long fourth,
                         long fifth) {
  register long result __asm__("x0") = first;
  register long argument_two __asm__("x1") = second;
  register long argument_three __asm__("x2") = third;
  register long argument_four __asm__("x3") = fourth;
  register long argument_five __asm__("x4") = fifth;
  register long syscall_number __asm__("x8") = number;
  __asm__ volatile("svc 0"
                   : "+r"(result)
                   : "r"(argument_two), "r"(argument_three), "r"(argument_four),
                     "r"(argument_five), "r"(syscall_number)
                   : "memory");
  return result;
}

__asm__(".global _start\n"
        ".type _start,%function\n"
        "_start:\n"
        "mov x0,sp\n"
        "mov x29,xzr\n"
        "mov x30,xzr\n"
        "bl nemoclaw_bootstrap_start\n"
        "brk #0\n");

#else
#error "Managed bootstrap entrypoint supports only amd64 and arm64."
#endif

static char **process_environment;
static char restored_environment_bytes[MAX_ENVIRONMENT_BYTES];
static char *restored_environment[MAX_ENVIRONMENT_ENTRIES + 1U];

struct capability_header {
  unsigned int version;
  int pid;
};

struct capability_data {
  unsigned int effective;
  unsigned int permitted;
  unsigned int inheritable;
};

__attribute__((noreturn)) static void fail(const char *message);

static size_t text_length(const char *text) {
  size_t length = 0U;
  while (text[length] != '\0') length += 1U;
  return length;
}

static size_t bounded_text_length(const char *text, size_t bound) {
  size_t length = 0U;
  while (length < bound && text[length] != '\0') length += 1U;
  return length;
}

static bool text_equal(const char *left, const char *right) {
  size_t index = 0U;
  while (left[index] != '\0' && left[index] == right[index]) index += 1U;
  return left[index] == right[index];
}

static bool remove_bootstrap_capability_marker(size_t *count) {
  static const char marker[] = "NEMOCLAW_MANAGED_BOOTSTRAP_DROP_CAPABILITIES=0x32";
  bool found = false;
  size_t output = 0U;
  for (size_t index = 0U; index < *count; index += 1U) {
    if (text_equal(restored_environment[index], marker)) {
      if (found) fail("bootstrap capability marker is duplicated");
      found = true;
      continue;
    }
    restored_environment[output++] = restored_environment[index];
  }
  restored_environment[output] = NULL;
  *count = output;
  return found;
}

static void drop_bootstrap_capabilities(void) {
  static const long capabilities[] = {CAP_DAC_OVERRIDE, CAP_FSETID, CAP_KILL};
  struct capability_header header = {LINUX_CAPABILITY_VERSION_3, 0};
  struct capability_data data[2] = {{0U, 0U, 0U}, {0U, 0U, 0U}};
  if (raw_syscall3(SYSCALL_CAPGET, (long)&header, (long)data, 0L) != 0L) {
    fail("could not inspect bootstrap capabilities before supervisor resume");
  }
  if (raw_syscall5(SYSCALL_PRCTL, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0L, 0L, 0L) !=
      0L) {
    fail("could not clear bootstrap ambient capabilities before supervisor resume");
  }
  for (size_t index = 0U; index < sizeof(capabilities) / sizeof(capabilities[0]); index += 1U) {
    const long present =
      raw_syscall5(SYSCALL_PRCTL, PR_CAPBSET_READ, capabilities[index], 0L, 0L, 0L);
    if (present < 0L) fail("could not inspect bootstrap capability bounding set");
    if (present == 1L &&
        raw_syscall5(SYSCALL_PRCTL, PR_CAPBSET_DROP, capabilities[index], 0L, 0L, 0L) != 0L) {
      fail("could not drop bootstrap capability from supervisor bounding set");
    }
  }
  data[0].effective &= ~BOOTSTRAP_CAPABILITY_MASK;
  data[0].permitted &= ~BOOTSTRAP_CAPABILITY_MASK;
  data[0].inheritable &= ~BOOTSTRAP_CAPABILITY_MASK;
  if (raw_syscall3(SYSCALL_CAPSET, (long)&header, (long)data, 0L) != 0L) {
    fail("could not drop bootstrap process capabilities before supervisor resume");
  }
  struct capability_data verified[2] = {{0U, 0U, 0U}, {0U, 0U, 0U}};
  if (raw_syscall3(SYSCALL_CAPGET, (long)&header, (long)verified, 0L) != 0L ||
      ((verified[0].effective | verified[0].permitted | verified[0].inheritable) &
       BOOTSTRAP_CAPABILITY_MASK) != 0U) {
    fail("bootstrap process capabilities remained after supervisor resume drop");
  }
  for (size_t index = 0U; index < sizeof(capabilities) / sizeof(capabilities[0]); index += 1U) {
    if (raw_syscall5(SYSCALL_PRCTL, PR_CAPBSET_READ, capabilities[index], 0L, 0L, 0L) != 0L) {
      fail("bootstrap bounding capability remained after supervisor resume drop");
    }
  }
}

static bool write_all(long descriptor, const char *bytes, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    const long written = raw_syscall3(SYSCALL_WRITE, descriptor, (long)(bytes + offset),
                                      (long)(length - offset));
    if (written == NEGATIVE_EINTR) continue;
    if (written <= 0L) return false;
    offset += (size_t)written;
  }
  return true;
}

__attribute__((noreturn)) static void platform_exit(int status) {
  (void)raw_syscall1(SYSCALL_EXIT_GROUP, (long)status);
  for (;;) {
  }
}

__attribute__((noreturn)) static void fail(const char *message) {
  static const char prefix[] = "[SECURITY] Managed bootstrap entrypoint: ";
  (void)write_all(2L, prefix, sizeof(prefix) - 1U);
  (void)write_all(2L, message, text_length(message));
  (void)write_all(2L, "\n", 1U);
  platform_exit(126);
}

static void exec_process(const char *executable, char *const argv[], char *const environment[]) {
  (void)raw_syscall3(SYSCALL_EXECVE, (long)executable, (long)argv, (long)environment);
}

static size_t environment_byte_count(char *const *entries, size_t count) {
  size_t total_bytes = 0U;
  for (size_t index = 0U; index < count; index += 1U) {
    const size_t entry_length =
      bounded_text_length(entries[index], MAX_ENVIRONMENT_ENTRY_BYTES + 1U);
    if (entry_length > MAX_ENVIRONMENT_ENTRY_BYTES) {
      fail("supervisor environment entry exceeds its bound");
    }
    size_t separator = 0U;
    while (separator < entry_length && entries[index][separator] != '=') separator += 1U;
    if (separator == 0U || separator == entry_length) {
      fail("supervisor environment contains a malformed assignment");
    }
    total_bytes += entry_length + 1U;
    if (total_bytes > MAX_ENVIRONMENT_BYTES) {
      fail("supervisor environment exceeds its transport bound");
    }
  }
  return total_bytes;
}

static size_t inherited_environment_count(void) {
  size_t count = 0U;
  while (process_environment[count] != NULL) {
    count += 1U;
    if (count > MAX_ENVIRONMENT_ENTRIES) {
      fail("supervisor environment contains too many entries");
    }
  }
  return count;
}

static bool parse_bounded_decimal(const char *text, size_t maximum, size_t *result) {
  if (text == NULL || text[0] == '\0' || (text[0] == '0' && text[1] != '\0')) return false;
  size_t value = 0U;
  for (size_t index = 0U; text[index] != '\0'; index += 1U) {
    if (text[index] < '0' || text[index] > '9') return false;
    const size_t digit = (size_t)(text[index] - '0');
    if (value > (maximum - digit) / 10U) return false;
    value = value * 10U + digit;
  }
  *result = value;
  return true;
}

static size_t encode_decimal(size_t value, char output[32]) {
  char reversed[32];
  size_t length = 0U;
  do {
    reversed[length++] = (char)('0' + (value % 10U));
    value /= 10U;
  } while (value > 0U);
  for (size_t index = 0U; index < length; index += 1U) {
    output[index] = reversed[length - index - 1U];
  }
  output[length] = '\0';
  return length;
}

static void create_environment_transport(size_t count, size_t byte_count) {
  static const char name[] = "nemoclaw-supervisor-environment";
  const long created = raw_syscall3(SYSCALL_MEMFD_CREATE, (long)name, MFD_ALLOW_SEALING, 0L);
  if (created < 0L) fail("could not create the supervisor environment transport");
  if (created != ENVIRONMENT_FD) {
    if (raw_syscall3(SYSCALL_DUP3, created, ENVIRONMENT_FD, 0L) != ENVIRONMENT_FD) {
      fail("could not reserve the supervisor environment transport descriptor");
    }
    (void)raw_syscall1(SYSCALL_CLOSE, created);
  }
  size_t written = 0U;
  for (size_t index = 0U; index < count; index += 1U) {
    const size_t length = text_length(process_environment[index]) + 1U;
    if (!write_all(ENVIRONMENT_FD, process_environment[index], length)) {
      fail("could not write the supervisor environment transport");
    }
    written += length;
  }
  if (written != byte_count ||
      raw_syscall3(SYSCALL_FCNTL, ENVIRONMENT_FD, F_ADD_SEALS, REQUIRED_SEALS) != 0L ||
      raw_syscall3(SYSCALL_LSEEK, ENVIRONMENT_FD, 0L, SEEK_SET) != 0L) {
    fail("could not seal the supervisor environment transport");
  }
}

static bool exact_resume_environment(void) {
  static const char marker[] = "NEMOCLAW_MANAGED_BOOTSTRAP_RESUME=1";
  return process_environment[0] != NULL && process_environment[1] == NULL &&
         text_equal(process_environment[0], marker);
}

static void read_environment_transport(size_t count, size_t byte_count) {
  if (raw_syscall3(SYSCALL_FCNTL, ENVIRONMENT_FD, F_GET_SEALS, 0L) != REQUIRED_SEALS ||
      raw_syscall3(SYSCALL_LSEEK, ENVIRONMENT_FD, 0L, SEEK_SET) != 0L) {
    fail("supervisor environment transport is not the sealed bootstrap transport");
  }
  size_t offset = 0U;
  while (offset < byte_count) {
    const long received =
      raw_syscall3(SYSCALL_READ, ENVIRONMENT_FD, (long)(restored_environment_bytes + offset),
                   (long)(byte_count - offset));
    if (received == NEGATIVE_EINTR) continue;
    if (received <= 0L) fail("supervisor environment transport ended early");
    offset += (size_t)received;
  }
  char trailing = '\0';
  long trailing_read = 0L;
  do {
    trailing_read = raw_syscall3(SYSCALL_READ, ENVIRONMENT_FD, (long)&trailing, 1L);
  } while (trailing_read == NEGATIVE_EINTR);
  if (trailing_read != 0L) {
    fail("supervisor environment transport exceeds its declared size");
  }

  offset = 0U;
  for (size_t index = 0U; index < count; index += 1U) {
    if (offset >= byte_count) fail("supervisor environment transport has too few entries");
    restored_environment[index] = &restored_environment_bytes[offset];
    const size_t remaining = byte_count - offset;
    const size_t length = bounded_text_length(restored_environment[index], remaining);
    if (length == remaining) fail("supervisor environment transport contains an unterminated entry");
    offset += length + 1U;
  }
  if (offset != byte_count) fail("supervisor environment transport entry count is invalid");
  restored_environment[count] = NULL;
  if (environment_byte_count(restored_environment, count) != byte_count) {
    fail("supervisor environment transport failed exact validation");
  }
  if (raw_syscall3(SYSCALL_FCNTL, ENVIRONMENT_FD, F_SETFD, FD_CLOEXEC) != 0L) {
    fail("could not contain the supervisor environment transport");
  }
}

__attribute__((noreturn)) static void resume_supervisor(int argc, char **argv) {
  if (!exact_resume_environment()) fail("resume environment is invalid");
  if (argc < 7 || (size_t)argc > MAX_BOOTSTRAP_ARGUMENTS) {
    fail("resume arguments are incomplete or exceed their bound");
  }
  if (!text_equal(argv[2], "9")) fail("resume environment descriptor is invalid");

  size_t environment_count = 0U;
  size_t environment_bytes = 0U;
  if (!parse_bounded_decimal(argv[3], MAX_ENVIRONMENT_ENTRIES, &environment_count) ||
      !parse_bounded_decimal(argv[4], MAX_ENVIRONMENT_BYTES, &environment_bytes) ||
      !text_equal(argv[5], "--")) {
    fail("resume environment metadata is invalid");
  }
  char **supervisor_argv = &argv[6];
  if (supervisor_argv[0][0] != '/') fail("supervisor executable is not absolute");
  read_environment_transport(environment_count, environment_bytes);
  if (remove_bootstrap_capability_marker(&environment_count)) {
    drop_bootstrap_capabilities();
  }
  exec_process(supervisor_argv[0], supervisor_argv, restored_environment);
  fail("could not execute the exact supervisor process");
}

__attribute__((noreturn)) static void start_bootstrap(int argc, char **argv) {
  const size_t environment_count = inherited_environment_count();
  const size_t environment_bytes =
    environment_byte_count(process_environment, environment_count);
  if (argc < 1 || (size_t)argc + 11U > MAX_BOOTSTRAP_ARGUMENTS) {
    fail("bootstrap argv exceeds its transport bound");
  }
  create_environment_transport(environment_count, environment_bytes);

  char environment_count_text[32];
  char environment_bytes_text[32];
  (void)encode_decimal(environment_count, environment_count_text);
  (void)encode_decimal(environment_bytes, environment_bytes_text);

  char *bash_argv[MAX_BOOTSTRAP_ARGUMENTS + 1U];
  size_t output = 0U;
  bash_argv[output++] = (char *)NEMOCLAW_MANAGED_BOOTSTRAP_BASH;
  bash_argv[output++] = "--noprofile";
  bash_argv[output++] = "--norc";
  bash_argv[output++] = "-p";
  bash_argv[output++] = "--";
  bash_argv[output++] = (char *)NEMOCLAW_MANAGED_BOOTSTRAP_BODY;
  bash_argv[output++] = "--nemoclaw-supervisor-environment";
  bash_argv[output++] = "9";
  bash_argv[output++] = environment_count_text;
  bash_argv[output++] = environment_bytes_text;
  bash_argv[output++] = "--";
  for (int index = 1; index < argc; index += 1) bash_argv[output++] = argv[index];
  bash_argv[output] = NULL;

  char *const bootstrap_environment[] = {
      "HOME=/root",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      "NEMOCLAW_MANAGED_BOOTSTRAP_ENTRYPOINT=1",
      "NEMOCLAW_MANAGED_BOOTSTRAP_RESUME_EXECUTABLE=" NEMOCLAW_MANAGED_BOOTSTRAP_SELF,
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      NULL,
  };
  exec_process(NEMOCLAW_MANAGED_BOOTSTRAP_BASH, bash_argv, bootstrap_environment);
  fail("could not execute the fixed Bash interpreter");
}

__attribute__((noreturn)) static void run_entrypoint(int argc, char **argv, char **environment) {
  process_environment = environment;
  if (argc > 1 && text_equal(argv[1], "--nemoclaw-resume-supervisor")) {
    resume_supervisor(argc, argv);
  }
  start_bootstrap(argc, argv);
}

__attribute__((noreturn, used, visibility("hidden"))) void nemoclaw_bootstrap_start(
  size_t *initial_stack) {
  const size_t raw_argc = initial_stack[0];
  if (raw_argc > MAX_BOOTSTRAP_ARGUMENTS) fail("kernel argv exceeds its bound");
  char **argv = (char **)&initial_stack[1];
  char **environment = &argv[raw_argc + 1U];
  run_entrypoint((int)raw_argc, argv, environment);
}
