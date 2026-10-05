# Deploying to AWS (ECS Fargate + RDS)

Runbook for hosting the multi-tenant app on AWS. It uses a single container image
(API + built SPA) on **ECS Fargate** behind an **ALB**, with **RDS PostgreSQL** for
data and **Secrets Manager** for the connection string. No infrastructure-as-code is
included yet — these are the manual/CLI steps.

> **Tenancy:** every route is tenant-isolated by book at the app layer **and** by
> Postgres row-level security. RLS is only enforced when the app connects as a
> non-superuser role — see step 4b. Auth/invite endpoints are IP rate-limited (state is
> per-process; front with a shared store if you run many instances and need strict limits).

## 1. Build & push the image (ECR)

```bash
# from the repo root (context must include both web/ and server/)
aws ecr create-repository --repository-name finance-tracker        # once
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/finance-tracker

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build -f server/Dockerfile -t $REPO:latest .
docker push $REPO:latest
```

## 2. Database (RDS PostgreSQL)

- Create an RDS PostgreSQL 16 instance (private subnets; security group allows :5432
  from the ECS service SG only).
- Store the connection string in Secrets Manager:

```bash
aws secretsmanager create-secret --name finance-tracker/DATABASE_URL \
  --secret-string 'postgresql://USER:PASS@your-rds-endpoint:5432/finance'
```

## 3. Configuration (environment)

Set on the ECS task definition. The image already defaults `NODE_ENV=production`,
`HOST=0.0.0.0`, `PORT=4000` (which also turn on `COOKIE_SECURE` and `TRUST_PROXY`).

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | from Secrets Manager | privileged RDS connection (migrations/bootstrap) |
| `APP_DATABASE_URL` | from Secrets Manager | non-superuser role the server runs as (enables RLS — see 4b) |
| `DB_POOL_MAX` | `20` | max pooled connections (one per in-flight request) |
| `APP_BASE_URL` | `https://app.example.com` | builds absolute invite links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional | outgoing email for password reset links (any SMTP relay: OCI Email Delivery, Amazon SES, …). Without them, "Forgot password?" tells the user to ask the operator, who runs `node dist/passwordReset.js person@example.com` to get a 24-hour, one-time link. Needs `APP_BASE_URL` for the links. |
| `CONTACT_EMAIL` | optional | shown on the Privacy page as who to contact about data and account deletion (without it: "the person who invited you") |
| `BACKUP_KEEP_DAYS` | optional | days each server backup is kept. Set it to match your backup retention: the Privacy page states it (daily backups, kept this long) and that deleted data lasts that long in backups. Unset, the page makes no backup claim. |
| `OFFSITE_BUCKET` | optional | set when backups are copied off the server (see "Off-machine backup copies"); the Privacy page then says so |
| `SIMPLEFIN_ALLOWED_HOSTS` | optional | comma-separated SimpleFIN servers the app may contact (default `bridge.simplefin.org,beta-bridge.simplefin.org`). Setup tokens and access URLs for any other host are refused, and redirects aren't followed. |
| `SIGNUP_MODE` | `invite` (default in prod) | `invite`: sign-up needs a signup invite or a book invite code (the first account on an empty database is exempt). `open`: anyone can sign up. Unknown values fail closed to `invite`. |
| `COOKIE_SECURE` | `true` (default in prod) | session cookie sent over HTTPS only |
| `TRUST_PROXY` | `true` (default in prod) | trust the ALB's `X-Forwarded-Proto` |
| `WEB_ORIGIN` | optional | only needed if the SPA is served from a different origin |
| `ANTHROPIC_API_KEY` | optional | AI features |
| `RENTCAST_API_KEY` | optional | property valuations |
| `APP_SECRET_KEY` | **required** | encrypts stored SimpleFIN access credentials at rest. At least 32 characters: `openssl rand -base64 32`. In production the server **refuses to start** if it is missing, still the development default, or shorter than 32 characters. Changing it later invalidates existing connections (they must be re-linked). |

TLS terminates at the ALB; the container speaks plain HTTP on :4000. `trust proxy`
lets Express see the original HTTPS scheme so Secure cookies are honored.

## 4. Run migrations (one-off task)

Migrations do **not** run on container boot. After the image is pushed and the DB is
reachable, run a one-off ECS task overriding the command:

```bash
# command override:
node dist/migrate.js
```

Idempotent — safe to run on every deploy. (Locally / via SSM the equivalent is
`cd server && npm run migrate`.)

> When a migration adds **new tables** (e.g. the import staging tables in 043), re-run the
> db-role setup task (step 4b) afterward — it re-grants privileges on all tables to the
> app role. (New tables are covered by default privileges, but re-running is the safe move.)

## 4b. Create the restricted app role (one-off task) — enables RLS

Row-level security only applies to non-superuser roles. Create a dedicated app role
and run the server as it:

```bash
APP_DB_USER=finance_app APP_DB_PASSWORD='another-strong-password' node dist/setupDbRole.js
```

Then set, on the running service's task definition:

```
APP_DATABASE_URL=postgresql://finance_app:<password>@your-rds-endpoint:5432/finance
```

Keep `DATABASE_URL` as the privileged role (migrations/bootstrap use it). Store both in
Secrets Manager.

## 5. Create the first user (one-off task)

Adopt any existing data and create the owner login. Override the command with env:

```bash
EMAIL=you@example.com PASSWORD='a-strong-password' NAME='You' node dist/bootstrap.js
```

Re-running with the same email is a no-op.

## 5b. Invite people (one-off task)

Sign-up is invite-only in production. To let a new person create an account with
their own books, create a single-use signup invite and send them the printed link
(it's shown once; only a hash is stored):

```bash
node dist/signupInvites.js create --email person@example.com --days 14 --note "Mom"
node dist/signupInvites.js list
node dist/signupInvites.js revoke <id>
```

To add someone to one of your books instead, use **My Books → New Invite Link** in the
app; that link also works for sign-up. (Locally: `scripts/local-prod/invite.sh` with the
same arguments.)

## 5c. Delete an account (on request)

The Privacy page tells people to ask the operator to delete their account. Run it
first without `--yes` to see what it will do:

```bash
node dist/deleteAccount.js person@example.com            # dry run
node dist/deleteAccount.js person@example.com --yes      # delete
```

It deletes the account and every book only that person belongs to, with all data in
them, and removes them from books shared with others (those stay with the other
members). If they're the only owner of a shared book, it refuses until you name a
member of that book to take it over: `--new-owner other@example.com`. Their data
remains in server backups (and off-machine copies) until those expire after
`BACKUP_KEEP_DAYS`. (Locally: `scripts/local-prod/delete-account.sh` with the same
arguments.)

## 6. ECS Fargate service + ALB

- Task: the image from step 1, container port **4000**, env from step 3.
- ALB: HTTPS:443 listener with an **ACM** certificate → target group on **4000**.
- Target group **health check path: `/api/ready`** (returns 200 when the DB is reachable;
  `/api/health` is a pure liveness check with no DB dependency).
- Point your domain (Route 53) at the ALB.

## 7. Verify

```bash
curl -fsS https://app.example.com/api/ready          # {"ok":true}
# open https://app.example.com/ -> login screen -> sign in with the bootstrap user
```

## Updating

Re-build & push (`:latest` or an immutable tag), update the service, and run the
migration task again. Sessions survive deploys (stored in the DB).

## Off-machine backup copies (self-hosted stack)

`docker-compose.prod.yml` has an optional `offsite` service (rclone) that copies each
backup dump to an S3-compatible bucket every hour and deletes copies older than
`BACKUP_KEEP_DAYS`. `scripts/local-prod/deploy.sh` starts it when `OFFSITE_BUCKET` is set
in `.env.production` (see `.env.production.example`). For OCI Object Storage, use its
S3-compatible endpoint (`https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`)
with a "Customer Secret Key" as the access key pair. Restore drill: download a dump from
the bucket and `pg_restore` it into a scratch database, as `deploy.sh` rehearsals do.
