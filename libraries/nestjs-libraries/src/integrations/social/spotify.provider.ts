import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { SpotifyDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/spotify.dto';

// Bustral Tarea 5 (plan "Cuatro frentes", Frente 2). Spotify has NO public
// API to upload/publish a podcast episode for a third-party app — Spotify
// (like every other podcast app) only ever discovers new episodes by
// polling an RSS feed the podcaster hosts themselves (this is literally
// how Spotify for Podcasters/Anchor works too, just with Spotify hosting
// the feed for you instead of a separate app). So "post" here does NOT
// call any Spotify API — connecting a channel is a normal Spotify OAuth
// login just to know whose show this is (for display), and "posting" an
// episode only means: attach the episode's audio/video to a Post against
// this integration, which is enough for it to show up in the public RSS
// feed this fork serves at
// GET /public/podcast/:integrationId/feed.xml (see public.controller.ts).
// The podcaster registers that URL ONCE in Spotify for Podcasters
// ("already have a podcast hosted elsewhere?" / RSS import flow); every
// new episode posted from here shows up in Spotify automatically without
// Postiz ever calling a Spotify API to publish it.
export class SpotifyProvider extends SocialAbstract implements SocialProvider {
  identifier = 'spotify';
  name = 'Spotify (via RSS)';
  isBetweenSteps = false;
  editor = 'normal' as const;
  scopes = ['user-read-email', 'user-read-private'];
  dto = SpotifyDto;

  maxLength() {
    return 4000; // Spotify's own episode description limit
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const response = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    const { access_token, refresh_token, expires_in } = await response.json();
    const userInfo = await this.getUserInfo(access_token);

    return {
      refreshToken: refresh_token || refreshToken, // Spotify may omit a new one
      expiresIn: expires_in,
      accessToken: access_token,
      id: userInfo.id,
      name: userInfo.name,
      picture: userInfo.picture || '',
      username: userInfo.username,
    };
  }

  async generateAuthUrl() {
    const state = makeId(32);
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/social/spotify`;

    const url =
      `https://accounts.spotify.com/authorize` +
      `?response_type=code` +
      `&client_id=${process.env.SPOTIFY_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(this.scopes.join(' '))}` +
      `&state=${state}`;

    return {
      url,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/social/spotify${
      params.refresh ? `?refresh=${params.refresh}` : ''
    }`;

    const tokenResponse = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: params.code,
      }),
    });

    const { access_token, refresh_token, expires_in } =
      await tokenResponse.json();

    const userInfo = await this.getUserInfo(access_token);

    return {
      id: userInfo.id,
      name: userInfo.name,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      picture: userInfo.picture || '',
      username: userInfo.username,
    };
  }

  private async getUserInfo(
    accessToken: string
  ): Promise<{ id: string; name: string; username: string; picture?: string }> {
    const userResponse = await fetch('https://api.spotify.com/v1/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const user = await userResponse.json();

    return {
      id: String(user.id),
      name: user.display_name || user.id,
      username: user.id,
      picture: user.images?.[0]?.url || '',
    };
  }

  // No Spotify API call at all — see the class-level comment. The post is
  // simply persisted (by the generic post workflow, before this runs) and
  // becomes visible the next time Spotify (or any podcast app) polls this
  // integration's RSS feed. "posted" here means "available in the feed",
  // not "confirmed live on Spotify" — Spotify's own polling interval
  // (usually within a few hours) is outside Postiz's control, same as any
  // other RSS-based podcast host.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<SpotifyDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;

    const hasAudioOrVideo = (firstPost.media || []).some(
      (m) => m.type === 'video'
    );
    if (!hasAudioOrVideo) {
      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'error',
          pendingData: undefined,
        },
      ];
    }

    return [
      {
        id: firstPost.id,
        postId: makeId(10),
        releaseURL: `${process.env.FRONTEND_URL}/public/podcast/${integration.id}/feed.xml`,
        status: 'posted',
      },
    ];
  }
}
