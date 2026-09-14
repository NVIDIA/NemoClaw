# Agent runtime sources

These native OpenClaw and Fabric recipes retain the implementation from the
Go prototype at `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`. They remain runtime
Python and JavaScript because they integrate with the agents' native APIs;
the desired-state SDK, CLI, provider, and Spark supervisor are Rust.

`fabric/build.py` pins the Fabric source archive, harness versions, dependency
hashes, and base images. Installed wheels retain package license metadata.
The local OpenClaw adapter is part of this Apache-2.0 repository. It is not an
adapter supplied by upstream Fabric. Original source headers are retained.

The native messaging fixture uses fake Telegram and inference endpoints inside
a container with networking disabled. It sends no external messages. Its
configuration and recreation phases exercise real native OpenClaw processes.
The other harness fixtures also use local protocol servers with networking
disabled. Fixture evidence does not establish model quality or live inference.
