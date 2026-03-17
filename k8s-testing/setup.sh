#!/bin/bash
# NemoClaw on K8s - Full Setup Script
# Deploys OpenShell gateway with DinD, installs NemoClaw, configures Dynamo vLLM
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEMOCLAW_DIR="${NEMOCLAW_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENSHELL_DIR="${OPENSHELL_DIR:-$NEMOCLAW_DIR/../OpenShell}"

NAMESPACE="${NAMESPACE:-default}"
POD_NAME="openshell-gateway"
GATEWAY_NAME="${GATEWAY_NAME:-nemoclaw}"

# vLLM endpoint (Dynamo)
VLLM_ENDPOINT="${VLLM_ENDPOINT:-http://vllm-agg-frontend.robert.svc.cluster.local:8000/v1}"
VLLM_MODEL="${VLLM_MODEL:-meta-llama/Llama-3.1-8B-Instruct}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

# Verify prerequisites
[ -d "$NEMOCLAW_DIR" ] || fail "NemoClaw repo not found at $NEMOCLAW_DIR"
[ -f "$NEMOCLAW_DIR/package.json" ] || fail "NemoClaw package.json not found"

echo "=============================================="
echo "NemoClaw on K8s Setup"
echo "=============================================="
echo ""
echo "NemoClaw source: $NEMOCLAW_DIR"
echo "vLLM endpoint:   $VLLM_ENDPOINT"
echo "vLLM model:      $VLLM_MODEL"
echo ""

# Step 1: Deploy the DinD pod
info "Step 1: Deploying OpenShell gateway pod..."
kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl apply -f "$SCRIPT_DIR/openshell-gateway.yaml"
kubectl wait --for=condition=Ready "pod/$POD_NAME" -n "$NAMESPACE" --timeout=120s
echo ""

# Step 2: Install dependencies in workspace (before checking Docker)
info "Step 2: Installing dependencies (docker CLI, openshell)..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c '
  apt-get update -qq && apt-get install -y -qq docker.io curl python3 python3-pip > /dev/null 2>&1

  # Install openshell CLI
  ASSET="openshell-x86_64-unknown-linux-musl.tar.gz"
  tmpdir="$(mktemp -d)"
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" -o "$tmpdir/$ASSET"
  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"

  echo "Installed: $(openshell --version)"
'
echo ""

# Step 3: Wait for Docker daemon
info "Step 3: Waiting for Docker daemon..."
for i in $(seq 1 30); do
  if kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- \
    docker info >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && fail "Docker daemon failed to start"
  echo "  Waiting for docker... ($i/30)"
  sleep 2
done
info "Docker daemon is ready"
echo ""

# Step 4: Copy NemoClaw source
info "Step 4: Copying NemoClaw source to pod..."
tar -C "$NEMOCLAW_DIR" --exclude='node_modules' --exclude='.git' -cf - . | \
  kubectl exec -i "$POD_NAME" -n "$NAMESPACE" -c workspace -- tar -C /workspace -xf -
echo ""

# Step 5: Build NemoClaw
info "Step 5: Building NemoClaw (npm install + build)..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c '
  cd /workspace
  npm install
  cd nemoclaw && npm install && npm run build
  echo "NemoClaw built successfully"
'
echo ""

# Step 6: Start OpenShell gateway
info "Step 6: Starting OpenShell gateway..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c "
  openshell gateway start --name $GATEWAY_NAME 2>&1 | head -20
"

# Wait for gateway to be healthy
for i in $(seq 1 10); do
  if kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- \
    openshell status 2>&1 | grep -q "Connected"; then
    break
  fi
  [ "$i" -eq 10 ] && fail "Gateway failed to become healthy"
  sleep 3
done
info "Gateway is healthy"
echo ""

# Step 7: Configure vLLM provider
info "Step 7: Configuring vLLM provider..."

# Test vLLM connectivity from inside the pod
if kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- \
  curl -sf --max-time 5 "${VLLM_ENDPOINT%/v1}/v1/models" >/dev/null 2>&1; then

  kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c "
    openshell provider create \
      --name dynamo-vllm \
      --type openai \
      --credential 'OPENAI_API_KEY=dummy' \
      --config 'OPENAI_BASE_URL=$VLLM_ENDPOINT' 2>&1 || true

    openshell inference set \
      --no-verify \
      --provider dynamo-vllm \
      --model '$VLLM_MODEL'
  "
  info "vLLM provider configured: $VLLM_MODEL"
else
  warn "vLLM endpoint not reachable at $VLLM_ENDPOINT"
  warn "Configure manually later with:"
  echo "  kubectl exec $POD_NAME -c workspace -- openshell provider create ..."
fi
echo ""

# Step 8: Show status
info "Step 8: Verifying setup..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- openshell status
echo ""

echo "=============================================="
info "Setup complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Create a NemoClaw sandbox:"
echo "   kubectl exec $POD_NAME -c workspace -- \\"
echo "     openshell sandbox create --from /workspace/Dockerfile --name nemoclaw"
echo ""
echo "2. Or create a basic sandbox and test inference:"
echo "   kubectl exec $POD_NAME -c workspace -- openshell sandbox create --name test -- bash"
echo "   kubectl exec -it $POD_NAME -c workspace -- openshell sandbox connect test"
echo ""
echo "3. Inside sandbox, test inference.local:"
echo "   curl -X POST https://inference.local/v1/chat/completions \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"model\":\"$VLLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'"
echo ""
echo "To cleanup:"
echo "   kubectl delete -f $SCRIPT_DIR/openshell-gateway.yaml"
