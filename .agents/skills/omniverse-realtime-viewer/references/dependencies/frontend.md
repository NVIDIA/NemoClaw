# Frontend Dependencies

## Frontend Dependencies

Purpose: browser WebRTC client dependencies and optional generated viewer UI modules for streamed Omniverse Realtime Viewers. Do not install frontend streaming dependencies for local-only desktop Omniverse Realtime Viewers.

Read `nvidia-runtime.md` for the current `@nvidia/ov-web-rtc` package and
registry guidance. This file documents frontend behavior and validation only.

Use the generated frontend manifest:

```bash
cd frontend
npm install
```

The streaming-specific package provides `AppStreamer`. Configure it only for
standalone `ovstream` Direct connections, using the `ovstream` WebRTC browser
client example linked from `nvidia-runtime.md` as the connection-shape reference.

Shared viewer UI components are generated locally by the app when needed. They
are not an external dependency.

```text
frontend/src/viewer-ui/
```

Decision rules:

- If a viewer needs reusable hierarchy, inspector, asset, or backend-adapter UI,
  read `viewer-backend-interface` and generate the local files under
  `frontend/src/viewer-ui/`.
- If the viewer only needs a minimal WebRTC surface, do not create the local
  viewer UI module.
- Do not add a package dependency for shared viewer UI. Import generated
  components by relative path or by the app's local TypeScript path alias.

Verify package installation:

```bash
cd frontend
npm config get @nvidia:registry
npm ls @nvidia/ov-web-rtc
```

Verify the expected runtime imports in app code:

```bash
rg "AppStreamer|@nvidia/ov-web-rtc|ViewerBackend|StageTree|Inspector" frontend
```

Common failure modes:

- npm install fails: wrong npm registry configuration, proxy issue, lockfile
  issue, or misspelled package name.
- TypeScript cannot resolve the WebRTC package: dependency was installed in the wrong directory or the frontend lockfile is stale.
- TypeScript cannot resolve local viewer UI imports: generate
  `frontend/src/viewer-ui/` from `viewer-backend-interface`, or update the import path
  to the app's actual local module location.
- Browser connects with no video: usually the Direct connection config,
  ovstream server wiring, or frame submission path is wrong; read
  `references/streaming-client` and `references/streaming-server`.
- Frontend waits forever after connect: app sent messages before data-channel readiness or server did not push initial state.
