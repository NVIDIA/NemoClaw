# node-gyp build fixture

The build fixture is the unmodified `lib/build.js` from the SRI-verified npm 12.2.1 archive's node-gyp 13.0.0 package.
Its SHA-256 is `d11b1d799a2522bd38a364bc39d36175d9e68225e0e5a36d9fc3a64e1710fbc0`.
The adjacent LICENSE retains node-gyp's MIT terms.
The remediation test executes the patched module and checks both Windows build branches with native filesystem globbing.
