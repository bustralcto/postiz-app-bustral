import {
  ThirdParty,
  ThirdPartyAbstract,
} from '@gitroom/nestjs-libraries/3rdparties/thirdparty.interface';
import { getGoogleDriveClient } from '@gitroom/nestjs-libraries/3rdparties/google-drive/google-drive.client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';

// Bustral Tarea 4 (.agents CONTENT_APPROVAL_FLOW / plan "Cuatro frentes",
// Frente 2): the community imports a filmmaker's video, already approved by
// the client inside app_bustral, straight from the Drive folder app_bustral
// uploaded it to — instead of downloading it from Drive and re-uploading it
// to Postiz by hand.
//
// This is NOT a general "connect your own Drive" integration (explicitly
// out of scope, see the plan) — it reads from ONE fixed Google Workspace
// Drive account, via its OWN dedicated OAuth client (deliberately separate
// from app_bustral's own credentials — see .env.example).
//
// Design note (2026-08-19, changed after production testing): Postiz has
// ONE organization for the whole Bustral team, covering every client's
// pages — there's no per-client Postiz organization to attach a separate
// Drive subfolder connection to. So this reads ONE flat shared folder
// ("Videos Producidos") containing every approved video from every client,
// connected ONCE (apiKey here = that single folder's id). app_bustral's
// content-piece.service.ts#uploadVideo names each file
// <org-slug>_<piece-title-slug>_<YYYY-MM>.<ext> so the community can still
// tell clients apart by filename in the picker.
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);

/**
 * A short-lived signed URL to this fork's own proxy route
 * (GoogleDriveProxyController), which does the authenticated Drive fetch
 * server-side and streams the bytes back. fileId also rides along in the
 * query string in plaintext (alongside the signed token that actually
 * grants access) purely so importMedia can re-derive a fresh token from an
 * expired proxy URL without needing its own separate lookup.
 */
export function buildProxyUrl(fileId: string): string {
  // Deliberately NOT BACKEND_INTERNAL_URL — that's for server-to-server
  // traffic INSIDE the docker network (e.g. http://backend:3000) and isn't
  // reachable from wherever Postiz's own outbound fetch actually runs, nor
  // does it pass isSafePublicHttpsUrl (https + a real public DNS name is
  // required — see webhook.url.validator.ts, enforced by ImportMediaDto on
  // the /third-party/:id/import route this URL is submitted to). This has
  // to be the same public https://api.postiz.bustral.com style hostname
  // NEXT_PUBLIC_BACKEND_URL already carries for the browser.
  const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
  if (!backendUrl) {
    throw new Error(
      'NEXT_PUBLIC_BACKEND_URL is not configured — needed to build the signed Drive proxy URL Postiz uses to preview/import Bustral Drive files.'
    );
  }
  const token = AuthService.signJWT({
    fileId,
    purpose: 'google-drive-import',
    exp: Math.floor(Date.now() / 1000) + 5 * 60,
  });
  return `${backendUrl}/third-party/google-drive/proxy?fileId=${encodeURIComponent(
    fileId
  )}&token=${encodeURIComponent(token)}`;
}

@ThirdParty({
  identifier: 'google-drive-bustral',
  title: 'Bustral Drive',
  description:
    'Import approved content videos from the shared Bustral Drive folder (uploaded by filmmakers via app_bustral, once the client approved each one — filenames are prefixed with the client slug).',
  position: 'media-library',
  fields: [
    {
      name: 'apiKey',
      description:
        'The shared Drive folder id for approved videos (same for every client — ask an admin if unsure). Connect once.',
      type: 'text',
      placeholder: 'Drive folder id',
    },
  ],
})
export class GoogleDriveProvider extends ThirdPartyAbstract {
  // Here "apiKey" is repurposed to hold the Drive folder id, not a secret —
  // the real credentials are the fixed GOOGLE_DRIVE_* env vars above, shared
  // by every organization. See the class-level comment for why.
  async checkConnection(
    apiKey: string
  ): Promise<false | { name: string; username: string; id: string }> {
    if (!apiKey?.trim()) return false;
    try {
      const drive = getGoogleDriveClient();
      const res = await drive.files.get({
        fileId: apiKey.trim(),
        fields: 'id, name, mimeType',
      });
      if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
        return false;
      }
      return {
        // The frontend renders "{provider.title}: {this.name}" itself
        // (ThirdPartyMediaLibraryBrowser) — including "Bustral Drive" here
        // too doubled it up as "Bustral Drive: Bustral Drive: <folder>".
        name: res.data.name || 'Videos Producidos',
        username: 'bustral-drive',
        id: apiKey.trim(),
      };
    } catch {
      return false;
    }
  }

  async listMedia(
    apiKey: string,
    data?: { page?: number }
  ): Promise<{
    results: {
      id: string;
      url: string;
      thumbnail?: string;
      name: string;
      type: 'video' | 'image';
    }[];
    pages: number;
  }> {
    const drive = getGoogleDriveClient();
    const pageSize = 20;
    const page = data?.page || 1;

    // The Drive API paginates with an opaque pageToken, not an offset — walk
    // forward from the start token-by-token to reach the requested page.
    // Fine at this scale (a client's approved-video folder, not a general
    // media library with thousands of files).
    let pageToken: string | undefined;
    let files: any[] = [];
    for (let i = 0; i < page; i++) {
      const res = await drive.files.list({
        q: `'${apiKey.trim()}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`,
        fields: 'nextPageToken, files(id, name, mimeType, thumbnailLink, webContentLink)',
        pageSize,
        pageToken,
        orderBy: 'createdTime desc',
      });
      files = res.data.files || [];
      pageToken = res.data.nextPageToken || undefined;
      if (!pageToken && i < page - 1) break; // no more pages available
    }

    return {
      results: files.map((f) => ({
        id: f.id!,
        // drive.file-scoped files are private — drive.google.com itself
        // won't serve them without our OAuth bearer token on the request,
        // and both the browser preview (this url, used directly by
        // ThirdPartyMediaLibraryBrowser for <img>/<VideoFrame>) and
        // Postiz's own unauthenticated import fetch() need a URL that just
        // works without carrying that token. buildProxyUrl mints one,
        // backed by this fork's own signed proxy route.
        url: buildProxyUrl(f.id!),
        thumbnail: f.thumbnailLink || undefined,
        name: f.name || 'bustral-video',
        type: VIDEO_MIME_TYPES.has(f.mimeType) ? ('video' as const) : ('image' as const),
      })),
      pages: pageToken ? page + 1 : page,
    };
  }

  async importMedia(
    apiKey: string,
    items: { url: string; name: string }[]
  ): Promise<{ url: string; name: string }[]> {
    // The url each item carries here is already one of our own proxy URLs
    // (built by listMedia above), but its token may be near/past its 5
    // minute TTL by the time the user actually clicks "Import" — mint a
    // fresh one from the fileId embedded in it rather than reusing it
    // as-is.
    return items
      .filter((item) => item.url)
      .map((item) => {
        const fileId = new URL(item.url).searchParams.get('fileId');
        if (!fileId) return item; // not one of ours — pass through as-is
        return { url: buildProxyUrl(fileId), name: item.name };
      });
  }

  async sendData(): Promise<string> {
    throw new Error(
      'Bustral Drive media-library provider does not support sendData'
    );
  }
}
