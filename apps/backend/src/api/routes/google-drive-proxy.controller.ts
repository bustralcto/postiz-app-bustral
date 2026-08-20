import {
  Controller,
  Get,
  HttpException,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { getGoogleDriveClient } from '@gitroom/nestjs-libraries/3rdparties/google-drive/google-drive.client';

// Deliberately NOT in third-party.controller.ts / authenticatedController
// (api.module.ts) — this route has no user session to check. Its own
// short-lived signed token (minted by GoogleDriveProvider#importMedia) IS
// the auth, because Postiz's generic import flow
// (ThirdPartyController#importMedia -> storage.uploadSimple(url)) does an
// UNAUTHENTICATED fetch() of whatever URL a third-party's importMedia
// returns, and Drive itself won't serve a drive.file-scoped (private) file
// without the Bustral Workspace OAuth token on the request. This route
// bridges that gap: it holds that one shared OAuth token server-side,
// verifies the caller presented a token this backend itself minted
// (proving the request came from Postiz's own import flow, not an
// arbitrary internet client), and streams the file through.
@ApiTags('Third Party')
@Controller('/third-party/google-drive')
export class GoogleDriveProxyController {
  @Get('/proxy')
  async proxy(@Query('token') token: string, @Res() res: Response) {
    if (!token) {
      throw new HttpException('Missing token', 400);
    }

    let payload: any;
    try {
      payload = AuthService.verifyJWT(token);
    } catch {
      throw new HttpException('Invalid or expired token', 401);
    }

    if (payload?.purpose !== 'google-drive-import' || !payload?.fileId) {
      throw new HttpException('Invalid token', 401);
    }

    const drive = getGoogleDriveClient();
    const meta = await drive.files.get({
      fileId: payload.fileId,
      fields: 'name, mimeType, size',
    });

    const stream = await drive.files.get(
      { fileId: payload.fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader(
      'Content-Type',
      meta.data.mimeType || 'application/octet-stream'
    );
    if (meta.data.size) {
      res.setHeader('Content-Length', meta.data.size);
    }

    stream.data
      .on('error', (err: Error) => {
        // Headers are likely already flushed by the time a mid-stream Drive
        // error surfaces — end the response rather than trying to send a
        // JSON error body through res, and let the caller's own fetch()
        // see a truncated/failed download.
        console.error('[google-drive-proxy] stream error:', err);
        res.destroy(err);
      })
      .pipe(res);
  }
}
