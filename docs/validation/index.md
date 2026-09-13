# Validation results and limits

The recorded tests cover native Linux ARM64 deployment, selected agent operations, and retained-state recovery.
Results apply to their recorded revisions and test conditions; they do not qualify arbitrary Fabric features or other runtime platforms.
The complete [dated validation log](../archive/validation-log.md) preserves failures, repairs, manifests, and timings.

## Evidence by boundary

| Boundary | Recorded evidence | What remains unproven |
| --- | --- | --- |
| Ten Fabric recipes at pinned revision `51a28c1` | [Adapter matrix](evidence/fabric-adapter-matrix-linux-arm64.json): all seven added adapters built and passed isolated and real OpenShell lifecycle tests with fixture inference | Hosted Anthropic/OpenAI authentication, real model tool selection, every workflow or catalog profile |
| Deep Agents and Hermes | [Deep Agents](evidence/fabric-linux-arm64.json), [Hermes](evidence/fabric-hermes-linux-arm64.json): real Ollama/Qwen3 replies and stable identities | General tools, optional integrations, other platforms; some invocation paths in these records are retired |
| Hermes tools | [Tool evidence](evidence/fabric-hermes-tools-linux-arm64.json): terminal and file effects independently verified with Qwen3 4B | General task reliability; smaller-model failures are retained; the old tool-test environment mode is retired |
| Local OpenClaw adapter | [Tool and lifecycle evidence](evidence/fabric-openclaw-linux-arm64.json): real `exec`/`read` effects and stable gateway identity | General code generation, browser, MCP, and streaming |
| Native OpenClaw messaging | [Native-interface evidence](evidence/openclaw-native-interfaces-linux-arm64.json): actual processes, local Telegram/model fixtures, native settings and state continuity | Real Telegram/WhatsApp delivery and ordinary OpenShell messaging infrastructure |
| Managed DGX Spark | [Spark evidence](evidence/spark-linux-arm64.json): real replies, verified artifacts, no-op/export, watchdog recovery, and explicit artifact change | Other GPUs, Podman, Docker Desktop, terminal OpenShell error recovery |
| Teardown | [Destroy evidence](evidence/destroy-linux-arm64.json): native managed gateway/sandbox teardown and reapply; Docker fixtures for inference-process removal | Live destruction of the primary large-model process; combined Ollama teardown |
| Managed Ollama | [Historical Ollama evidence](evidence/managed-ollama-linux-arm64.json): create, model changes, and recreation | Ordinary repair of a stopped server; live qualification of revisions after the recorded run |
| Bundle platforms | [Build records](../archive/validation-log.md#current-direct-reader-validation): five targets build and pass checksum checks | Native macOS, Windows, Linux AMD64, and Podman runtime behavior |

The adapter expansion recorded at commit `4a04e0a1821608e88954bacf3089f96bdf09a809` passed Go unit tests, vet, two Python recipe tests, and the native provider integration suite in 58.445 seconds.
The native bundle was rebuilt before that integration run.
Its seven OpenShell adapter runs took 4.20–11.35 seconds each with deterministic inference fixtures.
Earlier live-model evidence is separate and must not be read as live-model qualification of those seven adapters.

## Interpret and reproduce results

Fixtures prove the exercised protocol and failure boundaries, not model quality or isolation across every platform.
Cross-compilation proves build availability, not runtime behavior.
Historical repairs and retired APIs are labeled in the archive; they are not supported recovery procedures.
The structured evidence files retain their original bytes and local artifact paths.
Some full logs and secret-bearing backups remain local and are not committed.

Use [Run tests](run-tests.md), [Fabric tests](fabric.md), [native messaging tests](native-messaging.md), and [Spark tests](spark.md) to reproduce the relevant checks.
