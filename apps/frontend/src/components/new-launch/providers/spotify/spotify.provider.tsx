'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: undefined,
  dto: undefined,
  // Matches SpotifyProvider.maxLength() in the backend
  // (libraries/nestjs-libraries/src/integrations/social/spotify.provider.ts).
  maximumCharacters: 4000,
});
