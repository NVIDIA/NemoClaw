# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile.
FROM ollama/ollama@sha256:4c5b27871a3239a717048f9b93057680a51b60c8119a7016aebb57f938e25e35
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/ollama/NOTICE.md image/ollama/Dockerfile /opt/nemoclaw/source/
ADD --chmod=0644 --checksum=sha256:5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226 \
    https://raw.githubusercontent.com/ollama/ollama/f52b9e742d8c9a308f7b23cd1f0ab52c7ddb694d/LICENSE \
    /opt/nemoclaw/source/ollama-LICENSE
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="ollama"
