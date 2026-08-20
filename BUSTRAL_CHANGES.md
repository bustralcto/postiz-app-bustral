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
design) — it reads from ONE fixed Google Workspace account.

**Design change (2026-08-19, confirmed in production testing)**: originally
this pointed at a per-organization subfolder (`app_bustral`'s
`ensureSubfolder`, one subfolder per client). Postiz only has ONE
"organization" for the whole Bustral community team (all clients' pages
live under it), so "one Drive connection per Postiz org" couldn't
distinguish clients anyway — a single flat folder is simpler and matches
that reality. Now every approved video from every client lands in ONE
shared Drive folder ("Videos Producidos"), and the filename itself carries
the client — `app_bustral`'s `uploadVideo` names each file
`<org-slug>_<piece-title-slug>_<YYYY-MM>.<ext>` so the community can tell
clients apart in the picker by name alone. Connect once in Postiz with
that single folder's id — no more per-client reconnection.

Own OAuth client (`GOOGLE_DRIVE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`),
deliberately separate from `app_bustral`'s own credentials for cleaner
scoping/revocation — same underlying Workspace Drive account, generated
via `scripts/get-drive-refresh-token.js` (one-time consent flow, run
inside the `postiz` container where `googleapis` is already installed).

Because `drive.file`-scoped files are private, `drive.google.com` links
don't work unauthenticated — and Postiz's generic import path
(`ThirdPartyController#importMedia` → `storage.uploadSimple(url)`) does an
unauthenticated `fetch()` of whatever URL a provider returns. Added a
small proxy route (`GoogleDriveProxyController`, `GET
/third-party/google-drive/proxy`) that holds the shared OAuth token
server-side, verifies a short-lived signed JWT (minted by the provider
itself, 5 minute TTL) instead of a user session, and streams the file
through — a real public HTTPS URL by the time Postiz's own fetch sees it.
That URL is built from `NEXT_PUBLIC_BACKEND_URL` (already required,
already a real public hostname) — NOT `BACKEND_INTERNAL_URL` (only
reachable inside the docker network, and fails
`isSafePublicHttpsUrl`/`ImportMediaDto`'s validation that this URL must be
a real public HTTPS host). Using the wrong one silently 400'd the import
while the frontend's toast claimed success regardless (a pre-existing
upstream bug in `third-party.media-library.tsx#importSelected` — it never
checks the fetch's `response.ok`).

**New files**:
- `libraries/nestjs-libraries/src/3rdparties/google-drive/google-drive.client.ts`
- `libraries/nestjs-libraries/src/3rdparties/google-drive/google-drive.provider.ts`
- `apps/backend/src/api/routes/google-drive-proxy.controller.ts`
- `scripts/get-drive-refresh-token.js` (one-time refresh-token bootstrap)

**Modified**: `libraries/nestjs-libraries/src/3rdparties/thirdparty.module.ts`,
`apps/backend/src/api/api.module.ts`

**Icon**: `apps/frontend/public/icons/third-party/google-drive-bustral.png`
— a simple generated placeholder (Drive-style tricolor triangle), not the
real Google Drive brand asset (not available to fabricate here).

**Env vars** (see `.env.example`): `GOOGLE_DRIVE_CLIENT_ID`,
`GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` — must be the
same values `app_bustral` uses for its own Drive account.

## Tarea 5 — Spotify channel (via RSS, no publish API exists)

Spotify has **no public API to publish/upload a podcast episode** for a
third-party app (confirmed — this is true of every podcast platform, not
a Postiz limitation). The only way anything shows up in Spotify is via an
RSS 2.0 feed the podcaster hosts, registered once in Spotify for
Podcasters' "already hosting elsewhere" import flow.

So `SpotifyProvider` (same `SocialProvider` shape as every other channel,
`identifier: 'spotify'`) does real Spotify OAuth only to know whose show
this is for display — `post()` makes **no Spotify API call at all**.
Publishing a post to a Spotify channel just persists it normally (generic
post workflow); it becomes visible the next time Spotify polls the feed
this fork now serves at `GET /public/podcast/:integrationId/feed.xml`
(new `PodcastFeedService`, wired into the existing public,
unauthenticated `PublicController`). Register that URL once per
organization's Spotify channel and every future published post with a
video/audio attachment shows up automatically — same mechanism every
podcast app uses (this is literally how Spotify for Podcasters' own "RSS
import" option works).

**New files**:
- `libraries/nestjs-libraries/src/integrations/social/spotify.provider.ts`
- `libraries/nestjs-libraries/src/dtos/posts/providers-settings/spotify.dto.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/podcast-feed.service.ts`

**Modified**: `libraries/nestjs-libraries/src/integrations/integration.manager.ts`,
`libraries/nestjs-libraries/src/database/prisma/database.module.ts`,
`apps/backend/src/api/routes/public.controller.ts`

**Env vars**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (register a
Spotify Developer app, redirect URI `<FRONTEND_URL>/integrations/social/spotify`).

**Icon**: `apps/frontend/public/icons/platforms/spotify.png` (converted from
the `.jpg` the user provided — every picker in the frontend hardcodes the
`.png` extension per `identifier`, no fallback to other formats).

## Tarea 6 — nightly cleanup of local media (disk fills up otherwise)

Postiz never deleted uploaded/imported media on its own — everything ever
uploaded (by hand, or imported via Tarea 4's Bustral Drive picker) stays
on `/uploads` forever. Not sustainable once the community regularly
imports full-size approved videos from Drive.

New `MediaCleanupService` (`@Cron`, `@nestjs/schedule` — already a
dependency, just never wired up before) runs nightly at 3am: deletes the
LOCAL file (`STORAGE_PROVIDER=local` only — `CloudflareStorage#removeFile`
is an upstream no-op stub, not implemented here) for any `Media` row where
every `Post` referencing it (matched by URL substring in `Post.image`,
there's no FK) is already `PUBLISHED` and the newest of those posts'
`publishDate` is more than 7 days in the past. Media still needed by a
queued/draft/errored post is never touched regardless of age.

**Explicit product decision (2026-08-20)**: NOT scoped to Drive-imported
media only — applies to every published media file past the retention
window, including anything the community uploaded by hand with no backup
elsewhere. Once deleted here it's gone for good (the already-published
post on Facebook/Instagram/etc is completely unaffected, only Postiz's own
local copy is removed). The original in Bustral's Drive folder (Tarea 4
imports) is unaffected either way — that's a separate copy in a separate
system.

**New file**: `libraries/nestjs-libraries/src/database/prisma/media/media-cleanup.service.ts`

**Modified**: `apps/backend/src/app.module.ts` (`ScheduleModule.forRoot()`),
`libraries/nestjs-libraries/src/database/prisma/database.module.ts`

## Deploy

CI builds and pushes `ghcr.io/bustralcto/postiz-app:latest` (same pattern
already used for `app_bustral`). Production's `docker-compose.yml` only
needs its `postiz.image` line changed from
`ghcr.io/gitroomhq/postiz-app:latest` to `ghcr.io/bustralcto/postiz-app:latest`
— same Postgres, Redis, Temporal, volumes, and the existing nginx
`/uploads` workaround stay untouched (nothing here requires a data
migration).
