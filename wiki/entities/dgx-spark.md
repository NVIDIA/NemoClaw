---
title: DGX Spark
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [spark-install]
tags: [platform, nvidia, hardware]
---

# DGX Spark

NVIDIA hardware platform with Ubuntu 24.04 pre-installed. Requires specific
pre-configuration before running NemoClaw.

## Prerequisites

- Ubuntu 24.04 (pre-installed)
- Docker (pre-installed)
- Node.js 22+ (installed by NemoClaw)
- [OpenShell](openshell.md) CLI (must be installed manually before NemoClaw)

## Setup

```bash
# Install OpenShell
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh

# Fix cgroup v2 and Docker permissions
sudo ./scripts/setup-spark.sh

# Run NemoClaw installer
./install.sh
```

## Known Issues

| Issue | Resolution |
|---|---|
| Cgroup v2 kills k3s in Docker | `setup-spark` sets `cgroupns=host` |
| Docker permission denied | `setup-spark` runs `usermod` |
| CoreDNS CrashLoop | `scripts/fix-coredns.sh` |
| Image pull failure (k3s) | `openshell gateway destroy && openshell gateway start` |
| Port 3000 conflict with AI Workbench | Use different port |

## See Also

- [Installation](../concepts/installation.md) — General install guide
- [OpenShell](openshell.md) — Required runtime
