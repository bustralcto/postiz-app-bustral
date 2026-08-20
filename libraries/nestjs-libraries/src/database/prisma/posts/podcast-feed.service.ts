import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

// Bustral Tarea 5 (spotify.provider.ts has the full design rationale):
// Spotify has no publish API, so a "podcast" channel here is really just a
// public RSS 2.0 feed of that integration's PUBLISHED posts. Standalone
// from PostsRepository/PostsService on purpose — this only ever reads
// published state for one integration and needs to stay simple enough to
// audit as "definitely can't leak an unpublished/draft post", rather than
// share a repository whose other methods assume an authenticated org
// context.
@Injectable()
export class PodcastFeedService {
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>
  ) {}

  async buildFeedXml(integrationId: string): Promise<string> {
    const integration = await this._integration.model.integration.findFirst({
      where: {
        id: integrationId,
        providerIdentifier: 'spotify',
        deletedAt: null,
      },
    });

    if (!integration) {
      throw new NotFoundException('Podcast channel not found');
    }

    const posts = await this._post.model.post.findMany({
      where: {
        integrationId,
        state: 'PUBLISHED',
        deletedAt: null,
      },
      orderBy: { publishDate: 'desc' },
      take: 200,
    });

    const items = posts
      .map((post) => {
        const media: Array<{ type: string; path: string }> = safeParseMedia(
          post.image
        );
        const episodeAudio = media.find(
          (m) => m.type === 'video' || hasExtension(m.path, 'mp4')
        );
        if (!episodeAudio) return null; // no attachment, nothing to enclose

        const title = escapeXml(post.title || firstLine(post.content) || 'Episode');
        const description = escapeXml(post.description || post.content || '');
        const pubDate = new Date(post.publishDate).toUTCString();
        const guid = escapeXml(post.id);

        return `    <item>
      <title>${title}</title>
      <description>${description}</description>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${escapeXml(episodeAudio.path)}" type="video/mp4" />
    </item>`;
      })
      .filter((x): x is string => x !== null);

    const channelTitle = escapeXml(integration.name || 'Podcast');
    const channelImage = integration.picture
      ? `    <image><url>${escapeXml(integration.picture)}</url><title>${channelTitle}</title></image>\n`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${channelTitle}</title>
    <link>${escapeXml(process.env.FRONTEND_URL || '')}</link>
    <description>${channelTitle}</description>
${channelImage}${items.join('\n')}
  </channel>
</rss>`;
  }
}

function firstLine(content: string | null | undefined): string {
  return (content || '').split('\n')[0].slice(0, 200);
}

function safeParseMedia(raw: string | null): Array<{ type: string; path: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
