<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Canonical Hermes Personal MXC qualification

**Blocked before installer integration.** The exact official PortableGit shell
works on the Windows ARM64 host and fails during MSYS initialization inside the
selected Personal MXC boundary. No Hermes installer is qualified or published by
this result. The existing finished OpenClaw preview is a separate artifact.

## Exact inputs and evidence

- NousResearch/hermes-agent `v2026.9.7`, version `0.21.1`, commit
  `2237be355906fbe6065ce1815711eee52b2d646e`.
- [Official source archive](https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2237be355906fbe6065ce1815711eee52b2d646e):
  SHA-256 `c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87`.
- [Official PortableGit-2.54.0-arm64.7z.exe](https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-arm64.7z.exe):
  SHA-256 `f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7`.
- Complete CI runtime: source `47d890728482cca05e840edd27e33e3d495aeabf`,
  [run 34551706967](https://github.com/NVIDIA/NemoClaw/actions/runs/34551706967),
  artifact `10181796438`, 1,099,892,587 bytes,
  SHA-256 `b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed`.
- [Personal comparison run 34564311916, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34564311916/attempts/1):
  controller `a8b419c51bdb10d12bb630bbb4c5648b5fa04572`, Windows ARM64
  job `103153182249`. Evidence artifact `10185577422`, 39,010 bytes,
  SHA-256 `8f2b785db0a889d0000b2d6d11c042b7a7939039ba8a9a50206f5d0b957a5230`.

The complete candidate archive and inventory were verified before execution;
all extracted files were rehashed, and 12,173 original Nous source files were
verified unchanged. The candidate contains 57,820 files and 2,919,342,369 logical
bytes. These are candidate counts, not an installed or pruned payload measurement.
The upstream tag is recorded as unsigned in `official-components.lock.json`;
this gate does not certify Windows Authenticode signatures.

## Required shell failure

Both diagnostics used the exact same executable bytes and arguments:
`--noprofile --norc -c "printf '%s\n' '<sentinel>'"`. The canonical
`LocalEnvironment` attempt ran first. Contained diagnostics followed its closure;
the host comparison ran only after MXC exited, with a separate owned home.
Host execution therefore did not initialize MSYS state before the contained test.

| Executable | Architecture | Host | Personal MXC |
| --- | --- | --- | --- |
| `git/bin/bash.exe` | ARM64 wrapper | Exit 0, sentinel, 125 ms | Exit `0xC0000005`, 340 ms |
| `git/usr/bin/bash.exe` | x64, emulated on ARM64 | Exit 0, sentinel, 98 ms | Exit `0xC0000005`, 298 ms |

The wrapper captured the native initialization error below. The direct x64
process had the same exit code and no stderr; no additional native cause is
inferred from that empty stream.

```text
fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-<installation-key>): 0xC0000022
```

`0xC0000022` is the access-denied result from creating the MSYS object-manager
directory. It is distinct from the observed process exit `0xC0000005`.
The native error matches the failure reported in
[Microsoft MXC issue #1061](https://github.com/microsoft/mxc/issues/1061).
That issue is supporting upstream context; the host/contained comparison above
is independent evidence for these exact packaged bytes and policy.

Verified executable SHA-256 values, unchanged before and after execution:

- ARM64 wrapper: `828e6e891cee98d39057c0c193800e564231fdf92b3cefa15944378fc7730095`.
- x64 Bash: `92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474`.
- x64 `msys-2.0.dll`: `13f0b0dc94588766ecfa1867f1a00061508ba1dc62f5b8e858ac59f01e358aa0`.
- MXC SDK 0.8.0 ARM64 executor: `dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503`.

The actual tier was `appcontainer-dacl`, with UI enabled and Personal networking
(`internetClient`, `privateNetworkClientServer`, local network allowed). Only
the runtime/controller read paths and owned writable share were granted. The
comparison used no host tool discovery, WSL substitution, global namespace
precreation, broader filesystem grants or increased startup deadline.

## Other component results and limits

- **Python passed:** official CPython 3.11.16 ARM64, Hermes 0.21.1, parent and
  subprocess temporary-file create/write/read/delete operations. This is operation
  evidence; the test did not independently capture effective token/DACL details.
- **Canonical Bash failed:** `LocalEnvironment` could not start its exact owned
  shell. The host diagnostics do not replace that failed qualification result.
- **ConPTY failed:** pywinpty 2.0.15 reported that `pty_rs` was compiled without
  ConPTY enabled. An explicit upstream Cargo feature is a separate proposed CI
  build correction; a corrected Windows build has not passed this gate.
- **Browser failed:** canonical browser capture-file creation raised
  `PermissionError: [Errno 13]`. Its direct mode-0700 session-directory creation
  bypasses the existing tempfile delegate. A scoped adaptation is proposed;
  same-token DACL and corrected-browser execution remain unqualified.
- **Cleanup passed:** the executor and all diagnostic children closed normally;
  none timed out, exceeded its output bound or reported a spawn error. The exact
  MXC profile, share/controller/host scratch roots and runtime root were removed,
  with no cleanup errors. The later forced-termination guard evaluates identically
  for these normal completion records.

This direct-executor probe did not acquire the installed native private-state
lease. Installed lease release, onboarding, dashboard interaction, NVIDIA
inference, file/code/ripgrep tools, optional capability configuration, install
under 30 seconds, cold/warm startup, idle resource use and uninstall remain
unperformed for a Hermes installer. Tavily live lookup remains explicitly waived.

The required canonical shell is incompatible with this tested MXC boundary.
Hermes stays unavailable in the finished installer until compatible upstream
behavior is established and the complete installed acceptance passes. No shell
substitution, timeout increase or permission relaxation is used to bypass it.
