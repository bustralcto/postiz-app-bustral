# Bustral fork — changes vs upstream

Tracked here so re-syncing with `upstream/main` (gitroomhq/postiz-app) is
easy to redo: every change below is deliberate and small, not a deep fork.
See `app_bustral`'s own plan doc for the full context
(`.claude/plans/snuggly-weaving-pebble.md` at the time this was written,
Frente 2).

## Tarea 1 — `/uploads` always 404ing in production

`apps/frontend/next.config.js`'s `redirects()`/`rewrites()` only run at
`next build` time, so gating them on `STORAGE_PROVIDER` baked in whatever
value happened to be set during the image build (never the real runtime
`.env`). Moved the local-vs-remote-storage check into the route handler
itself (`apps/frontend/src/app/(app)/api/uploads/[[...path]]/route.ts`),
which reads `process.env` per request. `next.config.js` now
rewrites/redirects unconditionally.

**Files**: `apps/frontend/next.config.js`,
`apps/frontend/src/app/(app)/api/uploads/[[...path]]/route.ts`

## Tarea 2 — Facebook carousels mixing photos + a video failed

A carousel post uploaded EVERY media item to `/photos`, including `.mp4`
ones whenever the first item happened to be a photo — Facebook rejects
that with code 100/subcode 1366046 (it tries to decode the video as an
image). Now each item goes to `/videos` or `/photos` based on its real
extension, and any uploaded video is polled via the existing
`fbVideoStatus` check before the `/feed` call attaches it via
`attached_media`, so a mixed carousel doesn't race its own video
processing. A true single-video post (exactly one item, and it's a video)
is unaffected — still takes the dedicated `/videos` + reel URL path.

**File**: `libraries/nestjs-libraries/src/integrations/social/facebook.provider.ts`

## Tarea 3 — size limits too strict / publish timeout

- **Image size**: `getMaxSize()` capped images at 10 MB, well under Meta's
  real ~30 MB ceiling for a feed photo. Both image and video caps are now
  configurable via `BUSTRAL_MAX_PHOTO_SIZE_MB` / `BUSTRAL_MAX_VIDEO_SIZE_MB`
  env vars (default 30 MB / 4096 MB).
- **Publish timeout**: already fixed upstream — `post.workflow` v1.0.7+
  gives the publish mutation activity a 30-minute heartbeating
  `startToCloseTimeout` (`proxyMutationTaskQueue` in
  `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.8.ts`),
  and new posts already route to v1.0.8. No change needed.

**File**: `libraries/nestjs-libraries/src/upload/custom.upload.validation.ts`

## Tarea 4 — "Import from Bustral Drive" media-library provider

New `media-library`-position third-party provider, same framework already
used by Reel.Farm/HeyGen (`libraries/nestjs-libraries/src/3rdparties/`).
Lets the community import a filmmaker's video — already uploaded to Drive
and approved by the client inside `app_bustral` — directly into Postiz's
media picker, instead of downloading it from Drive and re-uploading it by
hand.

**Not** a general "connect your own Drive" feature (out of scope by
design) — it reads from ONE fixed Google Workspace account, the exact same
one `app_bustral`'s own `google-drive.service.ts` uses (`drive.file`
scope). What's per-organization is only which Drive **subfolder** belongs
to that org's client — set once via the existing "add API key" third-party
UI, where the `apiKey` field is repurposed to hold the Drive folder id
(same value as the subfolder `app_bustral`'s `ensureSubfolder` creates for
that organization, so both sides agree on the same folder without any
extra coordination).

Because `drive.file`-scoped files are private, `drive.google.com` links
don't work unauthenticated — and Postiz's generic import path
(`ThirdPartyController#importMedia` → `storage.uploadSimple(url)`) does an
unauthenticated `fetch()` of whatever URL a provider returns. Added a
small proxy route (`GoogleDriveProxyController`, `GET
/third-party/google-drive/proxy`) that holds the shared OAuth token
server-side, verifies a short-lived signed JWT (minted by the provider
itself, 5 minute TTL) instead of a user session, and streams the file
through — a real public HTTPS URL by the time Postiz's own fetch sees it.

**New files**:
- `libraries/nestjs-libraries/src/3rdparties/google-drive/google-drive.client.ts`
- `libraries/nestjs-libraries/src/3rdparties/google-drive/google-drive.provider.ts`
- `apps/backend/src/api/routes/google-drive-proxy.controller.ts`

**Modified**: `libraries/nestjs-libraries/src/3rdparties/thirdparty.module.ts`,
`apps/backend/src/api/api.module.ts`

**Env vars** (see `.env.example`): `GOOGLE_DRIVE_CLIENT_ID`,
`GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` — must be the
same values `app_bustral` uses for its own Drive account.

## Deploy

CI builds and pushes `ghcr.io/bustralcto/postiz-app:latest` (same pattern
already used for `app_bustral`). Production's `docker-compose.yml` only
needs its `postiz.image` line changed from
`ghcr.io/gitroomhq/postiz-app:latest` to `ghcr.io/bustralcto/postiz-app:latest`
— same Postgres, Redis, Temporal, volumes, and the existing nginx
`/uploads` workaround stay untouched (nothing here requires a data
migration).
