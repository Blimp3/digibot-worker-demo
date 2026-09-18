# DigiBot Worker demo edition manifest

Prepared locally on 2026-09-17; MIT licensing added on 2026-09-18. This is a review artifact, not a published
repository, release, deployment, or live-service check.

## Source identity

- Private source base: `1ac609e85ba424002b51e1958706616ca75e1ea7`.
- Copied local test delta: the provider-bypass assertion in
  `apps/cloudflare-worker/tests/integration-http.test.ts`; the private-worktree
  binary diff SHA-256 was
  `3685f19304d87264403b235115d3b5f25e7b97b62ee14545308801aaa88eeabf`.
- Clean-edition source-set SHA-256:
  `78fd730fab08d69827a058607f6de577c5581d3ab8ac9d644e0ba81512617947`.
  This digest covers the sorted SHA-256 listing of the 81 edition files present
  before this manifest, excluding dependency/install output.
- No private Git history, remote, commit, tag, release, or artifact was copied.

## Included file allowlist

- Root: `.gitignore`, `LICENSE`, `README.md`, `SECURITY.md`, `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `eslint.config.mjs`,
  `tsconfig.json`, and `tsconfig.base.json`.
- Documentation: `docs/portfolio-demo.md` and this manifest.
- Secret check: `scripts/scan-secrets.sh`.
- Worker configuration: `apps/cloudflare-worker/package.json`,
  `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`, the sanitized
  `worker-configuration.d.ts`, and `wrangler.demo.example.jsonc`.
- Worker implementation: every `apps/cloudflare-worker/src/*.ts` file from the
  reviewed source base.
- Local schema: every `apps/cloudflare-worker/migrations/*.sql` file from the
  reviewed source base.
- Tests: `integration-http.test.ts`, `integration-telegram.test.ts`,
  `workflow-replay.test.ts`, `integration-contract.test.ts`,
  `helpers/fixed-length-stream.ts`, `helpers/local-d1.ts`, and
  `fixtures/integration-envelope-v1.json`.

The complete 82-file allowlist for this prepared edition is:

```text
.gitignore
LICENSE
PUBLICATION_MANIFEST.md
README.md
SECURITY.md
apps/cloudflare-worker/eslint.config.mjs
apps/cloudflare-worker/migrations/0001_initial.sql
apps/cloudflare-worker/migrations/0002_atomic_job_admission.sql
apps/cloudflare-worker/migrations/0008_job_dispatch_delivery_recovery.sql
apps/cloudflare-worker/migrations/0009_telegram_notices.sql
apps/cloudflare-worker/migrations/0010_delivery_retry_metadata.sql
apps/cloudflare-worker/migrations/0011_scoped_media_cache_index.sql
apps/cloudflare-worker/migrations/0012_trim_bounds.sql
apps/cloudflare-worker/migrations/0013_transcription_operation_admission.sql
apps/cloudflare-worker/migrations/0014_source_captions.sql
apps/cloudflare-worker/migrations/0015_job_queue.sql
apps/cloudflare-worker/migrations/0016_video_quality_prompts.sql
apps/cloudflare-worker/migrations/0017_telegram_file_sources.sql
apps/cloudflare-worker/migrations/0018_clip_packs.sql
apps/cloudflare-worker/migrations/0019_youtube_collection_lookups.sql
apps/cloudflare-worker/migrations/0020_integration_accounts.sql
apps/cloudflare-worker/migrations/0021_integration_operations.sql
apps/cloudflare-worker/package.json
apps/cloudflare-worker/src/config.ts
apps/cloudflare-worker/src/container-contract.ts
apps/cloudflare-worker/src/container.ts
apps/cloudflare-worker/src/crypto.ts
apps/cloudflare-worker/src/db.ts
apps/cloudflare-worker/src/diagnostics.ts
apps/cloudflare-worker/src/dispatch.ts
apps/cloudflare-worker/src/downloader-storage.ts
apps/cloudflare-worker/src/errors.ts
apps/cloudflare-worker/src/history.ts
apps/cloudflare-worker/src/index.ts
apps/cloudflare-worker/src/integration-audio.ts
apps/cloudflare-worker/src/integration-auth.ts
apps/cloudflare-worker/src/integration-io.ts
apps/cloudflare-worker/src/integration-media.ts
apps/cloudflare-worker/src/integration-store.ts
apps/cloudflare-worker/src/integration-telegram.ts
apps/cloudflare-worker/src/integration-verifier.ts
apps/cloudflare-worker/src/integration-workflow.ts
apps/cloudflare-worker/src/integration.ts
apps/cloudflare-worker/src/logging.ts
apps/cloudflare-worker/src/mini-app-auth.ts
apps/cloudflare-worker/src/mini-app-authorization.ts
apps/cloudflare-worker/src/mini-app-router.ts
apps/cloudflare-worker/src/mini-app.ts
apps/cloudflare-worker/src/notices.ts
apps/cloudflare-worker/src/r2.ts
apps/cloudflare-worker/src/retired-durable-objects.ts
apps/cloudflare-worker/src/security.ts
apps/cloudflare-worker/src/sources.ts
apps/cloudflare-worker/src/stats.ts
apps/cloudflare-worker/src/telegram-user-ids.ts
apps/cloudflare-worker/src/telegram.ts
apps/cloudflare-worker/src/transcript-search.ts
apps/cloudflare-worker/src/trim.ts
apps/cloudflare-worker/src/types.ts
apps/cloudflare-worker/src/url.ts
apps/cloudflare-worker/src/webhook.ts
apps/cloudflare-worker/src/workflow.ts
apps/cloudflare-worker/src/youtube-collection.ts
apps/cloudflare-worker/tests/fixtures/integration-envelope-v1.json
apps/cloudflare-worker/tests/helpers/fixed-length-stream.ts
apps/cloudflare-worker/tests/helpers/local-d1.ts
apps/cloudflare-worker/tests/integration-contract.test.ts
apps/cloudflare-worker/tests/integration-http.test.ts
apps/cloudflare-worker/tests/integration-telegram.test.ts
apps/cloudflare-worker/tests/workflow-replay.test.ts
apps/cloudflare-worker/tsconfig.json
apps/cloudflare-worker/vitest.config.ts
apps/cloudflare-worker/worker-configuration.d.ts
apps/cloudflare-worker/wrangler.demo.example.jsonc
docs/portfolio-demo.md
eslint.config.mjs
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/scan-secrets.sh
tsconfig.base.json
tsconfig.json
```

## Transformations

- Removed every build, development, deployment, remote-migration, and Wrangler
  type-generation script. `pnpm check` now runs only lint, TypeScript, the four
  selected tests, and the redacted-path secret scan.
- Replaced both package names with local demo names while retaining
  `private: true`; the owner selected MIT for original demo code on 2026-09-18.
- Replaced the operational extension origin in the copied integration test.
- Removed the private Wiki link from the copied help text.
- Replaced the generated Worker type snapshot's operational extension IDs,
  Worker URL, R2 endpoint/bucket, verifier service name, and production hash
  with synthetic values.
- Added a non-production Wrangler example with `workers_dev` and preview URLs
  disabled, observability disabled, no cron triggers, an all-zero D1 ID, and
  example-only service/storage values. No command consumes this file.
- Changed the simple secret scanner to print matching paths only, never the
  suspected value.

## Deliberately excluded

- `.git`, branches, tags, pull-request history, releases, Wiki and Actions
  artifacts.
- `.codex`, `AGENTS.md`, the historical Gitleaks allowlist, real or example
  environment files, the operational Wrangler file, and all deploy workflows.
- `ROADMAP.md`, `CHANGELOG.md`, operational/release/measurement/runbook docs,
  remote-operation scripts, and production health/migration helpers.
- The Python downloader and transcription Container, Dockerfiles, models,
  provider tooling, media, logs, build output, caches and installed packages.
- Every Worker test outside the seven exact test/helper/fixture files listed
  above.

## Verification

Passed in this directory with Node.js 22.22.3 and pnpm 11.19.0:

```text
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` passed Worker lint, strict TypeScript, 21 tests in four files, and
the path-only high-confidence secret scan. `pnpm audit --audit-level high`
reported zero high or critical advisories and two moderate advisories.

Gitleaks v8.29.1 scanned the exact edition directory with full redaction and
reported zero findings. A separate exact-identifier scan found none of the
reviewed production Worker/R2/D1/extension/service identifiers or the private
repository URL.

This edition has no Git history, so there is no edition history to scan. The
source repository's reachable remote history was reviewed separately and is
not imported here.

## Publication status

The owner selected the MIT License for the original demo code on 2026-09-18.
The root `LICENSE`, root/Worker package metadata and README record that choice;
third-party terms remain separate. The licence edits did not change runtime
source or dependency resolutions; the application checks above were run on
2026-09-17. This is a local, licensed publication candidate, not a published
repository or deployed service.

Publish only this explicit source set in a separate public repository. The
private operational repository, its history and its excluded artifacts are
not cleared for a visibility change. `private: true` prevents accidental npm
publication and does not control GitHub repository visibility.
