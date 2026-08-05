# skym service

Hosted charts, accounts, and the remote command queue for `skym-flow`. Deploys to Railway; the database is the source of truth and local `.flows/` becomes optional.

## Status

Milestone 2. What works today: schema and migrations, op ingest, device-code pairing, agent tokens, chart attach/list/read, OAuth sign-in, the hosted viewer, figure blob upload, and the marketing/dashboard/settings pages. **Not built yet:** the command queue endpoints.

## Design notes

**The op log is the source of truth.** A chart's graph is the fold of its ops; there is no graph column, because a snapshot is a cache we can always rebuild.

**`seq` is assigned by the server, never the client.** Two agents editing one chart both propose the same next number — the local store derived it from its own revision counter and could not see the collision. The client's value is a hint; ingest renumbers.

**Ingest is idempotent.** Ops carry a client-minted `Entry.id`, unique per chart. A retried batch is skipped rather than re-applied — `figure.add` appends, so re-applying would duplicate figures and double-count events.

**Validation reruns server-side.** Cycle detection, node/edge ceilings, and bullet shape live in `skym-flow/validate`, which both the MCP server and this service call. A relay must not trust what it is sent. One bad op is rejected individually; the rest of the batch still lands.

**Accounts link on verified email only.** An unverified provider email creates a separate account. Anything else means signing up at a provider with someone else's address inherits their charts.

**Figure bytes travel outside the op log.** A `figure.add` op carries only a filename, so ops alone leave the hosted viewer with a reference and nothing to render. The agent uploads blobs on a separate route after its ops land, asking `/figures/missing` first so a resumed sync re-sends ops (cheap, idempotent) but not megabytes. Blobs are keyed by chart id, so one chart's upload can never overwrite another's whatever filename the agent sends.

**Figures are private.** `/assets/<file>?chart=<id>` requires a principal who can see that chart — the same check the graph route makes. Serving them as static files would make every chart's evidence world-readable to anyone who guessed a name.

**Storage is capped by refusal, not eviction.** A user's blobs are summed across the charts they own and checked before the write, so a refused upload leaves nothing on the volume. Nothing already stored is ever deleted to make room: a figure is the evidence behind a result, and evicting one would leave the node asserting a finding whose proof is a broken image. Replacing an existing file is charged only the difference, or correcting a figure would be impossible at the ceiling. The agent treats 507 as terminal and reports it rather than retrying.

**Quota is per user, resolved at check time.** `users.plan` names the tier and the bytes each tier grants live in config (`STORAGE_QUOTA_FREE`, `STORAGE_QUOTA_PRO`), so repricing a plan is a redeploy rather than a migration. `users.storage_limit_bytes` overrides the plan for one account — comping an individual should not require inventing a tier. An unrecognised plan falls back to free, never to unlimited: a typo must not hand out free storage.

## Running locally

```bash
export DATABASE_URL=postgres://localhost:5432/skym
npm install && npm run build && npm start
```

Migrations run on boot — Railway runs the container and nothing else, so a separate migrate step would be skipped.

## Tests

```bash
npm test                                         # pure logic only
TEST_DATABASE_URL=postgres://... npm test        # plus ingest and figure integration
```

The ingest and figure tests **skip loudly without `TEST_DATABASE_URL`** rather than passing vacuously. They cover the guarantees that only a real database exercises: seq assignment under collision, idempotent redelivery, server-side validation, partial-batch acceptance, and figure storage isolation between charts. A green run without a database does not mean either is verified.

## Railway

Attach a Postgres service (injects `DATABASE_URL`) and mount a volume for figures. Set `PUBLIC_URL` to the stable domain — pairing URLs and OAuth callbacks are built from it, and guessing from the request host is wrong behind a proxy.

The container filesystem is ephemeral: blobs written outside the mounted volume disappear on the next deploy. `BLOB_DIR` must point inside it.
