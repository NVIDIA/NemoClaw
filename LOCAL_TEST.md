# Run the Linux Docker experiment

Use Go 1.27.1, Docker, and the OpenShell 0.0.116 `openshell-gateway` executable.
For the external-gateway variants below, the gateway is a test prerequisite,
separate from the NemoClaw bundle. The managed Spark variant provisions it. Choose
an external inference server or the managed variant below. The configuration
is for one local developer: its user
API binds to loopback without TLS. Sandbox callbacks authenticate with JWTs.

From this checkout, create a private directory and gateway keys:

```sh
nc_test_dir="$(pwd)/.local/runtime"
mkdir -p "$nc_test_dir"
chmod 700 "$nc_test_dir"
openshell-gateway generate-certs --output-dir "$nc_test_dir/tls" --server-san 127.0.0.1
cat > "$nc_test_dir/gateway.toml" <<EOF
[openshell.drivers.docker]
network_name = "nc-prototype-test"
ssh_socket_path = "$nc_test_dir/ssh"

[openshell.gateway.gateway_jwt]
signing_key_path = "$nc_test_dir/tls/jwt/signing.pem"
public_key_path = "$nc_test_dir/tls/jwt/public.pem"
kid_path = "$nc_test_dir/tls/jwt/kid"
gateway_id = "nc-prototype-test"
ttl_secs = 0

[openshell.gateway.auth]
allow_unauthenticated_users = true
EOF
openshell-gateway --config "$nc_test_dir/gateway.toml" \
  --name nc-prototype-test --port 17671 --drivers docker --disable-tls \
  --db-url "sqlite:$nc_test_dir/gateway.db"
```

Leave that terminal running. In another terminal in this checkout, start Ollama
on the Docker bridge address. This address is reachable by both the gateway
and the sandbox supervisor. A host loopback address only reaches the gateway.
For managed inference, skip this external-server setup and follow the next section.

```sh
nc_test_dir="$(pwd)/.local/runtime"
nc_test_bridge="$(docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}')"
mkdir -p "$nc_test_dir/ollama"
docker run -d --name nc-prototype-test-ollama --network nc-prototype-test \
  -p "$nc_test_bridge:11436:11434" \
  -v "$nc_test_dir/ollama:/root/.ollama" \
  ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba
docker exec nc-prototype-test-ollama ollama pull qwen3.5:0.8b
docker exec nc-prototype-test-ollama ollama pull qwen3:0.6b
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
go run ./tools/bundle
cp examples/local.yaml .local/deployment.yaml
```

Edit `.local/deployment.yaml`: set the inference endpoint to
`http://BRIDGE_ADDRESS:11436/v1` and use the image digest printed above. Choose
a new deployment UUID before using the ordinary CLI. The live test generates
its own fresh UUIDs.

```sh
NEMOCLAW_LIVE_CONFIG="$(pwd)/.local/deployment.yaml" \
NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3:0.6b \
  go test -tags=live ./internal/engine -run TestLive -count=1 -v
```

The test creates two deployments, checks real inference, and deletes those
deployments after success. It prints the location of retained evidence. On
failure, it leaves the affected state and resources available for inspection.

For interactive experimentation, use the bundle's `bin/nemoclaw` with
`apply --state-dir .local/deployment --file .local/deployment.yaml`.
Use the same state directory for export and subsequent applies.

After a successful test, remove the Ollama test container with
`docker rm -f nc-prototype-test-ollama`. Stop the foreground gateway with Ctrl-C.
Remove the test network with `docker network rm nc-prototype-test` once no test
sandboxes remain. The model cache and gateway state remain in `.local/runtime`.

## Managed inference variant

Use the gateway setup above and an unused port on its Docker bridge. Build the
OpenClaw image and bundle, then copy the managed example:

```sh
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}'
go run ./tools/bundle
cp examples/managed-ollama.yaml .local/managed-deployment.yaml
```

Edit the copied YAML: set `ollama.network` to `nc-prototype-test`, use the printed
bridge address in the endpoint, and use the built OpenClaw image digest. Keep
the selected local engine socket explicit. Choose a fresh deployment UUID for
interactive use; the live test generates its own UUIDs.

```sh
NEMOCLAW_LIVE_CONFIG="$(pwd)/.local/managed-deployment.yaml" \
NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3.5:0.8b \
  go test -tags=live ./internal/engine -run TestLive -count=1 -v
```

This variant creates six resources and downloads the models into an owned named
volume. It checks an unchanged apply, stops Ollama, and expects planning to fail
because the model inventory is unknown. The test verifies unchanged state and
explicitly starts the same container to continue. It then checks a no-op apply,
model change with retained weights, export, and recreation with three agent replies.
The recreated deployment uses another free port on the same host.

On success the harness removes only its two deployments, Ollama containers, and
model volumes. Stop the foreground gateway and remove its test network afterward.
On failure it preserves resources and state for inspection. Reader tests cover
interrupted pull streams and cancellation; a real download interrupted through
OpenTofu remains a separate qualification scenario. This setup does not qualify
Podman, Docker Desktop, or native macOS/Windows operation.

## Managed DGX Spark recipe

This experiment requires Linux ARM64, a GB10 Spark with at least 118 GiB RAM,
NVIDIA driver 580 or newer, a working Docker GPU runtime, and adequate local disk.
Capacity checks account for remaining snapshot and preparation bytes plus a
16 GiB disk reserve. No host package installation or kernel tuning is performed.
`hostReserveGiB` constrains the requested GPU budget; the available/free memory
thresholds govern the resident watchdog.

Build the pinned model-specific artifact with Go 1.27.1:

```sh
go run ./tools/spark-runtime
docker image inspect nc-prototype-qwen38:spark-v1 --format '{{index .RepoDigests 0}}'
go run ./tools/bundle
```

The builder verifies the recipe archive, patches its pinned vLLM base, and packages
preparation tools and a static supervisor. It retains the recipe's AGPL license,
model source notices, original and patched source, and the supervisor's source.
It exports a timestamp-normalized OCI archive to `.build/spark/runtime.tar` and
loads it locally. It does not publish the image. The checked-in YAML contains the
resolved image digest for this source revision; compare the printed digest before
using a locally changed build. The OpenClaw image from `image/` must also be loaded
at the default digest recorded in the example.

Use a fresh deployment UUID when creating a separate experiment. The gateway port
and subnet must be unused. For the checked-in experiment:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/spark-deployment < examples/spark.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-deployment < examples/spark.yaml
dist/linux_arm64/bin/nemoclaw export --state-dir .local/spark-deployment > .local/spark-export.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-deployment < .local/spark-export.yaml
```

The snapshot is about 99 GiB and the packed PLE table about 27 GiB. Downloads use
four resumable streams with exact sizes and hashes. Only interrupted response
bodies get a bounded four-attempt retry, retaining progress between attempts.
Preparation verifies packed rows against the pinned source tensors before atomic
publication. The 30-minute inference startup budget starts after preparation;
downloads have their own eight-hour limit. Keep the state directory and both
Docker volumes. CLI interruption leaves the runtime supervisor and data intact.

Names derive from the deployment UID. For `examples/spark.yaml`, the inference
container is `nc-68d203b0c7e6083f-inference`; its data volume adds `-data`. The gateway
is `nc-68d203b0c7e6083f-gateway`, with its own data volume. Inspect only those owned
resources with `docker logs` and `docker inspect`. Ordinary apply retains data;
there is no pruning or destroy command in this experiment.

To qualify the watchdog shutdown without creating memory pressure, after a
successful apply send `docker kill --signal=USR1 nc-68d203b0c7e6083f-inference`.
The supervisor gracefully stops its inference process group and exits. Confirm
that the container stays stopped with restart policy `no`. Plan performs no
restart; explicit apply checks capacity and restarts the same container, reusing
verified model and preparation receipts. Runtime memory sampling continues after
a successful CLI exit, independently of health polling.

Deterministic fixtures cover download/preparation interruption, authentication and
transport failures, partial observations, ownership/configuration drift, capacity
rejection, immediate startup exit, and supervised child shutdown. The native
OpenTofu/provider integration suite remains `go test -tags=integration
./internal/engine -count=1`. Retained Spark live evidence is identified in
`VALIDATION.md`; fixture success alone does not establish GPU inference success.

The packed-data fixtures execute the actual packaged upstream preparation tool
and verifier on tiny safetensors, without GPU access or downloads:

```sh
docker run --rm --runtime=runc --network none --entrypoint python3 \
  --mount "type=bind,source=$PWD/test/spark_preparation_test.py,target=/test.py,readonly" \
  nc-prototype-qwen38:spark-v1 /test.py
```

The retained-deployment Spark qualification can run against the explicit YAML and
state directory above. It applies, checks an unchanged apply and export/reapply,
rejects excessive reserved capacity, trips the watchdog with `SIGUSR1`, verifies
a read-only restart plan, and explicitly recovers the same container. It checks
all eight resource IDs and artifact receipt hashes and modification times. It
leaves the running deployment and model data intact, and retains JSON evidence
and exported YAML in the selected state directory, including on failure.

After intentionally changing only the pinned runtime image in the YAML,
`TestLiveSparkArtifactChange` uses the same environment variables to verify a
read-only replacement plan, retained storage and OpenShell identities, actual
inference, unchanged apply, and export/reapply. It requires a previously successful
deployment and preserves both volumes.

```sh
NEMOCLAW_LIVE_SPARK_CONFIG="$(pwd)/examples/spark.yaml" \
NEMOCLAW_LIVE_SPARK_STATE="$(pwd)/.local/spark-deployment" \
  go test -tags=live ./internal/engine -run '^TestLiveSparkLifecycle$' -count=1 -timeout=3h -v
```

The early sandbox token-path failure exposed a separate OpenShell limit:
OpenShell 0.0.116 treats sandbox `Error` as terminal and has no public recovery
operation for that phase. Apply records the configured sandbox identity before
checking readiness and reports failure without recreating it. The initial
experiment required a controlled offline repair; fresh creation with the corrected
layout passed without repairs. This is recorded in `VALIDATION.md`, and is not
an automatic recovery feature.
