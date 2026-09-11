<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Finished Windows ARM64 preview 0.1.3 for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/8aa14e4d1c25e9c840d9cf5bdac57e6f5dcb8874/NemoClawSetup-0.1.3-windows-arm64.exe) · [Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/8aa14e4d1c25e9c840d9cf5bdac57e6f5dcb8874/NemoClaw-0.1.3-windows-arm64.msi)

**The source acceptance run failed. This preview remains unqualified.** No complete native qualification passes are certified by this publication.
This is a selected OpenClaw finished-application candidate, not a production release.
It does not qualify other agents, physical hardware or live search.

The original Windows ARM64 run measured a fresh install at **28.033 seconds**.
A [later replay of these unchanged package bytes](https://github.com/NVIDIA/NemoClaw/actions/runs/34559667235)
measured **25.719 seconds** for install and **27.694 seconds** for uninstall (both exit 0).
Its first installed session passed a real NVIDIA reply, file write/read, a PowerShell
command, packaged Node code execution and clean Stop with private state released.
Both launches copied zero runtime bytes. The second launch reached the dashboard,
but its tool turn failed on an explicit inference-service overload; the replay remains
failed. A separate idle measurement found high contained-process CPU, under investigation.
These are individual GitHub Windows ARM64 runner measurements, not a guarantee for every
machine or a complete qualification. The original source acceptance failure remains
recorded in its immutable publication receipt.

Both complete anonymous EXE/MSI downloads were verified against their published SHA-256
hashes after publication. No privileged account or Actions artifact download is needed.

Built source: `491a3a3d5e7206d82c741198062b6e2aa98dc72c`. Separately reviewed PR head: `b0e29e11ab8280a33ffcc794571b73b568de2890`.
The [source workflow, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34555046495/attempts/1)
completed the package build and downloadable preview upload. This status is the staging-time snapshot; the workflow may have advanced.
Its linked results remain authoritative for later acceptance progress.

The [publication receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/8aa14e4d1c25e9c840d9cf5bdac57e6f5dcb8874/installer-receipt-0.1.3.json), [build receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/8aa14e4d1c25e9c840d9cf5bdac57e6f5dcb8874/immutable-package-build-0.1.3.json) and
[runtime identity](https://raw.githubusercontent.com/NVIDIA/NemoClaw/8aa14e4d1c25e9c840d9cf5bdac57e6f5dcb8874/runtime-identity-0.1.3.json) bind the two verified binaries to the exact source and sealed runtime.
The complete original [Actions artifact](https://github.com/NVIDIA/NemoClaw/actions/runs/34555046495/artifacts/10182548159) was checked against GitHub's SHA256 digest.
Git commit signatures do not certify Windows Authenticode signing or application qualification.

The previous 0.1.0, 0.1.1 and 0.1.2 binaries and metadata are retained unchanged as historical failed-preview evidence;
they are not the downloads linked above. This artifact branch uses Git LFS. No GitHub Release is published.
