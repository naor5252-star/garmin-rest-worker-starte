# Garmin REST Worker

A personal, read-only REST façade for Garmin Connect running on Cloudflare Workers.

> Garmin Connect private endpoints are unofficial and may change. Do not expose this Worker without API authentication.

## Architecture

```text
Garmin Forerunner
      ↓ sync
Garmin Connect
      ↓ OAuth
Cloudflare Worker
      ↓
Your private REST API
      ↓
Coach / iPhone Shortcut / scripts
```

The Worker stores Garmin OAuth tokens in Cloudflare KV. It does **not** store your Garmin password.

## REST endpoints

### Public

- `GET /healthz`

### Admin — `Authorization: Bearer <ADMIN_TOKEN>`

- `GET /admin/status`
- `POST /admin/login`
- `PUT /admin/tokens`
- `DELETE /admin/session`

### Data — `Authorization: Bearer <API_TOKEN>`

- `GET /v1/activities?start=0&limit=10`
- `GET /v1/activities/latest`
- `GET /v1/activities/:id`
- `GET /v1/summary?date=YYYY-MM-DD`
- `GET /v1/sleep?date=YYYY-MM-DD`
- `GET /v1/hrv?date=YYYY-MM-DD`
- `GET /v1/readiness?date=YYYY-MM-DD`
- `GET /v1/body-battery?date=YYYY-MM-DD`
- `GET /v1/health/today`
- `GET /v1/coach/context`

`/v1/coach/context` is the endpoint intended for a running coach. It combines the latest activity with daily recovery/training metrics.

## 1. Push this project to GitHub

Create an empty **private** GitHub repository.

Then from this folder:

```sh
./scripts/push-to-git.sh git@github.com:YOUR_USER/YOUR_REPO.git
```

HTTPS also works:

```sh
./scripts/push-to-git.sh https://github.com/YOUR_USER/YOUR_REPO.git
```

## 2. Create the Cloudflare Worker + KV

In Cloudflare:

1. Workers & Pages → Create / Import repository.
2. Connect the GitHub repository.
3. Create a KV namespace, e.g. `garmin-rest-kv`.
4. Copy its namespace ID.
5. Replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` in `wrangler.jsonc`.
6. Push that change to GitHub.

The Worker expects the KV binding name to be exactly:

```text
GARMIN_KV
```

## 3. Configure secrets

Generate two different long random tokens.

Example on macOS/Linux/iSH with OpenSSL:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Store them in Cloudflare Worker secrets:

- `API_TOKEN`
- `ADMIN_TOKEN`

Never commit them to Git.

## 4. Connect Garmin once

After deployment:

```sh
export WORKER_URL="https://YOUR-WORKER.workers.dev"
export ADMIN_TOKEN="YOUR_ADMIN_TOKEN"
```

Check status:

```sh
curl "$WORKER_URL/admin/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Login:

```sh
curl -X POST "$WORKER_URL/admin/login" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"email":"YOUR_GARMIN_EMAIL","password":"YOUR_GARMIN_PASSWORD"}'
```

The password is used only for this request. The Worker persists OAuth tokens, not the password.

### MFA note

The current library does not implement interactive Garmin MFA. If Garmin requires MFA, `/admin/login` returns `GARMIN_MFA_REQUIRED`. The project already includes `PUT /admin/tokens` so a browser-assisted token flow can be added without changing the REST layer.

## 5. Test the REST API

```sh
export API_TOKEN="YOUR_API_TOKEN"
```

Latest activity:

```sh
curl "$WORKER_URL/v1/activities/latest" \
  -H "Authorization: Bearer $API_TOKEN"
```

Specific activity:

```sh
curl "$WORKER_URL/v1/activities/24213810456" \
  -H "Authorization: Bearer $API_TOKEN"
```

Coach context:

```sh
curl "$WORKER_URL/v1/coach/context" \
  -H "Authorization: Bearer $API_TOKEN"
```

## Local development (optional)

Requirements: modern Node.js and npm.

```sh
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars
npm run typecheck
npm run dev
```

For local KV, Wrangler can emulate the binding, but the production namespace ID still needs to be configured for deployment.

## Security

- Keep the repository private.
- Keep `API_TOKEN`, `ADMIN_TOKEN`, Garmin password, and Garmin OAuth tokens out of Git.
- Use different values for `API_TOKEN` and `ADMIN_TOKEN`.
- Rotate an API token if it is ever exposed.
- `ADMIN_TOKEN` can replace/delete the Garmin session, so protect it more tightly than `API_TOKEN`.
