# skym product vision

## Product thesis

skym should become the durable investigation record and control surface for
long-running agent work. Its value is not merely drawing flowcharts. It makes
an agent's reasoning legible across time: what was attempted, what evidence was
produced, which alternatives remain open, and what a human or another agent
should do next.

The repository is currently a strong alpha. The local MCP server, append-only
storage, renderer, offline export, hosted synchronization, authentication, and
figure handling form a credible technical foundation. Product viability now
depends on making the system safe, easy to adopt, demonstrably useful, and
operable as a service.

## Product principles

1. **Local-first and trustworthy.** A user's work remains available as files,
   can be exported, and is never silently discarded.
2. **Evidence over narration.** Findings stay connected to screenshots, plots,
   measurements, and the actions that produced them.
   Agents should point at source data or files; skym should derive previews and
   visualizations locally so evidence does not consume model image-generation
   or dataset-transcription tokens.
3. **Structure without ceremony.** Agents create the record as they work;
   humans should not have to maintain a diagram manually.
4. **Readable by humans, actionable by agents.** The hosted chart grows from a
   passive viewer into a safe, audited control surface.
5. **Private by default.** Reading, writing, sharing, and deletion are separate
   permissions, and connected devices are visible and revocable.
6. **Useful before signup.** Prospective users can understand and experience the
   product before being asked to authenticate or install it.

## Current strengths

- A differentiated model for actions, results, alternatives, and standing
  context, with custom vocabularies for other workflows.
- Append-only operations with replay, idempotent remote ingestion, atomic local
  snapshots, and self-contained offline exports.
- Purpose-built, accessible SVG rendering with live updates and attached
  evidence.
- Local and hosted storage modes rather than forced cloud dependence.
- Device-code pairing, OAuth identities, private figures, and storage quotas.
- Broad unit coverage for rendering, validation, storage, MCP behavior, and
  synchronization.

## Workstreams

### 1. Launch safety and authorization

- Replace the single chart-access check with explicit read, write, delete, and
  project-management capabilities.
- Enforce project roles: owners manage and delete, members contribute, viewers
  only read.
- Restrict agent ingestion and figure upload to agent credentials; browser
  sessions use deliberate web APIs rather than the agent protocol.
- Add connected-device listing, labels, last-used information, and revocation.
- Add rate limits for pairing, OAuth starts, polling, ingestion, and uploads.
- Bound operation batch sizes and per-account ingestion rates.
- Periodically remove expired pairings and sessions.
- Add audit events for sign-in, pairing, token changes, membership changes,
  deletion, and plan changes.
- Apply a consistent security-header policy to all responses.
- Align documented and effective upload limits.
- Add reconciliation for blob/database split-brain and orphan cleanup.
- Publish a security policy and incident contact.

### 2. Reliable delivery and operations

- Add CI for build, type checking, unit tests, PostgreSQL integration tests,
  browser smoke tests, and packed-package installation on Linux and Windows.
- Isolate every test from the real home directory and production services.
- Run dependency and secret scanning.
- Add structured logs, request IDs, latency/error metrics, storage alerts, and
  error reporting.
- Add database backups, restore drills, retention rules, and blob backup or
  replication.
- Serialize migrations with an advisory lock or a deployment migration step.
- Version the hosted API and specify client/server compatibility behavior.
- Add pagination rather than silently limiting chart lists.
- Document supported Node versions and a release/rollback process.

### 3. Installation and activation

- Publish a complete npm package with license, repository, homepage, keywords,
  support links, and reproducible package contents.
- Provide `skym-flow setup` to detect supported MCP clients, install the server,
  and generate the needed agent guidance.
- Offer copy-paste installation for major MCP clients instead of Claude-only
  language.
- Make pairing status and sync failures visible and recoverable.
- Create an onboarding checklist that ends with a live sample chart.
- Preserve and prominently explain the fully local/service-disabled mode.

### 4. Demonstrating value

- Put an interactive, no-sign-in sample chart on the homepage.
- Show a short recording of a chart evolving during real agent work.
- Add concrete scenarios: incident investigation, performance analysis,
  research, refactoring, and architectural decisions.
- Explain the improvement over transcript search with before/after examples.
- Send the primary homepage CTA to the experience before the dashboard.
- Add concise product documentation and troubleshooting guides.

### 5. Retrieval and retention

- Search across projects, charts, nodes, titles, bullets, and states.
- Filter unresolved, blocked, waiting, abandoned, and recently changed work.
- Add project overview pages and cross-session summaries.
- Support rename, archive, tags, favorites, and bulk organization.
- Add “what changed since my last visit?” and resumable entry points.
- Provide account export/import and explicit backup controls.
- Add shareable read-only links with scopes and expiry.
- Provide outcome views, beginning with a positive-only tree that retains the
  causal ancestors of successful results while hiding unrelated branches.

### 5a. Artifact pipeline

- Treat images, generated charts, datasets, video, audio, and documents as
  typed artifacts rather than forcing every attachment into an image shape.
- Prefer path-based tools: the agent names a local source and skym performs
  parsing, reduction, rendering, thumbnailing, and upload outside model context.
- Keep raw source data local by default; upload only a generated preview unless
  the user or agent explicitly asks to preserve the original artifact.
- Support CSV/TSV/JSON to SVG first, then video with browser playback, a local
  poster-frame/metadata extractor, explicit size limits, and no token-heavy
  frame narration.
- Record provenance without leaking absolute local paths to hosting.

### 6. Web-to-agent control loop

- Complete the command lifecycle: queued, claimed with a lease, running,
  completed/failed, cancelled, and timed out.
- Authenticate and authorize command creation and claiming separately.
- Make commands idempotent, auditable, and safe to retry.
- Let users resume a branch, request investigation, annotate a result, or hand
  work to another connected agent.
- Let a user write a custom instruction before queuing work from a node; include
  the node automatically as context rather than making the user repeat it.
- Show agent presence and command progress without implying execution guarantees
  the system cannot provide.

### 7. Collaboration

- Add invitations, role management, member removal, and ownership transfer.
- Revoke or rescope connected agents when membership changes.
- Add comments/annotations and activity attribution.
- Introduce organization/workspace boundaries and audit history.
- Test every role against every project and chart operation.

### 8. Commercial and legal readiness

- Define free and paid plans around product value, not only blob storage.
- Candidate paid value: collaboration, organizations, cross-chart search,
  extended history, higher evidence limits, and administrative controls.
- Add pricing, checkout, billing lifecycle, invoices, plan transitions, and
  entitlement enforcement.
- Add privacy policy, terms, subprocessors, retention policy, account deletion,
  and data export.
- State precisely what chart and source-related data is uploaded.

### 9. Product quality

- Add responsive layouts and keyboard/touch alternatives for pan, zoom,
  selection, context actions, and figure inspection.
- Test accessibility semantics, focus management, contrast, and screen-reader
  behavior.
- Add empty, loading, degraded-sync, quota, authorization, and recovery states.
- Measure activation, successful pairing, first chart, return usage, sync
  reliability, and command completion with privacy-respecting analytics.

## Delivery sequence

### Phase 1 — safe private alpha

Role-aware authorization, credential boundaries, isolated CI, PostgreSQL-backed
tests, rate limiting, device revocation, operational telemetry, backups, legal
basics, and upload-limit consistency.

### Phase 2 — self-serve beta

Published package, one-command setup, multi-client documentation, interactive
sample, onboarding, search, organization tools, pagination, and reliable sync
diagnostics.

### Phase 3 — collaborative product

Invitations, role management, sharing, annotations, project summaries,
organizations, and the audited command queue.

### Phase 4 — commercial launch

Pricing and billing, paid entitlements, administrative controls, mature support,
retention/export guarantees, performance work, and defined reliability targets.

## Initial implementation slice

Implementation starts with the security boundary because every collaboration
and command feature depends on it:

- Introduce explicit chart capabilities derived from ownership and membership
  roles.
- Use read permission for graph/list/figure retrieval, write permission for
  ingestion and uploads, and owner permission for deletion.
- Require agent credentials on the agent attach/ingestion/upload protocol.
- Make the local credentials directory injectable so tests never write into a
  developer's real home directory.
- Add tests for the role matrix and isolated state paths.

## Implementation progress

Completed in the first product-readiness passes:

- Role-aware chart read/write/delete/manage authorization.
- Agent-only attach, operation-ingest, and figure-upload protocol boundaries.
- Browser-session and owner authorization for destructive chart deletion.
- Isolated, injectable local credential state via `SKYM_HOME`.
- Global HTTP security headers, request IDs, and structured request logs.
- Initial per-instance rate limits for OAuth, pairing, polling, and ingestion.
- Maximum operation batch size and aligned 8 MB request/figure limits.
- Expired pairing/session cleanup at boot and hourly thereafter.
- Connected-agent listing and owner-scoped revocation in Settings.
- Advisory-lock serialization for concurrent boot migrations.
- Cursor-paginated chart listing with transparent dashboard pagination.
- Linux/PostgreSQL and Windows CI, package smoke checks, and offline-by-default
  MCP tests that cannot pollute the production pairing database.
- Public-package metadata and a private vulnerability-reporting policy.
- Durable audit events for pairing, agent revocation, chart deletion, plan
  changes, account export, and account deletion.
- Transactionally single-use pairing redemption under concurrent polling.
- Account data export and permanent hosted-account deletion controls.
- Database-first chart/account deletion so cleanup failure can leave only
  removable orphan blobs, never live charts with missing evidence.
- Published privacy and terms pages based on the service's actual data flows.
- A leased, idempotent web-to-agent command lifecycle with hosted chart
  requests, agent claiming, running/done/failed states, and visible status.
- Stripe Checkout, customer portal, signed idempotent webhooks, and storage-only
  Free/Pro entitlement projection (50 MB and 1 GB at launch).
- Hybrid licensing: MIT local MCP client/viewer and proprietary hosted service.
- A complete production configuration and release runbook in `DEPLOYMENT.md`.
- Custom web-to-agent request composition with automatic node context.
- A positive-only chart view that preserves paths leading to successful results.
- Local CSV/TSV/JSON visualization through `flow_data`; only the generated SVG
  is synchronized, establishing the low-token typed-artifact direction.

## Success criteria

- A new user can install, pair, and see a useful chart in under five minutes.
- No viewer or ordinary member can perform owner-only actions.
- Critical integration tests run on every change rather than skipping.
- Sync failures are observable, explainable, and recoverable without data loss.
- Users return to existing charts to resume work, not only watch new charts.
- Teams can safely share projects and understand who or what changed them.
- Paid conversion is connected to durable workflow value rather than accidental
  storage pressure.
