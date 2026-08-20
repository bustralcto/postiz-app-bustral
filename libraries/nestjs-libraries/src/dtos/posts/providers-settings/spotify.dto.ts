import { IsOptional, IsString } from 'class-validator';

export class SpotifyDto {
  // The RSS <item> title. Falls back to the post's own `title` field
  // (from Post.title) when not set — this only exists so an episode can
  // have a title distinct from whatever short text goes in `message`.
  @IsString()
  @IsOptional()
  episodeTitle?: string;
}
