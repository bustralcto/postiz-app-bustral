#!/usr/bin/env node
// One-time script to mint a refresh_token for the Postiz Google Drive
// OAuth client, reading GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET
// straight from Postiz's own .env (already pasted in there) instead of
// having to pass them again as env vars on the command line.
//
// Usage (run from the repo root, or wherever .env lives):
//   1. node scripts/get-drive-refresh-token.js
//      -> prints an authorization URL. Open it, log in with the SAME
//      Google Workspace account app_bustral's Drive uploads already use,
//      approve the consent screen.
//   2. Google redirects your browser to the redirect URI with a
//      ?code=... query param (the page itself may 404 or hang — that's
//      fine, the code you need is in the browser's address bar).
//   3. Paste ONLY that code back:
//      node scripts/get-drive-refresh-token.js "<the code>"
//   4. It prints the refresh_token — put that in Postiz's .env as
//      GOOGLE_DRIVE_REFRESH_TOKEN.

// No `require('dotenv')` on purpose — when run inside the postiz
// container (docker exec postiz node ...), env_file already loaded these
// into process.env at container start, no .env file needs to be read from
// disk. `googleapis` also comes from the app's own node_modules, so this
// only works run from inside the container / repo root, not from an
// arbitrary /tmp path with nothing installed.
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_DRIVE_REDIRECT_URI ||
  'https://postiz.bustral.com/oauth/google-drive/callback';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error(
      'Missing GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET in .env — ' +
        'paste the values from the new Google Cloud OAuth client before running this.'
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const codeFromArgs = process.argv[2];

  if (!codeFromArgs) {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline', // required to get a refresh_token back
      prompt: 'consent', // forces a fresh refresh_token even if this account already consented before
      scope: SCOPES,
    });
    console.log('\n1. Open this URL, log in with the Bustral Workspace Drive account:\n');
    console.log(url);
    console.log(
      '\n2. After approving, copy the `code` param from the redirected URL and run:\n'
    );
    console.log(`   node scripts/get-drive-refresh-token.js "<code>"\n`);
    return;
  }

  const { tokens } = await oauth2Client.getToken(codeFromArgs);
  console.log('\nSuccess. Put this in Postiz .env:\n');
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
  if (!tokens.refresh_token) {
    console.log(
      '\n⚠️  No refresh_token came back — this usually means the account already\n' +
        'granted consent to this exact client before without `prompt=consent`,\n' +
        'or offline access was not actually requested. Revoke this app\'s access\n' +
        'at https://myaccount.google.com/permissions and try again from step 1.'
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
