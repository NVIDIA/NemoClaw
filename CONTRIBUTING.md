# Contribute to the prototype

Keep changes within the [local experiment's scope](docs/architecture/decisions.md).
This checkout has an independent implementation; the documentation and release tooling on `main` do not apply automatically.

1. [Build the bundle](docs/get-started/build.md).
2. Read [AGENTS.md](AGENTS.md) before changing code.
3. Run the [checks appropriate to your change](docs/validation/run-tests.md).
4. Update the canonical documentation owner and follow the [writing guide](docs/contributing/writing.md).

Live tests create real resources and can use paid inference.
Run them only with the explicit configuration described in the test guides.
Keep work local unless publication is authorized.
