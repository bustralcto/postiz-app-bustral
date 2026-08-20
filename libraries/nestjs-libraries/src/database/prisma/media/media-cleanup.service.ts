import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service'
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory'

// Bustral fix (2026-08-20): Postiz never deletes uploaded/imported media —
// everything that ever gets uploaded (by hand, or imported from Bustral
// Drive via Tarea 4) stays on disk forever. That's not sustainable once
// the community is importing full-size videos from Drive regularly.
//
// This sweeps every Media row whose file is only referenced by posts that
// are ALL already PUBLISHED, and where the newest of those posts'
// publishDate is more than RETENTION_DAYS in the past — deliberately not
// scoped to Drive-imported media only (explicit product decision
// 2026-08-20, accepting that hand-uploaded media with no backup elsewhere
// is deleted for good too, same as Drive-imported media whose original
// still lives safely in Drive). A post's own publish record on
// Facebook/Instagram/etc is completely unaffected — this only removes
// Postiz's own local copy.
//
// Media still referenced by a post that's NOT published yet (QUEUE, DRAFT,
// ERROR) is never touched, regardless of age — deleting a file a queued
// post still needs would break that post's publish.
const RETENTION_DAYS = 7

@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name)
  private storage = UploadFactory.createStorage()

  constructor(
    private _media: PrismaRepository<'media'>,
    private _post: PrismaRepository<'post'>
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    try {
      const deleted = await this.sweep()
      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} media file(s) older than ${RETENTION_DAYS} days past publish`)
      }
    } catch (err) {
      this.logger.error('Media cleanup sweep failed (will retry next run)', err as Error)
    }
  }

  /** Exposed separately from the cron handler so it's easy to call manually / test in isolation. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

    const candidates = await this._media.model.media.findMany({
      where: { deletedAt: null },
      select: { id: true, path: true },
    })
    if (!candidates.length) return 0

    let deletedCount = 0

    for (const media of candidates) {
      // Media has no FK to Post — posts embed their media list as a JSON
      // string in Post.image. Match by substring of the file's public URL,
      // which is enough here: these are randomly-generated filenames, not
      // ambiguous prefixes of each other.
      const referencingPosts = await this._post.model.post.findMany({
        where: {
          deletedAt: null,
          image: { contains: media.path },
        },
        select: { state: true, publishDate: true },
      })

      if (referencingPosts.length === 0) continue // never used in any post — leave it, not this sweep's job
      if (referencingPosts.some((p) => p.state !== 'PUBLISHED')) continue // still needed by a pending post
      const newestPublish = referencingPosts.reduce(
        (max, p) => (p.publishDate > max ? p.publishDate : max),
        referencingPosts[0].publishDate
      )
      if (newestPublish > cutoff) continue // published too recently, keep for now

      try {
        // Media.path stores the PUBLIC url (FRONTEND_URL + /uploads/...),
        // but LocalStorage#removeFile expects a real filesystem path — see
        // LocalStorage#uploadSimple/uploadFile, which build that same
        // public url from process.env.FRONTEND_URL + '/uploads' +
        // innerPath, where innerPath is what actually gets appended to
        // UPLOAD_DIRECTORY on disk. Re-deriving it here rather than
        // storing a second column, to avoid a migration for a field only
        // this sweep needs.
        //
        // NOTE: CloudflareStorage#removeFile is a no-op today (upstream
        // stub, not something this fix implements) — on that
        // STORAGE_PROVIDER this sweep only marks the DB row deleted, it
        // never actually frees remote storage. Local disk is the only
        // storage provider this cleanup currently reclaims space from.
        const uploadsPrefix = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/uploads`
        const innerPath = media.path.startsWith(uploadsPrefix) ? media.path.slice(uploadsPrefix.length) : null
        if (innerPath && process.env.UPLOAD_DIRECTORY) {
          await this.storage.removeFile(`${process.env.UPLOAD_DIRECTORY}${innerPath}`)
        }
      } catch (err) {
        // Already gone from disk, or a storage provider that can't resolve
        // this path — either way, still mark it deleted below so this row
        // stops being re-checked every night.
        this.logger.warn(`Could not remove file for media ${media.id} (continuing): ${(err as Error).message}`)
      }

      await this._media.model.media.update({
        where: { id: media.id },
        data: { deletedAt: new Date() },
      })
      deletedCount++
    }

    return deletedCount
  }
}
