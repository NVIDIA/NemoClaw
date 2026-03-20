# Roadmap: NemoClaw Windows Installer

## Overview

Three phases, each delivering one complete vertical capability. Phase 1 installs and starts Docker Desktop, surviving the multi-reboot WSL2 sequence that breaks every clean Windows machine. Phase 2 creates the NemoClaw container and verifies the dashboard is reachable. Phase 3 wraps the container in start/stop/restart/status/uninstall commands so users never touch Docker CLI again.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Prerequisites and Docker Desktop** - Get a working Docker daemon on the user's machine, surviving reboots
- [ ] **Phase 2: Container Setup and NemoClaw Install** - Create the NemoClaw container, mount shared folder, verify dashboard reachability
- [ ] **Phase 3: Lifecycle Management** - Give users start/stop/restart/status/uninstall commands with no Docker knowledge required

## Phase Details

### Phase 1: Prerequisites and Docker Desktop
**Goal**: User's machine has Docker Desktop installed, the daemon is running, and the script survives the multi-reboot WSL2 setup sequence
**Depends on**: Nothing (first phase)
**Requirements**: PREREQ-01, PREREQ-02, PREREQ-03, PREREQ-04, PREREQ-05, PREREQ-06, PREREQ-07, PREREQ-08, PREREQ-09, PREREQ-10
**Success Criteria** (what must be TRUE):
  1. User can launch the installer by double-clicking a `.bat` file without any PowerShell execution policy error
  2. Script automatically requests administrator rights via UAC and proceeds without manual elevation
  3. On a clean Windows machine with no WSL2, script enables WSL2 and installs Docker Desktop, prompting for reboot and resuming correctly when the user runs it again after reboot
  4. After Docker Desktop is installed, script waits for the daemon to be ready and confirms `docker info` succeeds before proceeding
  5. Script rejects machines below Windows 10 build 19041 with a plain-English explanation and exits cleanly
**Plans**: TBD

### Phase 2: Container Setup and NemoClaw Install
**Goal**: A running NemoClaw container exists with port 18789 forwarded, Desktop/NemoClaw mounted as a shared folder, and the OpenClaw dashboard confirmed reachable at http://localhost:18789
**Depends on**: Phase 1
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05
**Success Criteria** (what must be TRUE):
  1. User is prompted once for their NVIDIA API key; after entering it, setup proceeds without any further interactive prompts
  2. A folder named `NemoClaw` appears on the user's Desktop after setup completes
  3. Files placed in `Desktop\NemoClaw` are visible inside the container at the expected mount path
  4. Opening http://localhost:18789 in a browser shows the OpenClaw dashboard
**Plans**: TBD

### Phase 3: Lifecycle Management
**Goal**: Users can start, stop, restart, check status, and uninstall NemoClaw using the same script — no Docker CLI knowledge required
**Depends on**: Phase 2
**Requirements**: LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05
**Success Criteria** (what must be TRUE):
  1. Running the script with `start` brings the container up (launching Docker Desktop first if it is not running) and confirms the dashboard is reachable
  2. Running the script with `stop` brings the container down cleanly
  3. Running the script with `status` prints whether the container is running and whether port 18789 is reachable, in plain English
  4. Running the script with `uninstall` removes the container and image with a confirmation prompt, and optionally removes Docker Desktop
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Prerequisites and Docker Desktop | 0/TBD | Not started | - |
| 2. Container Setup and NemoClaw Install | 0/TBD | Not started | - |
| 3. Lifecycle Management | 0/TBD | Not started | - |
