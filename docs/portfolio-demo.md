# Synthetic local portfolio demo

This is a small, provider-free walkthrough of the DigiBot Worker and its
Provenance Lens integration boundary. It is intended for a code review or
portfolio discussion, not for operating the private service.

The demo runs the existing Vitest tests against disposable local D1. The test
environments replace Telegram, R2, the provenance verifier, and the downloader
Container with in-process fakes. Test values are synthetic and are not usable
credentials. No bot token, Cloudflare account, production binding, private
media, browser cookies, Docker daemon, or live provider URL is needed.

## Run it

From the repository root, use Node.js 22.22.2 or newer and pnpm 11.19.0:

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/cloudflare-worker exec vitest run \
  tests/integration-http.test.ts \
  tests/integration-telegram.test.ts \
  tests/workflow-replay.test.ts \
  tests/integration-contract.test.ts
```

The selected tests use the repository's checked-in migrations and local D1
helper. They do not apply a migration to a remote database and do not call a
real provider.

## What the run demonstrates

| Scenario | Existing test coverage |
| --- | --- |
| Register a synthetic media operation, upload exact bytes, queue it, replay the same request, and reject a conflicting request | `integration-http.test.ts` — “registers, uploads, queues, replays, and conflicts through the real session boundary” |
| Complete a Download and then keep its completed outcome after deleting the saved Telegram copy | `integration-http.test.ts` — “preserves deliberate Download outcomes when its Telegram copy is deleted” |
| Run a controlled send failure and retain separate confirmed/failed statistics | the same Download test, using a mocked Telegram `sendDocument` rejection |
| Prove Download bypasses the provenance verifier | the same Download test; the mocked verifier call list remains empty while the Download completes |
| Reconcile an uncertain send by checking the current bot document and exact bytes, then retry only the cleanup path after a synthetic R2 deletion failure | `integration-telegram.test.ts` — “reconciles only a current-bot document whose downloaded bytes match the archive” and “repairs a reconciled download and releases its reservation only after the R2 delete” |
| Keep an ambiguous delivery state from being automatically replayed after a Workflow checkpoint is lost | `workflow-replay.test.ts` — “does not repeat delivery when the effect commits but its step checkpoint is lost” |
| Validate the checked-in Lens/DigiBot envelope, including a synthetic Check action and confirmed receipt | `integration-contract.test.ts` — “pins the shared bytes and projects a confirmed image receipt” |

All outcomes are local assertions. A passing run demonstrates the reviewed
source boundary and recovery rules; it does not prove that a deployment is
healthy or that Telegram, Cloudflare, a media provider, or the external
provenance service is available.

## Related source paths

- `apps/cloudflare-worker/src/integration.ts` — authenticated integration HTTP boundary.
- `apps/cloudflare-worker/src/integration-media.ts` — Check/Download processing and delivery state.
- `apps/cloudflare-worker/src/integration-telegram.ts` — Telegram admission, reconciliation, and cleanup.
- `apps/cloudflare-worker/tests/helpers/local-d1.ts` — disposable local D1 setup from checked-in migrations.
- `PUBLICATION_MANIFEST.md` — exact source base, included files, exclusions and verification record for this clean edition.
