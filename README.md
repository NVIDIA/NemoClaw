<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Finished Windows ARM64 preview 0.1.1 for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/de4c8aaac4b0fd2839b09c9b4e4b453a3414f160/NemoClawSetup-0.1.1-windows-arm64.exe) · [Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/de4c8aaac4b0fd2839b09c9b4e4b453a3414f160/NemoClaw-0.1.1-windows-arm64.msi)

**Installed acceptance failed. This preview remains unqualified.** The fresh Windows run installed successfully in 51.190 seconds, then failed before dashboard/model acceptance. Uninstall returned success in 16.634 seconds but the installation directory remained. No warm-start or model/tool success is claimed. The under-30-second installation target is not met.
This is a selected OpenClaw finished-application candidate, not a production release.
It does not qualify other agents, physical hardware, live search or the installation-time target.

Built source: `7ef5b2b1abc6379eeecbd2d23f002c39a345b971`. Separately reviewed PR head: `7ef5b2b1abc6379eeecbd2d23f002c39a345b971`.
The [source workflow, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34540071714/attempts/1)
completed the package build and downloadable preview upload. This status is the staging-time snapshot; the workflow may have advanced.
Its linked results remain authoritative for later acceptance progress.

The [publication receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/de4c8aaac4b0fd2839b09c9b4e4b453a3414f160/installer-receipt-0.1.1.json), [build receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/de4c8aaac4b0fd2839b09c9b4e4b453a3414f160/immutable-package-build-0.1.1.json) and
[runtime identity](https://raw.githubusercontent.com/NVIDIA/NemoClaw/de4c8aaac4b0fd2839b09c9b4e4b453a3414f160/runtime-identity-0.1.1.json) bind the two verified binaries to the exact source and sealed runtime.
The complete original [Actions artifact](https://github.com/NVIDIA/NemoClaw/actions/runs/34540071714/artifacts/10177220002) was checked against GitHub's SHA256 digest.
Git commit signatures do not certify Windows Authenticode signing or application qualification.

The previous 0.1.0 binaries and metadata are retained unchanged as historical failed-preview evidence;
they are not the downloads linked above. This artifact branch uses Git LFS. No GitHub Release is published.
