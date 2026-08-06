# Production configuration

This is the exact first-production setup for the hosted skym service and the
public `skym-flow` MCP package. Replace `https://YOUR_DOMAIN` with the one
canonical HTTPS origin before configuring OAuth or Stripe.

## 1. Generate secrets

Run this command twice and save the two different outputs in a password
manager. Do not commit them:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use one output for `STATE_SECRET` and the other for `ADMIN_TOKEN`.

## 2. Railway project

1. In Railway, create a project and choose **Deploy from GitHub repo**.
2. Select `GQChem/skym`; use branch `main` and the repository root.
3. Keep the checked-in `railway.json`. It builds the monorepo, starts
   `npm start --workspace service`, and checks `/health`.
4. Add a PostgreSQL service named `Postgres`.
5. Add a volume to the skym application service and mount it at `/data`.
6. In the application service's **Networking** settings, generate a Railway
   domain or attach the final custom domain. Use only this origin everywhere.
7. In **Variables → RAW Editor**, add:

```dotenv
DATABASE_URL=${{Postgres.DATABASE_URL}}
PUBLIC_URL=https://YOUR_DOMAIN
BLOB_DIR=/data/blobs
STATE_SECRET=FIRST_GENERATED_SECRET
ADMIN_TOKEN=SECOND_GENERATED_SECRET
STORAGE_QUOTA_FREE=52428800
STORAGE_QUOTA_PRO=1073741824
PGPOOL_MAX=10
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_PRO_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
```

8. Seal `STATE_SECRET`, `ADMIN_TOKEN`, both OAuth secrets,
   `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` from each variable's
   three-dot menu.
9. Deploy. Confirm `https://YOUR_DOMAIN/health` returns `{"ok":true}`.
   Startup automatically applies migrations under a PostgreSQL advisory lock.
10. In the Postgres service and application-volume settings, enable daily,
    weekly, and monthly backups. Perform and document one test restore before
    accepting paying customers.

Do not define `PORT`; Railway injects it. Do not use a public PostgreSQL URL
from the deployed service.

## 3. GitHub sign-in

1. GitHub → profile picture → **Settings → Developer settings → OAuth Apps →
   New OAuth App**.
2. Application name: `skym`.
3. Homepage URL: `https://YOUR_DOMAIN`.
4. Authorization callback URL:
   `https://YOUR_DOMAIN/auth/github/callback`.
5. Do not enable Device Flow; skym implements its own agent pairing.
6. Copy the Client ID to Railway `GITHUB_CLIENT_ID`.
7. Generate a client secret, copy it once to `GITHUB_CLIENT_SECRET`, and seal
   it. The service requests only identity/email access, not repository access.

## 4. Google sign-in

1. Create or select a Google Cloud project.
2. In **Google Auth Platform**, configure the consent screen: app name `skym`,
   your support email, homepage `https://YOUR_DOMAIN`, privacy URL
   `https://YOUR_DOMAIN/privacy`, and terms URL
   `https://YOUR_DOMAIN/terms`.
3. Choose the external audience. During testing, add explicit test users;
   publish the app when the policies and domain are ready.
4. Create an OAuth client with application type **Web application**.
5. Authorized JavaScript origin: `https://YOUR_DOMAIN`.
6. Authorized redirect URI:
   `https://YOUR_DOMAIN/auth/google/callback`.
7. Copy the client ID and secret into Railway `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`; seal the secret.

OAuth redirect URLs must match exactly, including scheme, host, and path. After
changing any variable, review and deploy Railway's staged changes.

## 5. Stripe storage subscription

Configure sandbox mode first, then repeat the same steps in live mode.

1. Stripe Dashboard → **Product catalog → Add product**.
2. Name: `skym Pro storage`.
3. Description: `1 GB hosted artifact storage; all product features remain available on Free`.
4. Add one recurring monthly price. Recommended launch test: EUR 8/month.
   Save the resulting `price_...` as Railway `STRIPE_PRO_PRICE_ID`.
5. Stripe → **Developers/Workbench → API keys**. Put the sandbox secret key
   (`sk_test_...`) in `STRIPE_SECRET_KEY`; never expose it to browser code.
6. Stripe → **Settings → Billing → Customer portal**. Enable payment-method
   updates, invoice history, and subscription cancellation. Do not enable
   plan switching until another recurring price exists. Set the business name,
   support contact, privacy URL, and terms URL, then save the configuration.
7. Stripe → **Workbench → Webhooks → Create event destination**.
8. Endpoint URL: `https://YOUR_DOMAIN/api/billing/webhook`.
9. Subscribe to exactly:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
10. Reveal that endpoint's signing secret (`whsec_...`) and put it in
    `STRIPE_WEBHOOK_SECRET`. The sandbox and live endpoints have different
    secrets.
11. Deploy the three Stripe variables together. In Settings, confirm the
    Upgrade button opens Stripe Checkout. Complete a sandbox purchase using a
    Stripe test card, confirm the webhook returns HTTP 200, and verify Settings
    shows `pro` and a 1 GB quota.
12. Test cancellation in the customer portal and verify the webhook returns the
    account to `free` without deleting existing artifacts. New uploads are
    refused only when usage exceeds the new quota.

Before live mode, activate the Stripe account, complete business/tax/payout
details, replace all three Stripe variables with live values, and perform a
real low-value purchase and refund.

## 6. GitHub repository and CI

1. Push the implementation branch. The `ci` workflow runs Linux tests with a
   real PostgreSQL service, Windows tests, and an npm package dry run.
2. Repository → **Settings → Branches/Rulesets**: protect `main`; require the
   `test` and `windows` jobs, require pull requests, and block force pushes.
3. Repository → **Settings → Security → Private vulnerability reporting**:
   enable it so `SECURITY.md` points to a working private channel.
4. Enable Dependabot security updates, dependency graph, secret scanning, and
   push protection where the repository plan permits them.
5. Do not put Railway, OAuth, or Stripe production secrets in GitHub Actions;
   Railway owns deployment secrets and CI creates an isolated PostgreSQL
   database automatically.

## 7. npm publication

The public npm package contains the MIT-licensed local MCP client and viewer;
the proprietary `service/` workspace is private and is not packed.

1. Create an npm account with two-factor authentication.
2. Confirm the unscoped name is available:
   `npm view skym-flow`. If it is owned by someone else, rename the package to
   an available scoped name such as `@YOUR_SCOPE/skym-flow` before publishing.
3. Run `npm ci`, `npm test`, and `npm pack --dry-run` from the repository root.
4. For the first release, run `npm login`, then `npm publish`.
5. In npmjs.com → package → **Settings → Trusted publishing**, connect the
   GitHub repository and a tag-triggered publish workflow. Give that workflow
   only `contents: read` and `id-token: write` permissions.
6. After trusted publishing succeeds, set publishing access to require 2FA and
   disallow traditional automation tokens.

Do not publish until the copyright-holder name in both license files has been
confirmed.

## 8. Local installation and pairing smoke test

After npm publication:

```powershell
npm install --global skym-flow
claude mcp add skym-flow -- skym-flow
```

Copy `CLAUDE.md.example` into a disposable test project, start Claude Code,
call `flow_init`, approve the printed code at
`https://YOUR_DOMAIN/settings`, and verify:

1. the chart appears in the dashboard;
2. a figure appears and consumes storage;
3. right-clicking a node and choosing **Work on this** queues a command;
4. `flow_inbox` claims it only once;
5. `flow_command_state` shows running and terminal status;
6. revoking the agent prevents further synchronization.

## 9. Monitoring and recurring operations

1. Add an external uptime check for `/health`; Railway healthchecks only gate
   deployments and are not continuous monitoring.
2. Alert on HTTP 5xx rate, PostgreSQL capacity/connections, application volume
   usage, failed Stripe webhooks, and repeated quota rejections.
3. Review structured logs by `request_id`; never log OAuth codes, bearer tokens,
   webhook bodies, or figure bytes.
4. Monthly: test one backup restore, review revoked/stale devices, inspect
   failed Stripe events, and reconcile database figure keys against volume
   files.
5. Before changing quota defaults, confirm the Railway volume has capacity for
   the maximum plausible paid usage.
