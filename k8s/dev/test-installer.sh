#!/bin/bash
# Test NemoClaw public installer on K8s with Dynamo vLLM
#
# Prerequisites:
#   - Dynamo vLLM serving a model
#   - PR #318 merged (non-interactive mode) + PR #365 (Dynamo provider)
#
# Usage:
#   ./test-installer.sh [--cleanup]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${NAMESPACE:-nemoclaw}"
POD_NAME="nemoclaw-installer"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

# Handle cleanup flag
if [[ "${1:-}" == "--cleanup" ]]; then
    info "Cleaning up..."
    kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found
    exit 0
fi

echo "=============================================="
echo "NemoClaw Public Installer Test"
echo "=============================================="
echo ""

# Step 1: Verify Dynamo endpoint is reachable
info "Step 1: Checking Dynamo vLLM endpoint..."
DYNAMO_ENDPOINT="${NEMOCLAW_DYNAMO_ENDPOINT:-http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1}"
DYNAMO_MODEL="${NEMOCLAW_DYNAMO_MODEL:-meta-llama/Llama-3.1-8B-Instruct}"

# Quick check from a test pod
if kubectl run curl-check --image=curlimages/curl --rm -it --restart=Never \
    --namespace="${NAMESPACE}" -- \
    curl -sf --max-time 5 "${DYNAMO_ENDPOINT%/v1}/v1/models" >/dev/null 2>&1; then
    info "Dynamo endpoint reachable: $DYNAMO_ENDPOINT"
else
    warn "Could not reach Dynamo endpoint: $DYNAMO_ENDPOINT"
    warn "Continuing anyway - endpoint may be accessible from installer pod"
fi
echo ""

# Step 2: Create namespace and deploy pod
info "Step 2: Deploying installer pod..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
sleep 2

# Update the YAML with current endpoint/model if env vars are set
if [[ -n "${NEMOCLAW_DYNAMO_ENDPOINT:-}" ]]; then
    sed "s|http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1|${NEMOCLAW_DYNAMO_ENDPOINT}|g" \
        "$SCRIPT_DIR/nemoclaw-installer-test.yaml" | \
    sed "s|meta-llama/Llama-3.1-8B-Instruct|${NEMOCLAW_DYNAMO_MODEL:-meta-llama/Llama-3.1-8B-Instruct}|g" | \
    kubectl apply -f -
else
    kubectl apply -f "$SCRIPT_DIR/nemoclaw-installer-test.yaml"
fi

kubectl wait --for=condition=Ready "pod/$POD_NAME" -n "$NAMESPACE" --timeout=120s
echo ""

# Step 3: Wait for Docker daemon
info "Step 3: Waiting for Docker daemon..."
for i in $(seq 1 30); do
    if kubectl exec "$POD_NAME" -n "$NAMESPACE" -c installer -- \
        docker info >/dev/null 2>&1; then
        break
    fi
    [[ "$i" -eq 30 ]] && fail "Docker daemon failed to start"
    echo "  Waiting for docker... ($i/30)"
    sleep 2
done
info "Docker daemon is ready"
echo ""

# Step 4: Install prerequisites and run installer
info "Step 4: Running NemoClaw public installer..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c installer -- bash -c '
    # Install curl and Node.js (installer prerequisites)
    apt-get update -qq && apt-get install -y -qq curl ca-certificates > /dev/null 2>&1

    # Install Node.js 22
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1

    echo "Node.js version: $(node --version)"
    echo "npm version: $(npm --version)"
    echo ""
    echo "Environment:"
    env | grep -E "NEMOCLAW|DYNAMO" || true
    echo ""
    echo "Running installer..."
    echo "=============================================="

    # Run the public installer
    curl -fsSL https://nvidia.com/nemoclaw.sh | bash
'

echo ""
echo "=============================================="
info "Test complete!"
echo "=============================================="
echo ""
echo "To connect to the sandbox:"
echo "  kubectl exec -it $POD_NAME -n $NAMESPACE -c installer -- nemoclaw nemoclaw-k8s connect"
echo ""
echo "To check status:"
echo "  kubectl exec $POD_NAME -n $NAMESPACE -c installer -- nemoclaw nemoclaw-k8s status"
echo ""
echo "To cleanup:"
echo "  ./test-installer.sh --cleanup"
