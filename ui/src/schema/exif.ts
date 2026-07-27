import type { ExifTags, FileTags, ValueTag } from 'exifreader';

/**
 * EXIF payload as returned by ExifReader, plus the equirectangular marker used
 * to detect 360 photos. Lives in a plain module because `<script setup>` cannot
 * declare named exports.
 */
export type ExifData = ExifTags & FileTags & { ProjectionType?: ValueTag };
