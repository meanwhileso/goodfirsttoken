# Self-hosting

This guide sets up your own copy of Good First Token on your own Cloudflare
account, with your own GitHub OAuth apps. At the end, a push to `main` deploys
staging, checks it, and then deploys production.

You need:

- A GitHub account, with a copy of this repo under it.
- A Cloudflare account whose plan includes Workers, D1, KV, and Queues.
- A domain on Cloudflare, if you want the site on your own domain. Without
  one, it is served on workers.dev.

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
     two permissions: Account, D1, Edit, and Account, Queues, Edit. Under
     Account Resources, pick your account. Under Zone Resources, pick the
     zones of your domains, or all zones if you have none. Staging and
     production can share one token or have one each.
   - **A credential broker.** This is a service you run that trades the deploy
     job's GitHub OIDC token for a short-lived Cloudflare token, so no
     long-lived token sits in GitHub. [The credential broker](#the-credential-broker)
     says what it has to do.

   A broker URL set on the repository reaches both environments. An
   environment that also has its own API token then has both forms, and its
   deploy stops with "Keep only one". Set the broker URL on the repository
   only when both environments use the broker.

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

GitHub accepts any path under the callback URL, and
[the plan](specs/v1.md#3-identity-permissions-and-token-storage) puts the
site's login and the login from agents under this one. Copy the app's client
ID for `OAUTH_CLIENT_ID` in step 4.

The site does not sign anyone in yet. Sign-in (#8) also needs the app's
client secret, and adds it to [the Worker's secrets](#the-workers-secrets).

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
| `PRIMARY_DOMAIN` | No | The domain the site is served on, like `example.org`. When it's empty, the site is served on workers.dev. |
| `REDIRECT_DOMAINS` | No | Other domains, separated by commas, that answer every request with a 301 to the same path on `PRIMARY_DOMAIN`. Each one's zone has to be in the same account. |
| `OAUTH_CLIENT_ID` | No | The client ID of this environment's GitHub OAuth app. Sign-in (#8) reads it. |
| `ADMIN_GITHUB_IDS` | No | The numeric GitHub user IDs of the site's admins, separated by commas. `https://api.github.com/users/<username>` shows a user's `id`. Sign-in (#8) reads it. |
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

The Worker reads no secrets yet. Each secret it reads is listed under
`secrets.required` in `apps/web/wrangler.jsonc`, gets a row here, and goes in
each environment as an environment secret with the same name.

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
