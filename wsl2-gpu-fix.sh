#!/bin/bash
# wsl2-gpu-fix.sh — Apply WSL2 GPU fixes to an OpenShell gateway
# Run after: openshell gateway start --gpu
# Usage: ./wsl2-gpu-fix.sh [gateway-name]
#
# This script applies the same fixes as the PR (NVIDIA/OpenShell#411)
# at runtime, until the upstream image ships with WSL2 support.

set -euo pipefail

GATEWAY="${1:-nemoclaw}"
echo "Applying WSL2 GPU fixes to gateway '$GATEWAY'..."

# Check gateway is up
if ! openshell status 2>&1 | grep -q "Connected"; then
    echo "Error: gateway not connected. Start it first: openshell gateway start --gpu --name $GATEWAY"
    exit 1
fi

# Check we're on WSL2
if [ ! -c /dev/dxg ] 2>/dev/null; then
    echo "Not WSL2 (/dev/dxg absent) — no fixes needed"
    exit 0
fi

echo "[1/4] Generating CDI spec with GPU UUIDs and libdxcore.so..."
openshell doctor exec -- sh -c '
mkdir -p /var/run/cdi

# Gather info
GPU_UUID=$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader 2>/dev/null | tr -d " " | head -1)
DXCORE_PATH=$(find /usr/lib -name "libdxcore.so" 2>/dev/null | head -1)
DXCORE_DIR=$(dirname "$DXCORE_PATH" 2>/dev/null || echo "/usr/lib/x86_64-linux-gnu")
DRIVER_DIR=$(ls -d /usr/lib/wsl/drivers/nv*.inf_amd64_* 2>/dev/null | head -1)

if [ -z "$DRIVER_DIR" ]; then
    echo "Error: no NVIDIA WSL driver store found"
    exit 1
fi

# Write complete CDI spec from scratch (avoids fragile sed patching)
cat > /var/run/cdi/nvidia.yaml << CDIEOF
---
cdiVersion: "0.5.0"
kind: nvidia.com/gpu
devices:
    - name: all
      containerEdits:
        deviceNodes:
            - path: /dev/dxg
    - name: "${GPU_UUID}"
      containerEdits:
        deviceNodes:
            - path: /dev/dxg
    - name: "0"
      containerEdits:
        deviceNodes:
            - path: /dev/dxg
containerEdits:
    env:
        - NVIDIA_VISIBLE_DEVICES=void
    hooks:
        - hookName: createContainer
          path: /usr/bin/nvidia-cdi-hook
          args:
            - nvidia-cdi-hook
            - create-symlinks
            - --link
            - ${DRIVER_DIR}/nvidia-smi::/usr/bin/nvidia-smi
          env:
            - NVIDIA_CTK_DEBUG=false
        - hookName: createContainer
          path: /usr/bin/nvidia-cdi-hook
          args:
            - nvidia-cdi-hook
            - update-ldcache
            - --folder
            - ${DRIVER_DIR}
            - --folder
            - ${DXCORE_DIR}
          env:
            - NVIDIA_CTK_DEBUG=false
    mounts:
        - hostPath: ${DXCORE_PATH}
          containerPath: ${DXCORE_PATH}
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libcuda.so.1.1
          containerPath: ${DRIVER_DIR}/libcuda.so.1.1
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libcuda_loader.so
          containerPath: ${DRIVER_DIR}/libcuda_loader.so
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libnvdxgdmal.so.1
          containerPath: ${DRIVER_DIR}/libnvdxgdmal.so.1
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libnvidia-ml.so.1
          containerPath: ${DRIVER_DIR}/libnvidia-ml.so.1
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libnvidia-ml_loader.so
          containerPath: ${DRIVER_DIR}/libnvidia-ml_loader.so
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/libnvidia-ptxjitcompiler.so.1
          containerPath: ${DRIVER_DIR}/libnvidia-ptxjitcompiler.so.1
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/nvcubins.bin
          containerPath: ${DRIVER_DIR}/nvcubins.bin
          options: [ro, nosuid, nodev, rbind, rprivate]
        - hostPath: ${DRIVER_DIR}/nvidia-smi
          containerPath: ${DRIVER_DIR}/nvidia-smi
          options: [ro, nosuid, nodev, rbind, rprivate]
CDIEOF

nvidia-ctk cdi list 2>&1
'

echo "[2/4] Switching nvidia runtime to CDI mode..."
openshell doctor exec -- sed -i 's/mode = "auto"/mode = "cdi"/' /etc/nvidia-container-runtime/config.toml

echo "[3/4] Labeling node with NVIDIA PCI vendor..."
openshell doctor exec -- sh -c '
NODE=$(kubectl get nodes -o jsonpath="{.items[0].metadata.name}")
kubectl label node $NODE feature.node.kubernetes.io/pci-10de.present=true --overwrite
' 2>&1

echo "[4/4] Waiting for nvidia-device-plugin..."
for i in $(seq 1 60); do
    GPU=$(openshell doctor exec -- kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}' 2>/dev/null || true)
    if [ "$GPU" = "1" ]; then
        echo "GPU ready: nvidia.com/gpu=$GPU"
        break
    fi
    [ "$((i % 10))" = "0" ] && echo "  still waiting ($i/60)..."
    sleep 2
done

if [ "$GPU" != "1" ]; then
    echo "Warning: GPU resource not yet advertised after 120s"
    echo "Checking device plugin pods..."
    openshell doctor exec -- kubectl -n nvidia-device-plugin get pods 2>&1
    exit 1
fi

echo ""
echo "WSL2 GPU fixes applied successfully."
echo "Sandbox creation with --gpu should now work."
