# Self-hosting

This guide sets up your own copy of Good First Token on your own Cloudflare
account, with your own GitHub OAuth apps. At the end, a push to `main` deploys
staging, checks it, and then deploys production.

You need:

- A GitHub account, with a copy of this repo under it.
- A Cloudflare account whose plan includes Workers, D1, KV, and Queues, and
  R2 if you want a static host.
- A domain on Cloudflare, if you want the site on your own domain. Without
  one, it is served on workers.dev. A static host needs one too.

Local development needs none of this. [CONTRIBUTING.md](../CONTRIBUTING.md)
covers it.

## How a deploy works

A push to `main` runs `.github/workflows/deploy.yml`. It deploys staging,
checks that staging answers, and then deploys production. Each deploy job
runs in a GitHub environment, `staging` or `production`, and reads every
deployment value from it. Nothing about your deployment goes in the repo.
[architecture.md](architecture.md#deploys) lists every step of a deploy.

## 1. Copy the repo

Fork this repo, or push a copy of it to your own account. On a fork, open the
Actions tab and turn workflows on. Nothing deploys until you turn staging on
in step 5.

## 2. Set up Cloudflare

1. **Find your account ID.** It is on the Workers & Pages overview page in
   the Cloudflare dashboard, and in the URL of every dashboard page:
   `dash.cloudflare.com/<account ID>/`.
2. **Pick a Worker name for each environment.** It becomes the
   `WORKER_NAME` setting in step 4, and every other resource is named after
   it. Use lowercase letters, digits, and dashes. If staging and production
   share an account, give them different names.
3. **Choose where each environment's site lives.**
   - On your own domain: add the domain to Cloudflare as a zone in the same
     account. Staging can use a subdomain, like `staging.example.org`. The
     deploy attaches each domain to the Worker, and Cloudflare creates its DNS
     record and certificate. If a hostname already has a DNS record, delete
     it first.
   - On workers.dev: open Workers & Pages once, so your account has a
     workers.dev subdomain, and note it. The site is then at
     `<WORKER_NAME>.<your subdomain>.workers.dev`.
4. **Leave the resources to the deploy.** The deploy creates the D1 database
   and the queues when they are missing. Wrangler creates the KV namespace on
   the first deploy and keeps using it. To use a D1 database or KV namespace
   you already have, set its ID in step 4.
5. **Make a credential.** Each environment uses one of these two forms:
   - **An API token.** In the dashboard, go to My Profile, API Tokens, and
     Create Token. Start from the Edit Cloudflare Workers template, and add
     two permissions: Account, D1, Edit, and Account, Queues, Edit. With a
     static host, check that it also has Account, Workers R2 Storage, Edit,
     and add it if not. Under Account Resources, pick your account. Under
     Zone Resources, pick the zones of your domains, or all zones if you
     have none. Staging and production can share one token or have one
     each.
   - **A credential broker.** This is a service you run that trades the deploy
     job's GitHub OIDC token for a short-lived Cloudflare token, so no
     long-lived token sits in GitHub. [The credential broker](#the-credential-broker)
     says what it has to do.

   A broker URL set on the repository reaches both environments. An
   environment that also has its own API token then has both forms, and its
   deploy stops with "Keep only one". Set the broker URL on the repository
   only when both environments use the broker.
6. **Set up a static host, if you want one.** It serves the site's scripts,
   styles, fonts, and video from a hostname of its own, with long caching
   and no cookies. [The static host](#the-static-host) says how. Without
   one, the Worker serves them.

## 3. Create the GitHub OAuth apps

Sign-in uses one GitHub OAuth app per environment. GitHub has no API for
creating them, so make each one by hand. In your GitHub settings, go to
Developer settings, OAuth Apps, and New OAuth App. Fill it in with the
environment's domain from step 2: its own domain, or its workers.dev
hostname.

| Field | Value |
|---|---|
| Application name | Your site's name. Add "staging" to the staging app's. |
| Homepage URL | `https://<domain>` |
| Authorization callback URL | `https://<domain>/auth/callback` |

GitHub accepts any path under the callback URL. The site's sign-in comes back
to `/auth/callback/github`, and
[the plan](specs/v1.md#3-identity-permissions-and-token-storage) puts the
login from agents under the same URL. Copy the app's client ID for
`OAUTH_CLIENT_ID` in step 4. Then click Generate a new client secret, and
keep it for `OAUTH_CLIENT_SECRET`, one of
[the Worker's secrets](#the-workers-secrets).

## 4. Create the GitHub environments

In your repo's settings, go to Environments and create `staging` and
`production`. For each one:

1. Under Deployment branches and tags, choose Selected branches and tags, and
   add `main`. Only `main` can then deploy to it.
2. For `production`, you can add required reviewers, so each production
   deploy waits for a person to approve it.
3. Add the settings below to it.

### Settings

Each setting goes in the environment it belongs to, as an environment secret
or an environment variable with the name shown. A repository secret never
reaches the deploy. A repository variable reaches both environments.

The deploy logs of a public repo are public. GitHub prints every variable a
step reads in that step's header, before anything can mask it, and a secret
is always masked. **In a public repo, make every setting a secret.** Only the
two on switches, `DEPLOY_STAGING` and `DEPLOY_PRODUCTION`, are fine as
variables. In a private repo, either works.

| Name | Needed | What it is |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Your Cloudflare account ID. |
| `WORKER_NAME` | Yes | The environment's Worker name from step 2. The D1 database is `<WORKER_NAME>-db`, and the queues are `<WORKER_NAME>-feed` and `<WORKER_NAME>-crawl`. |
| `DB_ID` | No | The ID of a D1 database to use. When it's empty, the deploy uses `<WORKER_NAME>-db`, and creates it if it's missing. |
| `OAUTH_KV_ID` | No | The ID of a KV namespace for sign-in grants. When it's empty, Wrangler creates one on the first deploy and keeps using it. |
| `SIGN_IN_LIMITER_NAMESPACE_ID` | Yes | A whole number you pick for the rate limiter on sign-in, like `1001`. It names the limiter within your Cloudflare account, and there is nothing to create. If staging and production share an account, give them different numbers. |
| `PRIMARY_DOMAIN` | No | The domain the site is served on, like `example.org`. When it's empty, the site is served on workers.dev. |
| `REDIRECT_DOMAINS` | No | Other domains, separated by commas, that answer every request with a 301 to the same path on `PRIMARY_DOMAIN`. Each one's zone has to be in the same account. |
| `STATIC_ORIGIN` | No | The static host's origin, like `https://static.example.org`, set up as [The static host](#the-static-host) says. Pages then load the built files from there, and the deploy uploads them to `<WORKER_NAME>-static`. When it's empty, the Worker serves them. |
| `OAUTH_CLIENT_ID` | Yes | The client ID of this environment's GitHub OAuth app from step 3. No one can sign in without it, so the deploy stops when it's empty. |
| `ADMIN_GITHUB_IDS` | No | The numeric GitHub user IDs of the site's admins, separated by commas. `https://api.github.com/users/<username>` shows a user's `id`. When it's empty, the site has no admins. |
| `GH_API_URL` | No | GitHub's REST and GraphQL API, as an `https` URL. Leave it empty, and the Worker calls `https://api.github.com`. |
| `GH_WEB_URL` | No | github.com itself, which sign-in sends people to, as an `https` URL. Leave it empty, and the Worker uses `https://github.com`. |

### Credential

| Name | Kind | What it is |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environment secret | The API token from step 2. |
| `CLOUDFLARE_CREDENTIAL_BROKER_URL` | Environment secret, or a repository variable for both environments | The broker's `https` URL. |

Set one of the two for each environment. A deploy with both, or neither,
stops before it changes anything.

### The Worker's secrets

Each secret the Worker reads is listed under `secrets.required` in
`apps/web/wrangler.jsonc`, and goes in each environment as an environment
secret with the same name. The deploy stops before it puts any of them when
one is missing.

| Name | Kind | What it is |
|---|---|---|
| `OAUTH_CLIENT_SECRET` | Environment secret | The client secret of this environment's GitHub OAuth app from step 3. |
| `AUTH_SECRET` | Environment secret | A random value of at least 32 characters, like the output of `openssl rand -base64 32`, different for each environment. It signs the sign-in cookies and encrypts the GitHub tokens the site stores. Changing it signs everyone out, and makes every stored token unreadable, so neither signing out nor signing in again can revoke it. Those tokens stay valid at GitHub until each person revokes the app in their GitHub settings, or GitHub revokes them after a year unused. So change it only when you have to. |

### On switches

| Name | Kind | What it is |
|---|---|---|
| `DEPLOY_STAGING` | Repository variable | `true` turns staging deploys on. |
| `DEPLOY_PRODUCTION` | Repository variable | `true` turns production deploys on. Production deploys only after staging passes. |

## 5. Deploy staging

In your repo's settings, go to Secrets and variables, Actions, and
Variables, and add the repository variable `DEPLOY_STAGING` with the value
`true`. Then push to `main`, or open the Actions tab, pick Deploy, and click
Run workflow on `main`.

When the job passes, `/healthz` on the staging domain answers
`{"ok": true, "environment": "staging"}`. The job checks this itself, and
retries for a few minutes while a new domain gets its certificate. If it
gives up first, run the workflow again. When a step fails, its log names what
to fix.

## 6. Turn on production

Fill in the `production` environment the same way, with its own
`WORKER_NAME`, domain, and OAuth app. Then add the repository variable
`DEPLOY_PRODUCTION` with the value `true`.

From then on, every push to `main` deploys staging, checks it, and then
deploys production and checks that too. To pause either one, delete its
variable or set it to anything else.

## After the first deploy

- One deploy runs at a time, and a deploy in progress always finishes.
  GitHub keeps at most one more waiting. When a newer push comes in, GitHub
  cancels the waiting one, so the newest commit deploys next.
- To change a setting, edit it in the environment and run the Deploy workflow
  by hand.
- A deploy reuses the database, the KV namespace, and the queues it finds, so
  running it again loses nothing.

## The static host

A static host serves the site's built files from an R2 bucket on a hostname
of its own, like `static.example.org`. Cloudflare's cache keeps them close
to visitors, browsers keep them for a year, and the site's cookies never
reach them. R2 attaches a custom domain only from a zone in the same
Cloudflare account. Set it up once for each environment:

1. **Create the bucket.** In the Cloudflare dashboard, go to R2 and create a
   bucket named `<WORKER_NAME>-static`, with that environment's Worker name.
   The deploy uploads to it and never creates it.
2. **Attach its hostname.** In the bucket's settings, under Custom Domains,
   connect a hostname in one of your zones. Use one the site doesn't use.
   Leave the bucket's r2.dev URL turned off.
3. **Let the site's pages use the files.** A browser loads fonts and
   scripts from another origin only when the answer carries
   `Access-Control-Allow-Origin`. In the zone, go to Rules and create a
   response header transform rule. Match requests whose hostname equals the
   static host's, and set the static header `Access-Control-Allow-Origin`
   to `*`.
4. **Keep cookies away from the hostname.** Leave off every Cloudflare
   feature that sets a cookie. Bot Fight Mode sets `__cf_bm`, and a
   challenge sets `cf_clearance`. Bot Fight Mode covers the whole zone.

   Cloudflare's docs don't say which domain these cookies are set for.
   Examples published outside them show `__cf_bm` set with the zone's own
   domain as its `Domain`, and a browser sends such a cookie to every
   hostname in the zone, the static host's included. We have not confirmed
   this. Until someone does, take one of two ways:
   - Put the static host on a domain of its own, in a zone that serves
     nothing else. Then challenges and Bot Fight Mode on the site's zone
     can't reach it.
   - Or keep Bot Fight Mode and every challenge off for the whole zone the
     site and the static host share, the site's hostname included.

   The deploy's check sees only the cookies the static host itself sets.
   It can't see one the site's hostname sets for the whole zone.
5. **Set `STATIC_ORIGIN`** in the environment to `https://` and the
   hostname, like `https://static.example.org`, and deploy.

Each deploy checks the static host before it changes anything else, as
[how-it-works.md](how-it-works.md#static-assets) describes. When the step
"Upload the built files to the static host, and check it" fails, its log
names each problem. Fix it on the hostname or in the bucket, and run the
deploy again. A new hostname's certificate can take a few minutes, so a
static host that can't be reached right after you attach it may only need
another run.

When the step says the static host already has a file with other bytes
than the build's, a file's content changed while its name stayed the same.
Browsers and Cloudflare's cache may already keep the old one for a year
under that name, so the deploy won't replace it. Only deleting that object
from the bucket gets past the stop. Delete it in the dashboard, under R2,
purge its URL from the zone's cache under Caching, and run the deploy
again. Visitors who already have the old file keep it. Then find why the
build gave changed content an old name, so it doesn't happen again.

Byte ranges, which Safari needs to play the video, are checked by hand. No
page links to the launch video yet. Its name starts with
`good-first-token-launch-`, and the deploy's build step lists it. After the
first deploy with the static host, run:

```bash
curl -s -o /dev/null -D - -H 'Range: bytes=0-99' https://static.example.org/assets/<video file>
```

It answers `206`, with `content-range: bytes 0-99/` and the file's size, and
no `set-cookie`.

## The credential broker

A deploy job that uses the broker holds a Cloudflare token only for as long as
the broker allows. The job:

1. Asks GitHub for an OIDC token whose audience is the broker URL. The deploy
   jobs have the `id-token: write` permission for this.
2. Sends `POST <broker URL>` with the header `Authorization: Bearer <OIDC token>`
   and no body. It does not follow redirects.
3. Expects `200` with the JSON `{"token": "<Cloudflare API token>"}`. Any
   other answer stops the deploy.

Before it answers, the broker verifies the OIDC token's signature against
GitHub's keys at `https://token.actions.githubusercontent.com/.well-known/jwks`,
and checks its claims:

| Claim | Value |
|---|---|
| `iss` | `https://token.actions.githubusercontent.com` |
| `aud` | The broker URL |
| `repository` and `repository_id` | Your repo's name and its numeric ID, which stays the same if the repo is renamed |
| `ref` | `refs/heads/main` |
| `job_workflow_ref` | `<owner>/<repo>/.github/workflows/deploy-environment.yml@refs/heads/main`, the workflow that runs the deploy job |
| `environment` | `staging` or `production` |

It then answers with a Cloudflare token for that environment, with the
permissions from step 2, that expires soon after the deploy. It answers
anything else with `403`.
