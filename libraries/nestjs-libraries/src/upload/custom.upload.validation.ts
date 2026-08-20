import {
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
]);

@Injectable()
export class CustomFileValidationPipe implements PipeTransform {
  async transform(value: any) {
    if (!value || typeof value !== 'object') {
      return value;
    }

    // Skip non-file parameters (org, body, query, etc.)
    if (!('buffer' in value) && !('mimetype' in value) && !('fieldname' in value)) {
      return value;
    }

    if (!value.buffer || !Buffer.isBuffer(value.buffer)) {
      throw new BadRequestException('Invalid file upload.');
    }

    const detected = await fileTypeFromBuffer(value.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new BadRequestException('Unsupported file type.');
    }

    const maxSize = getMaxSize(detected.mime);
    if (value.size > maxSize) {
      throw new BadRequestException(
        `File size exceeds the maximum allowed size of ${maxSize} bytes.`
      );
    }

    value.mimetype = detected.mime;
    const safeBase = (value.originalname || 'upload')
      .replace(/\.[^./\\]*$/, '')
      .replace(/[\\/]/g, '_')
      .slice(0, 100) || 'upload';
    value.originalname = `${safeBase}.${detected.ext}`;

    return value;
  }

}

// Bustral fix: 10 MB for images was well under Meta's real ceiling
// (~30 MB for a Facebook/Instagram feed photo), rejecting normal
// camera/export output before it ever reached Facebook's own API. Both
// limits are now configurable via env vars instead of hardcoded again,
// defaulting to Meta's actual documented limits (confirm against Meta's
// docs again if they change — they do, periodically).
export function getMaxSize(mimeType: string): number {
  if (mimeType.startsWith('image/')) {
    return (
      Number(process.env.BUSTRAL_MAX_PHOTO_SIZE_MB || '30') * 1024 * 1024
    );
  } else if (mimeType.startsWith('video/')) {
    return (
      Number(process.env.BUSTRAL_MAX_VIDEO_SIZE_MB || '4096') * 1024 * 1024
    );
  } else {
    throw new BadRequestException('Unsupported file type.');
  }
}
