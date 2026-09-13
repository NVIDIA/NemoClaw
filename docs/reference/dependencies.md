# Dependency sources

Read dependency versions from the checked-in build inputs and the artifacts you deploy.
Operating guides link to these sources so an upgrade does not require copying version numbers across pages.
Historical test records retain their exact versions and hashes.

## Find the pins

| Dependency or artifact | Authoritative input | Use |
| --- | --- | --- |
| Go and bundled executables | [versions.json](../../versions.json) | Select the Go toolchain and external gateway release; the bundle builder consumes the OpenTofu download URLs and hashes |
| Go modules, including the OpenShell SDK | [go.mod](../../go.mod) and [go.sum](../../go.sum) | Resolve module revisions and verify module contents |
| Direct OpenClaw base image | [image/Dockerfile](../../image/Dockerfile) | Build from the pinned upstream digest |
| Fabric and Hermes source archives | [Fabric builder](../../image/fabric/build.py) | Select source revisions and verify archive hashes |
| Fabric Python packages | [Recipe directory](../../image/fabric) | Use `dependencies.lock` or the selected recipe's `*-dependencies.lock` with wheel hashes |
| Fabric TypeScript packages | npm lockfiles in the verified Fabric archive | Build Pi from the same source revision as its adapter |
| Managed Ollama image | [managed-ollama.yaml](../../examples/managed-ollama.yaml) | Copy the complete immutable image reference for local service setup |
| Spark model and runtime | [spark.yaml](../../examples/spark.yaml), [runtime sources](../../runtimes/qwen38), and [artifact builder](../../tools/spark-runtime) | Inspect model pins, runtime inputs, and toolchain checks |

The source files also contain compatibility constraints; updating a version label alone does not update the implementation.
For example, align the Go module directive and artifact builders with the selected toolchain, and preserve the gateway SDK's inference API contract.

Print the tool releases from the repository root:

```sh
python3 -c 'import json; p = json.load(open("versions.json")); print("\n".join(f"{k}: {p[k]}" for k in ("go", "opentofu", "openshell", "openclaw", "ollama")))'
```

## Fabric builds

Install Docker, uv, and a native C/Rust build toolchain on Linux ARM64.
Use the Python version selected by the `uv --python` arguments in [the builder](../../image/fabric/build.py) for adapter tests.
The builder asks uv to select that interpreter for its build and download environments.
Maturin can provision Rust in its cache.
Recipe-specific Dockerfiles define the interpreter and native libraries installed in the image.

## Inspect deployed artifacts

The bundle's `manifest.json` records the executables and hashes it verifies before an operation.
Each Fabric image records its source revision, runtime version, and installation-lock hash in `/opt/nemoclaw/provenance.json`.
For a locally available Fabric image, inspect that metadata without networking:

```sh
docker run --rm --network none --entrypoint cat nc-prototype-fabric:codex /opt/nemoclaw/provenance.json
```

Replace `codex` with the recipe tag you built, or use the exact deployed digest.
A local build tag is a lookup name, not a deployment pin.
Use the immutable reference printed by the builder or `docker image inspect` in deployment YAML.

## Maintain documentation during upgrades

Update build inputs, lockfiles, and relevant examples, then run the tests for the affected boundary.
Change operating documentation when behavior, prerequisites, or compatibility constraints change.
Do not add duplicate release numbers or image hashes to procedures or adapter tables.
Keep API/schema versions and hardware requirements where they explain a real compatibility boundary.
Keep dated evidence immutable; a dependency upgrade requires new evidence rather than edited historical results.
