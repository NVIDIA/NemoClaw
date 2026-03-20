---
phase: 02-container-setup-and-nemoclaw-install
verified: 2026-03-20T18:00:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 02: Container Setup and NemoClaw Install — Verification Report

**Phase Goal:** Create a Docker-based NemoClaw container with automated setup including NVIDIA API key management, shared folder creation, and health check verification.
**Verified:** 2026-03-20
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User is prompted for NVIDIA API key with masked input; key persists in registry across runs | VERIFIED | `Request-NvidiaApiKey` uses `Read-Host -AsSecureString`; `Save-NvidiaApiKey` stores via `ConvertFrom-SecureString` (DPAPI) at `HKCU:\Software\NemoClaw\ApiKey`; `Get-NvidiaApiKey` re-reads and skips prompt on subsequent runs (install.ps1 lines 381–430) |
| 2 | A Dockerfile builds an Ubuntu 22.04 image with install.sh run non-interactively | VERIFIED | `windows/Dockerfile.nemoclaw` contains `FROM ubuntu:22.04`, `COPY install.sh /tmp/install.sh`, and `NEMOCLAW_NON_INTERACTIVE=1 /tmp/install.sh --non-interactive` (lines 3, 18–20) |
| 3 | Container 'nemoclaw' runs with port 18789 forwarded, Desktop/NemoClaw mounted, and API key injected | VERIFIED | `Start-NemoClawContainer` calls `docker run -d --name nemoclaw -p 18789:18789 -v "${SharedFolder}:/home/nemoclaw/shared" -e "NVIDIA_API_KEY=$ApiKey"` (install.ps1 lines 470–484) |
| 4 | Script polls http://localhost:18789 and prints green success banner when dashboard responds | VERIFIED | `Test-DashboardReady` polls `Invoke-WebRequest -Uri "http://localhost:18789"` with 180s timeout/5s interval; `Show-ContainerBanner` prints green banner with URL (install.ps1 lines 488–528) |
| 5 | Re-running the script removes the old container and rebuilds cleanly | VERIFIED | `Remove-ExistingContainer` uses `docker ps -a --filter "name=^nemoclaw$"` with anchors then calls `docker stop` + `docker rm`; orchestrator calls this before `Build-NemoClawImage` (install.ps1 lines 448–456, 547–548) |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `windows/Dockerfile.nemoclaw` | Ubuntu 22.04 image definition with install.sh run at build time | VERIFIED | 29 lines, complete image definition. Contains all required directives: FROM ubuntu:22.04, DEBIAN_FRONTEND, apt deps, COPY install.sh, non-interactive run, COPY nemoclaw-start.sh, EXPOSE 18789, CMD. Committed in fd8d498. |
| `windows/install.ps1` | Phase 2 container setup functions | VERIFIED | All 10 Phase 2 functions present (Save-NvidiaApiKey, Get-NvidiaApiKey, Request-NvidiaApiKey, New-NemoClawFolder, Remove-ExistingContainer, Build-NemoClawImage, Start-NemoClawContainer, Test-DashboardReady, Show-ContainerBanner, Install-NemoClawContainer). Entry point calls both Install-Prerequisites and Install-NemoClawContainer. Committed in 6a0c86e. |
| `windows/tests/Install.Tests.ps1` | SETUP-01 through SETUP-05 Pester test blocks | VERIFIED | 5 Describe blocks with dual tags appended after PREREQ blocks (lines 402–654). All existing PREREQ tests preserved. Committed in ff26d90. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `install.ps1 (Build-NemoClawImage)` | `windows/Dockerfile.nemoclaw` | `docker build -t nemoclaw -f $dockerfilePath $contextPath` | WIRED | Line 460: `$dockerfilePath = Join-Path $PSScriptRoot "Dockerfile.nemoclaw"`. Line 462: `docker build -t nemoclaw -f $dockerfilePath $contextPath`. Variable indirection is correct — PSScriptRoot-relative path resolved at runtime. |
| `install.ps1 (Start-NemoClawContainer)` | `docker run` | `-p 18789:18789 -v Desktop/NemoClaw:/home/nemoclaw/shared -e NVIDIA_API_KEY` | WIRED | Lines 473–478: `docker run -d --name nemoclaw -p 18789:18789 -v "${SharedFolder}:/home/nemoclaw/shared" -e "NVIDIA_API_KEY=$ApiKey"`. All three required flags confirmed present. |
| `install.ps1 (Test-DashboardReady)` | `http://localhost:18789` | `Invoke-WebRequest polling loop` | WIRED | Line 495: `Invoke-WebRequest -Uri "http://localhost:18789" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop`. Response checked for StatusCode 200 before returning true. |
| `Install.Tests.ps1` | `windows/install.ps1` | `dot-source with NEMOCLAW_TESTING guard` | WIRED | Line 7: `. "$PSScriptRoot\..\install.ps1"` inside `BeforeAll { $env:NEMOCLAW_TESTING = "1" ... }`. Guard at install.ps1 line 601: `if ($env:NEMOCLAW_TESTING) { return }`. |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SETUP-01 | 02-01-PLAN, 02-02-PLAN | Script creates a named Ubuntu 22.04 container with port 18789 forwarded | SATISFIED | `Start-NemoClawContainer` runs container named `nemoclaw` with `-p 18789:18789`. Dockerfile uses `FROM ubuntu:22.04`. Pester block `Container Creation` tagged SETUP-01 at line 406 of Install.Tests.ps1. |
| SETUP-02 | 02-01-PLAN, 02-02-PLAN | Script creates Desktop/NemoClaw folder and mounts it into the container | SATISFIED | `New-NemoClawFolder` uses `[Environment]::GetFolderPath("Desktop")` (OneDrive-safe). Volume mount `-v "${SharedFolder}:/home/nemoclaw/shared"` in `Start-NemoClawContainer`. Pester block `Shared Folder` tagged SETUP-02 at line 452. |
| SETUP-03 | 02-01-PLAN, 02-02-PLAN | Script prompts user for NVIDIA API key and passes it to the container | SATISFIED | `Request-NvidiaApiKey` prompts with `Read-Host -AsSecureString`; persists via DPAPI; passes plaintext to `Start-NemoClawContainer` which injects as `-e "NVIDIA_API_KEY=$ApiKey"`. Pester block `API Key Handling` tagged SETUP-03 at line 490. |
| SETUP-04 | 02-01-PLAN, 02-02-PLAN | Script runs install.sh non-interactively inside the container | SATISFIED | Dockerfile.nemoclaw lines 18–20: `COPY install.sh /tmp/install.sh` and `NEMOCLAW_NON_INTERACTIVE=1 /tmp/install.sh --non-interactive`. Pester block `Dockerfile and Image Build` tagged SETUP-04 at line 545. |
| SETUP-05 | 02-01-PLAN, 02-02-PLAN | Script verifies container health and dashboard reachability after setup | SATISFIED | `Test-DashboardReady` polls localhost:18789 with 180s timeout. On success, `Show-ContainerBanner` prints green success output. On failure, exits with actionable error message. Pester block `Dashboard Health Check` tagged SETUP-05 at line 594. |

No orphaned requirements — all SETUP-01 through SETUP-05 are claimed in both plans and implemented. Phase 1 requirements (PREREQ-01 through PREREQ-10) are out of scope for this phase.

---

### Anti-Patterns Found

No TODOs, FIXMEs, placeholders, or empty implementations found in any phase 2 files (`windows/Dockerfile.nemoclaw`, phase 2 sections of `windows/install.ps1`, `windows/tests/Install.Tests.ps1`).

One pre-existing issue documented by SUMMARY.md (not introduced by this phase):

| File | Location | Pattern | Severity | Impact |
|------|----------|---------|----------|--------|
| `windows/tests/Install.Tests.ps1` | PREREQ-04 context | `Mock exit {}` causes CommandNotFoundException in Pester | Warning (pre-existing) | Only affects PREREQ-04 test — not introduced by Phase 2. Phase 2 tests are unaffected. Noted in 02-02-SUMMARY.md for future cleanup. |

---

### Human Verification Required

None — all phase goal behaviors are fully verifiable from the codebase. Runtime behavior (Docker daemon responding, actual NemoClaw dashboard serving HTTP 200) is out of scope for static verification and is covered by Pester mocks for logic correctness.

---

### Commits Verified

All three commits documented in SUMMARY.md exist and contain the expected changes:

- `fd8d498` — feat(02-01): create Dockerfile.nemoclaw (1 file, 29 lines)
- `6a0c86e` — feat(02-01): add Phase 2 container setup functions to install.ps1 (227 line addition)
- `ff26d90` — test(02-02): add SETUP-01 through SETUP-05 Pester test blocks (254 line addition)

---

### Summary

Phase 2 goal is fully achieved. All five observable truths hold. Both artifacts are substantive and completely wired. All three key links are confirmed in the actual code (the `docker build` call uses `$dockerfilePath` variable set to `Dockerfile.nemoclaw` — correctly PSScriptRoot-relative). All five SETUP requirements are satisfied with both implementation and test coverage. No blocker anti-patterns exist in phase 2 code.

The only deviation from plan claims is the key_link pattern `docker build.*Dockerfile\.nemoclaw` which does not match a single line (the path is in a variable), but the wiring itself is real and correct — this is a pattern-match limitation, not an implementation gap.

---

_Verified: 2026-03-20_
_Verifier: Claude (gsd-verifier)_
