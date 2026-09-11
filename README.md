<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Finished Windows ARM64 preview 0.1.2 for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/80ab9a0c566ff50463edc76227a0c76ca8fe3e30/NemoClawSetup-0.1.2-windows-arm64.exe) · [Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/80ab9a0c566ff50463edc76227a0c76ca8fe3e30/NemoClaw-0.1.2-windows-arm64.msi)

**The source acceptance run failed. This preview remains unqualified.** No complete native qualification passes are certified by this publication.
This is a selected OpenClaw finished-application candidate, not a production release.
It does not qualify other agents, physical hardware or live search.

The [fresh Windows ARM64 run](https://github.com/NVIDIA/NemoClaw/actions/runs/34544062535/job/103095368896)
measured install **20.025 seconds** and uninstall **15.811 seconds**, both exit 0.
This measured fresh install meets the 30-second target. Uninstall left one empty installation directory.
The installed payload contains 2,488 files (607,983,795 bytes; 374 MSI components).
The original startup observer failed before probing the dashboard. The [corrected replay](https://github.com/NVIDIA/NemoClaw/actions/runs/34547627462/job/103103565519),
using controller `d159455f17c10a418c90ae0fc3a58b56de869429` against these unchanged binaries, reached the dashboard and composer.
The first inference turn then failed locally because the runtime is missing `undici`; no provider response or tool pass was established.
The replay measured install **19.459 seconds** and uninstall **15.789 seconds**. Native sandbox cleanup completed,
but the guardian did not exit within the existing cleanup bound and required termination. Warm startup and idle sampling were not reached.

Known limitation: Discord, Slack and Tavily plugin dependencies are not included in this preview.
Those choices can enter an upstream plugin-install path and do not meet the finished-payload contract.
They remain unqualified while their prebuilt package fix is in progress.

Built source: `b54a1f3a54ab28dff7813de2db9430f6735ec624`. Separately reviewed PR head: `8d1ffc30d073e8d5341525797ef1ce5a2b410d7f`.
The [source workflow, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34544062535/attempts/1)
completed the package build and downloadable preview upload. This status is the staging-time snapshot; the workflow may have advanced.
Its linked results remain authoritative for later acceptance progress.

The [publication receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/80ab9a0c566ff50463edc76227a0c76ca8fe3e30/installer-receipt-0.1.2.json), [build receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/80ab9a0c566ff50463edc76227a0c76ca8fe3e30/immutable-package-build-0.1.2.json) and
[runtime identity](https://raw.githubusercontent.com/NVIDIA/NemoClaw/80ab9a0c566ff50463edc76227a0c76ca8fe3e30/runtime-identity-0.1.2.json) bind the two verified binaries to the exact source and sealed runtime.
The complete original [Actions artifact](https://github.com/NVIDIA/NemoClaw/actions/runs/34544062535/artifacts/10178641244) was checked against GitHub's SHA256 digest.
Git commit signatures do not certify Windows Authenticode signing or application qualification.

The previous 0.1.0 and 0.1.1 binaries and metadata are retained unchanged as historical failed-preview evidence;
they are not the downloads linked above. This artifact branch uses Git LFS. No GitHub Release is published.
