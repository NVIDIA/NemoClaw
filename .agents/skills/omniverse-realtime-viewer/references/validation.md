<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validation And Review Evidence

Generated apps should produce enough evidence for a reviewer to confirm that the
viewer works without rerunning every step. Store artifacts with the generated
app, test report, or release notes. Do not commit private scene captures,
customer data, local absolute paths, tokens, environment-specific service URLs, or environment
specific logs.

## Evidence Checklist

Capture at minimum:

- startup and dependency command output,
- first nonblank rendered frame,
- camera orbit, pan, zoom, and fit-to-stage,
- object selection with tree/property panel synchronization,
- scene switching with stale selection and hierarchy cleared,
- render setting or AOV changes when requested,
- shutdown, reconnect, cleanup, or sidecar behavior when relevant.

For browser viewers, prefer Playwright screenshots or app-specific end-to-end
tests. For local, Tauri, Electron, C++, and headless viewers, capture frames
from the same `ovrtx` output path used for display or automation.

## Report Template

Copy this template into the generated app or test output when the app has no
existing validation format.

````markdown
# Viewer Validation Report

## Metadata

| Field | Value |
|---|---|
| App or repo |  |
| Branch or commit |  |
| Date |  |
| Reviewer |  |
| Delivery path | Browser WebRTC / local Python / Tauri / Electron / C++ / headless |
| Runtime environment |  |
| Scene inputs | Sanitized asset names or fixture IDs only |

## Commands Run

| Step | Command | Result | Artifact |
|---|---|---|---|
| Setup |  | Pass / fail / skipped |  |
| Build |  | Pass / fail / skipped |  |
| Runtime launch |  | Pass / fail / skipped |  |
| Validation |  | Pass / fail / skipped |  |

## Evidence Checklist

| Evidence | Status | Artifact | Notes |
|---|---|---|---|
| Startup and dependency output captured | Pass / fail / skipped |  |  |
| First nonblank rendered frame captured | Pass / fail / skipped |  |  |
| Camera orbit, pan, zoom, and fit-to-stage verified | Pass / fail / skipped |  |  |
| Object selection updates viewport, tree, and property panel | Pass / fail / skipped |  |  |
| Scene switch clears stale selection and refreshes hierarchy | Pass / fail / skipped |  |  |
| Render setting or AOV changes verified when requested | Pass / fail / skipped |  |  |
| Shutdown, reconnect, or cleanup behavior verified when relevant | Pass / fail / skipped |  |  |

## Issues And Waivers

| ID | Severity | Summary | Owner | Resolution |
|---|---|---|---|---|
|  |  |  |  |  |

## Result

Overall status: Pass / fail / blocked

Reviewer notes:
````

## Done Criteria

The generated app is ready to share only when:

- the renderer path uses `ovrtx`,
- no browser-side USD/3D fallback is present,
- the app can start from documented commands,
- at least one scene produces a nonblank frame,
- requested interactions are demonstrated with artifacts,
- failure cases and runtime requirements are documented,
- validation artifacts are sanitized.
