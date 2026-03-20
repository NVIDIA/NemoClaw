---
phase: 2
slug: container-setup-and-nemoclaw-install
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Pester 5.x |
| **Config file** | None — inline `-CI` flag |
| **Quick run command** | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -CI` |
| **Full suite command** | `Invoke-Pester ./windows/tests/ -CI` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `Invoke-Pester ./windows/tests/Install.Tests.ps1 -CI`
- **After every plan wave:** Run `Invoke-Pester ./windows/tests/ -CI`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SETUP-01 | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-01" -CI` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | SETUP-02 | unit (mock filesystem + docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-02" -CI` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | SETUP-03 | unit (mock Read-Host, registry, docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-03" -CI` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 1 | SETUP-04 | unit (verify Dockerfile content/docker build args) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-04" -CI` | ❌ W0 | ⬜ pending |
| 02-01-05 | 01 | 1 | SETUP-05 | unit (mock Invoke-WebRequest) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-05" -CI` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `windows/tests/Install.Tests.ps1` — add SETUP-01 through SETUP-05 test blocks (extend existing file)
- [ ] New functions must follow `$env:NEMOCLAW_TESTING` guard pattern for safe dot-sourcing
- [ ] `windows/Dockerfile.nemoclaw` — needs to exist before docker build tests can verify its content

*Existing Pester framework from Phase 1 covers test infrastructure.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| OpenClaw dashboard loads in browser | SETUP-05 | Requires running Docker container with network | 1. Run install.ps1 through Phase 2 2. Open http://localhost:18789 3. Verify dashboard renders |
| Files sync between Desktop\NemoClaw and container | SETUP-02 | Requires active container mount | 1. Place test file in Desktop\NemoClaw 2. Exec into container 3. Verify file at /home/nemoclaw/shared |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
