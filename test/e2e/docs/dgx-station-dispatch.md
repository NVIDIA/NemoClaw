<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station Express dispatch

Select `dgx-station-express` by itself in the `jobs` or `targets` input of the E2E workflow. The target is excluded from default runs. Its GitHub-hosted controller runs from the trusted main workflow and sends the candidate commit and selected managed-image publication revision to the operator's Station receiver.

Configure the GitHub repository variable `DGX_STATION_DISPATCH_URL` with the receiver's HTTPS origin. Station uses its own queue, OIDC audience, receipt, and artifact namespace. The controller does not use `JETSON_DISPATCH_URL`.

The receiver uses the configured runner account’s normal HOME so its systemd user manager can discover the gateway service. It requires this account’s NemoClaw installation state to be clean between runs. The receiver needs a dedicated Station with prepared host prerequisites, a cached Nemotron 3 Ultra 550B model, and the vLLM image selected by the candidate recipe. Each job uses `/tmp/ncs/<job-id>` for temporary files so `tsx` IPC socket paths fit the Linux pathname limit. The test runs the local candidate installer:

```bash
NEMOCLAW_REPO_ROOT="$(pwd)" bash install.sh --express-install --yes-i-accept-third-party-software
```

`--express-install` selects the existing Station Express recipe without a prompt. It requires software acceptance and rejects conflicting provider, profile, deferred-onboarding, and interactive Station options. Ordinary non-interactive installation retains its existing selection behavior.

The smoke checks the ready sandbox, running managed vLLM with the Ultra serving alias, the independently selected managed-image revision, and an assistant response through `inference.local`. Cleanup attempts to retire installation state left after success or failure. Cleanup uses a fresh signal through the E2E cleanup registry.

Timing evidence records completed smoke phases. Total duration spans installer start through smoke cleanup. Readiness and assertion durations can be absent after failure. vLLM startup remains inside installation. The cache check compares paths, file sizes, and symlink targets. The smoke also checks that the vLLM image remains after uninstall.

Qualify an untouched baseline and the local candidate before drawing performance conclusions. The new controller must be available on the trusted main workflow before a GitHub run can execute it. An unmerged candidate selection does not replace the controller source. Keep local hardware evidence separate from proof of the full GitHub dispatch path.

If installation state remains, CI cleanup validates any available sandbox registry and invokes the product uninstaller. The shared helper then handles an orphaned OpenClaw state volume when it was absent from the pre-install inventory, has the expected ownership labels and local driver without driver options, and is not attached to a container. It rejects unexpected volume changes and checks the final inventory against the baseline. An uninstall failure stops before volume cleanup. The helper does not rewrite session or registry state to make uninstall proceed. This does not establish that the standalone product uninstaller removes every agent state volume.
