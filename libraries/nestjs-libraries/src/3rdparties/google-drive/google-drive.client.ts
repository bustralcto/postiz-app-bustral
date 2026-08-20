import { google } from 'googleapis';

// Shared by GoogleDriveProvider (listing/checking a folder) and
// GoogleDriveProxyController (streaming a file's bytes for import) — kept
// in its own module so the proxy controller doesn't have to instantiate the
// whole @ThirdParty-decorated provider class just to reuse this client.
// See google-drive.provider.ts for why this account is fixed and shared
// across every Postiz organization, not per-org OAuth.
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export function getGoogleDriveClient() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Drive import is not configured (GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN missing) — this must be the SAME Bustral Workspace account app_bustral itself uploads content videos to.'
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken, scope: DRIVE_SCOPES.join(' ') });
  return google.drive({ version: 'v3', auth });
}
