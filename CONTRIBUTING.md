# Contributing

Thanks for helping. A few rules keep the anchors that are already on chain verifiable.

## Format v1 is frozen

Do not change anything that alters bytes or hashes: canonical serialization, leaf and node hashing, tree construction,
proof shape, pseudonym derivations, leaf schemas or the memo grammar. Such a change would make existing anchors fail to
verify. A change like that needs a new format version and is a decision for the maintainers, not a pull request.

`test-vectors/v1.json` is append-only. Never edit an existing vector. New vectors are added through
`scripts/gen-vectors.mjs` (which computes them from the spec independently of the SDK), and the pinned SHA-256 in
`packages/verify/src/__tests__/vectors.test.ts` is updated in the same change. The ChartRunner app pins the same hash, so
maintainers have to update both sides together.

## Welcome changes

- Clearer wording in SPEC.md, as long as it describes the existing behavior exactly.
- Tests, especially new vectors for edge cases.
- Bug fixes in the verifier that make it stricter or clearer without changing any hash.
- Verifier ports to other languages (please test them against `test-vectors/v1.json`).

## Development

Node per `.node-version`, pnpm per `packageManager` in `package.json`.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm vectors:check
pnpm examples
```

Keep `@chartrunner/verify` free of runtime dependencies. Do not commit secrets, keys, `.env` files, wallet addresses of
real people or personal data; synthetic data only in tests and examples.

By contributing you agree that your contribution is licensed under the Apache License 2.0.
