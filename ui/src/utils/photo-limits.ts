/**
 * Most photos one album may hold.
 *
 * A deliberate duplicate of `MAX_PHOTOS_PER_ALBUM` in `server/src/constants.ts` — the two
 * workspaces never import from each other, so both copies must change together.
 *
 * The UI is the *primary* place this is enforced, not a convenience check in front of an
 * authoritative server one. The upload endpoint mints one presigned URL per file and
 * `uploadFiles` fires them in parallel, so fifty requests against a 990-photo album all
 * see 990 and all pass. Only the UI knows the size of the batch before it starts, which
 * is what makes the check meaningful here and approximate there.
 */
export const MAX_PHOTOS_PER_ALBUM = 1000;

/**
 * How many photos may still be added to an album.
 *
 * Clamped at zero so an album already over the cap reports no free slots rather than a
 * negative number. Being over the cap must never block deleting or moving photos — only
 * adding them — so nothing here is used to gate those.
 *
 * @param currentCount Photos already in the album.
 * @returns Remaining slots, never below zero.
 */
export const remainingPhotoSlots = (currentCount: number): number =>
  Math.max(0, MAX_PHOTOS_PER_ALBUM - currentCount);
