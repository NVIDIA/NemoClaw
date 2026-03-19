#!/bin/bash
# NemoClaw Installer - One-command deployment of NemoClaw on Kubernetes
#
# Usage:
#   ./install.sh
#
# Or with custom endpoint:
#   DYNAMO_ENDPOINT=http://my-vllm:8000/v1 ./install.sh
#
# Options:
#   --cleanup    Remove existing NemoClaw deployment before installing
#   --dry-run    Show what would be done without making changes
#   --help       Show this help message
#
set -euo pipefail

# Configuration
NAMESPACE="${NAMESPACE:-nemoclaw}"
POD_NAME="${POD_NAME:-nemoclaw}"
DYNAMO_ENDPOINT="${DYNAMO_ENDPOINT:-}"
DYNAMO_MODEL="${DYNAMO_MODEL:-meta-llama/Llama-3.1-8B-Instruct}"
SANDBOX_NAME="${SANDBOX_NAME:-my-assistant}"

# Flags
CLEANUP=false
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${GREEN}[NemoClaw]${NC} $1"; }
warn() { echo -e "${YELLOW}[NemoClaw]${NC} $1"; }
error() { echo -e "${RED}[NemoClaw]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}${BOLD}==> $1${NC}"; }

usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
    --cleanup    Remove existing NemoClaw deployment before installing
    --dry-run    Show what would be done without making changes
    --help       Show this help message

Environment Variables:
    DYNAMO_ENDPOINT   URL to Dynamo/vLLM endpoint (required)
    DYNAMO_MODEL      Model name (default: meta-llama/Llama-3.1-8B-Instruct)
    NAMESPACE         Kubernetes namespace (default: nemoclaw)
    SANDBOX_NAME      Name for your AI sandbox (default: my-assistant)

Example:
    DYNAMO_ENDPOINT=http://vllm.dynamo.svc:8000/v1 $0
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --cleanup) CLEANUP=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --help|-h) usage ;;
        *) error "Unknown option: $1. Use --help for usage." ;;
    esac
done

echo ""
echo "NemoClaw on Kubernetes - Installer"
echo ""

# ============================================================================
# PREFLIGHT CHECKS
# ============================================================================
step "Preflight checks"

# Check kubectl
if ! command -v kubectl >/dev/null 2>&1; then
    error "kubectl not found. Please install kubectl first."
fi
info "kubectl found: $(kubectl version --client --short 2>/dev/null || kubectl version --client -o json | grep gitVersion | head -1)"

# Check cluster access
if ! kubectl cluster-info >/dev/null 2>&1; then
    error "Cannot connect to Kubernetes cluster. Check your kubeconfig."
fi
info "Cluster accessible: $(kubectl config current-context)"

# Check for required DYNAMO_ENDPOINT
if [[ -z "$DYNAMO_ENDPOINT" ]]; then
    echo ""
    warn "DYNAMO_ENDPOINT not set!"
    echo ""
    echo "NemoClaw requires a Dynamo/vLLM endpoint for inference."
    echo ""
    echo "Set the endpoint and try again:"
    echo "  export DYNAMO_ENDPOINT=http://your-vllm-service.namespace.svc:8000/v1"
    echo "  $0"
    echo ""
    echo "Or find your Dynamo service:"
    echo "  kubectl get svc -A | grep -i vllm"
    echo ""
    exit 1
fi
info "Dynamo endpoint: $DYNAMO_ENDPOINT"

# Validate endpoint URL format
if [[ ! "$DYNAMO_ENDPOINT" =~ ^https?:// ]]; then
    error "DYNAMO_ENDPOINT must start with http:// or https://"
fi

# Check for existing deployment
EXISTING_POD=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found -o name 2>/dev/null || true)
if [[ -n "$EXISTING_POD" ]]; then
    POD_STATUS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    warn "Existing NemoClaw pod found (status: $POD_STATUS)"

    if [[ "$CLEANUP" == "true" ]]; then
        info "Cleanup flag set - will remove existing deployment"
    else
        echo ""
        echo "Options:"
        echo "  1. Run with --cleanup to remove and reinstall"
        echo "  2. Connect to existing: kubectl exec -it $POD_NAME -n $NAMESPACE -c workspace -- bash"
        echo ""
        read -p "Remove existing deployment and reinstall? [y/N] " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            CLEANUP=true
        else
            info "Keeping existing deployment. Exiting."
            exit 0
        fi
    fi
fi

# Test Dynamo endpoint reachability (from a temporary pod)
info "Testing Dynamo endpoint reachability..."
if kubectl run nemoclaw-preflight --image=curlimages/curl --rm -i --restart=Never \
    --namespace=default --quiet -- \
    curl -sf --max-time 10 "${DYNAMO_ENDPOINT%/v1}/v1/models" >/dev/null 2>&1; then
    info "Dynamo endpoint is reachable"
else
    warn "Could not reach Dynamo endpoint from cluster"
    warn "This might be OK if the endpoint is only reachable from specific namespaces"
    echo ""
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Show configuration
echo ""
echo "Configuration:"
echo "  Namespace:       $NAMESPACE"
echo "  Pod Name:        $POD_NAME"
echo "  Dynamo Endpoint: $DYNAMO_ENDPOINT"
echo "  Model:           $DYNAMO_MODEL"
echo "  Sandbox Name:    $SANDBOX_NAME"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    info "Dry run - no changes will be made"
    exit 0
fi

# ============================================================================
# CLEANUP (if requested)
# ============================================================================
if [[ "$CLEANUP" == "true" ]]; then
    step "Cleanup: Removing existing deployment"
    kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true 2>/dev/null || true
    info "Cleanup complete"
fi

# ============================================================================
# INSTALLATION
# ============================================================================
step "Step 1/5: Creating namespace"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
info "Namespace '$NAMESPACE' ready"

step "Step 2/5: Deploying NemoClaw pod"
# Apply the manifest with environment variable substitution
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: $POD_NAME
  namespace: $NAMESPACE
  labels:
    app: nemoclaw
spec:
  containers:
    - name: dind
      image: docker:24-dind
      securityContext:
        privileged: true
      env:
        - name: DOCKER_TLS_CERTDIR
          value: ""
      command: ["dockerd", "--host=unix:///var/run/docker.sock"]
      volumeMounts:
        - name: docker-storage
          mountPath: /var/lib/docker
        - name: docker-socket
          mountPath: /var/run
        - name: docker-config
          mountPath: /etc/docker
      resources:
        requests:
          memory: "8Gi"
          cpu: "2"
    - name: workspace
      image: node:22
      command: ["sleep", "infinity"]
      workingDir: /workspace
      env:
        - name: DOCKER_HOST
          value: unix:///var/run/docker.sock
        - name: NEMOCLAW_NON_INTERACTIVE
          value: "1"
        - name: NEMOCLAW_PROVIDER
          value: "dynamo"
        - name: NEMOCLAW_DYNAMO_ENDPOINT
          value: "$DYNAMO_ENDPOINT"
        - name: NEMOCLAW_DYNAMO_MODEL
          value: "$DYNAMO_MODEL"
        - name: NEMOCLAW_SANDBOX_NAME
          value: "$SANDBOX_NAME"
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: nemoclaw-state
          mountPath: /root/.openshell
        - name: docker-socket
          mountPath: /var/run
        - name: docker-config
          mountPath: /etc/docker
      resources:
        requests:
          memory: "2Gi"
          cpu: "1"
  initContainers:
    - name: init-docker-config
      image: busybox
      command: ["sh", "-c", "echo '{\"default-cgroupns-mode\":\"host\"}' > /etc/docker/daemon.json"]
      volumeMounts:
        - name: docker-config
          mountPath: /etc/docker
  volumes:
    - name: docker-storage
      emptyDir: {}
    - name: docker-socket
      emptyDir: {}
    - name: docker-config
      emptyDir: {}
    - name: workspace
      emptyDir: {}
    - name: nemoclaw-state
      emptyDir: {}
  restartPolicy: Never
EOF

info "Pod created, waiting for ready state..."
kubectl wait --for=condition=Ready "pod/$POD_NAME" -n "$NAMESPACE" --timeout=180s
info "Pod is ready"

step "Step 3/5: Installing prerequisites and waiting for Docker"
info "Installing docker CLI and socat..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c '
    apt-get update -qq && apt-get install -y -qq docker.io socat curl >/dev/null 2>&1
' || error "Failed to install prerequisites"

info "Waiting for Docker daemon..."
for i in $(seq 1 30); do
    if kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- docker info >/dev/null 2>&1; then
        break
    fi
    [[ "$i" -eq 30 ]] && error "Docker daemon failed to start after 60 seconds"
    echo "  Waiting for Docker... ($i/30)"
    sleep 2
done
info "Docker daemon is ready"

step "Step 4/5: Installing NemoClaw"
info "This may take a few minutes on first run..."

kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- bash -c '
    set -e

    # Extract host:port from endpoint
    ENDPOINT="${NEMOCLAW_DYNAMO_ENDPOINT:-http://localhost:8000/v1}"
    HOST_PORT=$(echo "$ENDPOINT" | sed "s|^http://||" | sed "s|/v1$||")

    # Start socat proxy in background
    pkill -f "socat.*TCP-LISTEN:8000" 2>/dev/null || true
    nohup socat TCP-LISTEN:8000,fork,reuseaddr TCP:$HOST_PORT >/dev/null 2>&1 &
    sleep 1
    echo "socat proxy started: localhost:8000 -> $HOST_PORT"

    # Update endpoint to use host.openshell.internal (reachable from k3s)
    export NEMOCLAW_DYNAMO_ENDPOINT="http://host.openshell.internal:8000/v1"

    # Install OpenShell CLI
    echo "Installing OpenShell CLI..."
    ASSET="openshell-x86_64-unknown-linux-musl.tar.gz"
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" -o /tmp/$ASSET
    tar xzf /tmp/$ASSET -C /tmp
    install -m 755 /tmp/openshell /usr/local/bin/openshell
    echo "OpenShell version: $(openshell --version)"

    # Clone NemoClaw with Dynamo support (PR #365)
    echo "Cloning NemoClaw with Dynamo support..."
    cd /workspace
    git clone --depth 1 --branch rwipfelnv/dynamo-support https://github.com/rwipfelnv/NemoClaw.git nemoclaw-src
    cd nemoclaw-src

    # Build NemoClaw
    echo "Building NemoClaw..."
    npm install --silent
    cd nemoclaw && npm install --silent && npm run build

    # Run onboard
    echo "Running NemoClaw onboard..."
    node ./bin/nemoclaw.js onboard
'

step "Step 5/5: Verifying installation"
kubectl exec "$POD_NAME" -n "$NAMESPACE" -c workspace -- nemoclaw "$SANDBOX_NAME" status 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}============================================${NC}"
echo -e "${GREEN}${BOLD}  NemoClaw installation complete!${NC}"
echo -e "${GREEN}${BOLD}============================================${NC}"
echo ""
echo "Connect to your AI sandbox:"
echo -e "  ${BOLD}kubectl exec -it $POD_NAME -n $NAMESPACE -c workspace -- nemoclaw $SANDBOX_NAME connect${NC}"
echo ""
echo "Once inside, try:"
echo "  openclaw tui              # Interactive chat"
echo "  openclaw agent -m 'Hi!'   # Quick command"
echo ""
echo "Useful commands:"
echo "  nemoclaw $SANDBOX_NAME status   # Check sandbox status"
echo "  nemoclaw $SANDBOX_NAME logs -f  # View logs"
echo "  openshell sandbox list          # List all sandboxes"
echo ""
