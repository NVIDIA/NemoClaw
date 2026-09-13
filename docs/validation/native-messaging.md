# Test native messaging

Run the isolated fixture to check actual OpenClaw messaging behavior without sending external messages.
This test does not qualify a real Telegram or WhatsApp account.
Use native Linux ARM64 and Docker with the [Fabric build prerequisites](../reference/dependencies.md#fabric-builds).

```sh
python3 image/fabric/build.py --harness openclaw
python3 tools/openclaw-native-test.py
```

This runs the actual Fabric and OpenClaw processes with local TLS Telegram and model protocol fixtures.
All messaging operations use `openclaw config`, `openclaw pairing`, `openclaw channels status`, or the native gateway CLI.
There is no channel-control extension in the image.
The test verifies enrollment, unauthorized sender rejection, two isolated conversations, real tool execution with independent file readback, readiness checks that preserve native settings, recreation, disable and invalid credential reporting while agent requests remain usable.

Only `/sandbox/.openclaw` and `/sandbox/workspace` survive recreation; the rest of the sandbox is fresh.
Both are required for native history/workspace continuity.
The containers have `--network none`.
`NET_ADMIN` is used only in their isolated namespace to add a loopback model alias compatible with native SSRF validation.
The fake token is writable solely for the negative credential test; no real token is read.
Containers are removed, and fixture traffic/process evidence remains under `.local/openclaw-native-UUID`.
These checks are not real Telegram qualification.

The opt-in `TestLiveFabric` separately checks direct OpenClaw CLI access through a real OpenShell deployment and live inference.
It changes native settings, performs unchanged apply and export/reapply, verifies those settings survive, sends a native agent request, and tears down its own resources.
Refer to the [Fabric live test](fabric.md#test-with-a-real-model).

If the test fails, inspect the printed `.local/openclaw-native-UUID` evidence before retrying.
The fixture removes its containers and retains logs and traffic evidence.
Do not substitute real messaging credentials into this fixture.
