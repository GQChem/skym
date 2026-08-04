# skym service

Hosted charts, accounts, and the remote command queue for `skym-flow`. Deploys to Railway; the database is the source of truth and local `.flows/` becomes optional.

## Status

Milestone 2, partial. What works today: schema and migrations, op ingest, device-code pairing, agent tokens, chart attach/list/read. **Not built yet:** the OAuth handlers themselves (`auth.ts` has the account-linking logic, but no `/auth/google` routes), figure blob upload, the hosted viewer, and the command queue endpoints.

## Design notes

**The op log is the source of truth.** A chart's graph is the fold of its ops; there is no graph column, because a snapshot is a cache we can always rebuild.

**`seq` is assigned by the server, never the client.** Two agents editing one chart both propose the same next number — the local store derived it from its own revision counter and could not see the collision. The client's value is a hint; ingest renumbers.

**Ingest is idempotent.** Ops carry a client-minted `Entry.id`, unique per chart. A retried batch is skipped rather than re-applied — `figure.add` appends, so re-applying would duplicate figures and double-count events.

**Validation reruns server-side.** Cycle detection, node/edge ceilings, and bullet shape live in `skym-flow/validate`, which both the MCP server and this service call. A relay must not trust what it is sent. One bad op is rejected individually; the rest of the batch still lands.

**Accounts link on verified email only.** An unverified provider email creates a separate account. Anything else means signing up at a provider with someone else's address inherits their charts.

## Running locally

```bash
export DATABASE_URL=postgres://localhost:5432/skym
npm install && npm run build && npm start
```

Migrations run on boot — Railway runs the container and nothing else, so a separate migrate step would be skipped.

## Tests

```bash
npm test                                    # pure logic only
DATABASE_URL=postgres://... npm test        # plus ingest integration
```

The ingest tests **skip loudly without `DATABASE_URL`** rather than passing vacuously. They cover the guarantees that only a real database exercises: seq assignment under collision, idempotent redelivery, server-side validation, and partial-batch acceptance. A green run without a database does not mean ingest is verified.

## Railway

Attach a Postgres service (injects `DATABASE_URL`) and mount a volume for figures. Set `PUBLIC_URL` to the stable domain — pairing URLs and OAuth callbacks are built from it, and guessing from the request host is wrong behind a proxy.

The container filesystem is ephemeral: figures written outside the mounted volume disappear on the next deploy. `FIGURE_DIR` must point inside it.
