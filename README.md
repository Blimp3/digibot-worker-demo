# DigiBot Worker synthetic demo

This is a local, provider-free code-review edition of the DigiBot Cloudflare
Worker. It demonstrates the integration boundary, disposable D1 state,
delivery reconciliation, and replay safety using synthetic fixtures and
in-process fakes.

It does not contain the operational repository history, production Wrangler
configuration, Cloudflare resource identifiers, deployment workflows,
container implementation, credentials, private media, or live-provider tests.
It is not deployable as copied. See [the demo guide](docs/portfolio-demo.md)
and [the publication manifest](PUBLICATION_MANIFEST.md).

## Run

Use Node.js 22.22.2 or newer and pnpm 11.19.0:

```bash
pnpm install --frozen-lockfile
pnpm check
```

The tests use local Miniflare D1 plus fake Telegram, R2, verifier, and Container
boundaries. A passing run is local source evidence only.

## Rights status

Original DigiBot demo source in this edition is licensed under the MIT License;
see [LICENSE](LICENSE). This grant covers the project source and documentation
authored for the demo. Third-party dependencies and files carrying their own
license notices retain their separate terms. The operational repository, its
history and private artifacts are excluded from this source edition.
