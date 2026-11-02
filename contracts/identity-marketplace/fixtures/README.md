# CBOR fixtures

`cbor-fixtures.json` holds the Plutus Data CBOR of sample values of the on-chain types. Codecs in other languages (TypeScript, Python) use it to check that they encode and decode the same bytes.

Each fixture has:

- `type`: the Aiken module and type;
- `cbor`: lowercase hex of `cbor.serialise(value)`, the on-chain encoding;
- `diagnostic`: `cbor.diagnostic(value)`, a readable form of the same data.

The values are built in [`lib/identity_marketplace/cbor_fixtures.ak`](../lib/identity_marketplace/cbor_fixtures.ak). The fixture name is the test name.

## Regenerate

Run from `contracts/identity-marketplace`, with aiken v1.1.21 on `PATH`:

```sh
node fixtures/generate.mjs
```

The script runs the fixture tests with `aiken check` and writes their traces to `cbor-fixtures.json`. The output is deterministic: the same types and values give the same file.

To check that the file is up to date (for example in CI):

```sh
node fixtures/generate.mjs --check
```

Regenerate the file after each change to a type or to a fixture value. Never edit it by hand.
