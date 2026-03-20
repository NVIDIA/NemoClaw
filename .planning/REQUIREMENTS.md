# Requirements: NemoClaw Windows Installer

**Defined:** 2026-03-20
**Core Value:** A Windows user can run one script and get a working OpenClaw dashboard accessible from their browser, with a Desktop folder for sharing files — no Linux or Docker knowledge required.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Prerequisites

- [ ] **PREREQ-01**: Script has a .bat launcher that bypasses PowerShell execution policy
- [ ] **PREREQ-02**: Script self-elevates to administrator via UAC prompt
- [ ] **PREREQ-03**: Script validates Windows 10 build 19041+ or Windows 11
- [ ] **PREREQ-04**: Script checks available disk space before installing
- [ ] **PREREQ-05**: Script warns if known antivirus may interfere with Docker
- [ ] **PREREQ-06**: Script detects and enables WSL2 if not present
- [ ] **PREREQ-07**: Script handles reboot-required scenario with resume capability
- [ ] **PREREQ-08**: Script installs Docker Desktop silently (winget with EXE fallback)
- [ ] **PREREQ-09**: Script adds current user to docker-users group
- [ ] **PREREQ-10**: Script polls for Docker daemon readiness with timeout

### Container Setup

- [ ] **SETUP-01**: Script creates a named Ubuntu 22.04 container with port 18789 forwarded
- [ ] **SETUP-02**: Script creates Desktop/NemoClaw folder and mounts it into the container
- [ ] **SETUP-03**: Script prompts user for NVIDIA API key and passes it to the container
- [ ] **SETUP-04**: Script runs install.sh non-interactively inside the container
- [ ] **SETUP-05**: Script verifies container health and dashboard reachability after setup

### Lifecycle Management

- [ ] **LIFE-01**: User can start the NemoClaw container (launching Docker Desktop if needed)
- [ ] **LIFE-02**: User can stop the NemoClaw container
- [ ] **LIFE-03**: User can restart the NemoClaw container
- [ ] **LIFE-04**: User can check container status and port reachability
- [ ] **LIFE-05**: User can uninstall (remove container, image, and optionally Docker Desktop)

## v2 Requirements

### Enhanced UX

- **UX-01**: Automatic browser launch to dashboard after setup
- **UX-02**: Desktop shortcut for quick dashboard access
- **UX-03**: Log viewing command for troubleshooting
- **UX-04**: Update command to upgrade NemoClaw inside container

### Advanced Features

- **ADV-01**: GPU passthrough for local inference
- **ADV-02**: Multiple container profiles
- **ADV-03**: Backup/restore of container state

## Out of Scope

| Feature | Reason |
|---------|--------|
| GUI installer | Adds complexity, PowerShell + .bat launcher sufficient for target users |
| Linux/macOS support | Windows-only scope per project definition |
| OpenShell/k3s orchestration | Using plain Docker container instead |
| Bundled Docker Desktop EXE | License and size concerns; download at install time |
| GPU passthrough | Not required for basic dashboard access, defer to v2 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PREREQ-01 | — | Pending |
| PREREQ-02 | — | Pending |
| PREREQ-03 | — | Pending |
| PREREQ-04 | — | Pending |
| PREREQ-05 | — | Pending |
| PREREQ-06 | — | Pending |
| PREREQ-07 | — | Pending |
| PREREQ-08 | — | Pending |
| PREREQ-09 | — | Pending |
| PREREQ-10 | — | Pending |
| SETUP-01 | — | Pending |
| SETUP-02 | — | Pending |
| SETUP-03 | — | Pending |
| SETUP-04 | — | Pending |
| SETUP-05 | — | Pending |
| LIFE-01 | — | Pending |
| LIFE-02 | — | Pending |
| LIFE-03 | — | Pending |
| LIFE-04 | — | Pending |
| LIFE-05 | — | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 0
- Unmapped: 20 ⚠️

---
*Requirements defined: 2026-03-20*
*Last updated: 2026-03-20 after initial definition*
