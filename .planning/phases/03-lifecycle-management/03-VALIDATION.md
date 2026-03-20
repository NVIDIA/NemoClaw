---
phase: 3
slug: lifecycle-management
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 3 — Validation Strategy

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
| 03-01-01 | 01 | 0 | LIFE-01 | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-01" -CI` | No — W0 | ⬜ pending |
| 03-01-02 | 01 | 0 | LIFE-02 | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-02" -CI` | No — W0 | ⬜ pending |
| 03-01-03 | 01 | 0 | LIFE-03 | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-03" -CI` | No — W0 | ⬜ pending |
| 03-01-04 | 01 | 0 | LIFE-04 | unit (mock docker + Invoke-WebRequest) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-04" -CI` | No — W0 | ⬜ pending |
| 03-01-05 | 01 | 0 | LIFE-05 | unit (mock docker + winget + Read-Host) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-05" -CI` | No — W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `windows/tests/Install.Tests.ps1` — add LIFE-01 through LIFE-05 test blocks (extend existing file)
- [ ] New functions must follow `$env:NEMOCLAW_TESTING` guard pattern for safe dot-sourcing
- [ ] `param()` block at top of install.ps1 must not break existing test dot-source pattern
- [ ] `nemoclaw-start.sh` entrypoint fix — manual/integration only (no Pester test)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Container stays running after `docker start` | LIFE-01 | Requires actual Docker daemon and container | Run `install.bat start`, verify with `docker ps` |
| Dashboard reachable after start | LIFE-01 | Requires network and running container | Run `install.bat start`, open `http://localhost:18789` |
| nemoclaw-start.sh foreground fix | LIFE-01 | Container entrypoint behavior, no Pester mock | Build image, `docker run`, verify PID 1 stays alive |
| Docker Desktop removal via winget | LIFE-05 | Destructive system operation | Run `install.bat uninstall` with Docker removal option on test machine |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
