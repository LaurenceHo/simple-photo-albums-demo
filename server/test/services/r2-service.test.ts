import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PHOTO_METADATA_KEYS } from '../../src/constants';
import R2Service, { R2Config } from '../../src/services/r2-service';

const r2Mock = mockClient(S3Client);

const testR2Config: R2Config = {
  accountId: 'test-account',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key',
  cdnUrl: '',
};

describe('R2Service', () => {
  let r2Service: R2Service;

  beforeEach(() => {
    r2Mock.reset();
    r2Service = new R2Service(testR2Config);
  });

  describe('findAll', () => {
    /** One listed object, with only the fields `toPhoto` reads. */
    const r2Object = (key: string, customMetadata?: Record<string, string>) => ({
      key,
      size: 1024,
      uploaded: new Date('2025-01-01'),
      ...(customMetadata ? { customMetadata } : {}),
    });

    /** A stub of the `BUCKET` binding whose `list` returns each page in turn. */
    const bucketReturning = (...pages: unknown[]) => {
      const list = vi.fn();
      for (const page of pages) {
        list.mockResolvedValueOnce(page);
      }
      return { list } as unknown as R2Bucket & { list: ReturnType<typeof vi.fn> };
    };

    it('should return array of photos from listed R2 objects', async () => {
      const bucket = bucketReturning({ objects: [r2Object('album/test-photo.jpg')], truncated: false });

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        key: 'album/test-photo.jpg',
        size: 1024,
        lastModified: new Date('2025-01-01').toISOString(),
        url: `${r2Service.cdnURL}/album/test-photo.jpg`,
      });
    });

    it('should handle an empty listing', async () => {
      const bucket = bucketReturning({ objects: [], truncated: false });

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result).toEqual([]);
    });

    it('should request custom metadata, and skip the folder marker on the first page', async () => {
      const bucket = bucketReturning({ objects: [], truncated: false });

      await r2Service.findAll(bucket, 'album/');

      expect(bucket.list).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: 'album/',
          include: ['customMetadata'],
          startAfter: 'album/',
        }),
      );
    });

    // The bug this guards fails silently: a single-page listing passes whether or not
    // the loop exists, while a real album over one page loses every photo after the
    // first. With `include` the page size is variable and undocumented, so a truncated
    // response is not a rare edge case.
    it('should follow the cursor until the listing is exhausted', async () => {
      const bucket = bucketReturning(
        { objects: [r2Object('album/one.jpg')], truncated: true, cursor: 'cursor-1' },
        { objects: [r2Object('album/two.jpg')], truncated: true, cursor: 'cursor-2' },
        { objects: [r2Object('album/three.jpg')], truncated: false },
      );

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result.map((photo) => photo.key)).toEqual([
        'album/one.jpg',
        'album/two.jpg',
        'album/three.jpg',
      ]);
      expect(bucket.list).toHaveBeenCalledTimes(3);
      // Page two onwards is positioned by the cursor, so `startAfter` must be gone:
      // sending both is contradictory.
      expect(bucket.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor-1' }));
      expect(bucket.list.mock.calls[1]?.[0]).not.toHaveProperty('startAfter');
    });

    it('should carry latitude, longitude and takenAt from custom metadata', async () => {
      const bucket = bucketReturning({
        objects: [
          r2Object('album/pinned.jpg', {
            latitude: '-36.8484',
            longitude: '174.7633',
            takenat: '2025-01-01T10:00:00.000Z',
          }),
        ],
        truncated: false,
      });

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result[0]).toMatchObject({
        latitude: -36.8484,
        longitude: 174.7633,
        takenAt: '2025-01-01T10:00:00.000Z',
      });
    });

    // Every photo predating the EXIF scan is in this state, so it is the common case
    // rather than an edge one.
    it('should return a photo with no custom metadata exactly as before', async () => {
      const bucket = bucketReturning({ objects: [r2Object('album/plain.jpg')], truncated: false });

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result[0]).not.toHaveProperty('latitude');
      expect(result[0]).not.toHaveProperty('longitude');
      expect(result[0]).not.toHaveProperty('takenAt');
    });

    // Custom metadata is a writable string map, so a malformed value must not become a
    // `NaN` that reaches the map and places a pin nowhere without reporting anything.
    it.each([
      ['a non-numeric value', { latitude: 'not-a-number', longitude: '174.7' }],
      ['an empty string, which Number() reads as 0', { latitude: '', longitude: '174.7' }],
      ['a latitude beyond the poles', { latitude: '91', longitude: '174.7' }],
      ['a longitude beyond the meridian', { latitude: '-36.8', longitude: '181' }],
      ['only one of the pair', { latitude: '-36.8' }],
    ])('should drop coordinates for %s', async (_label, customMetadata) => {
      const bucket = bucketReturning({
        objects: [r2Object('album/bad.jpg', customMetadata)],
        truncated: false,
      });

      const result = await r2Service.findAll(bucket, 'album/');

      expect(result[0]).not.toHaveProperty('latitude');
      expect(result[0]).not.toHaveProperty('longitude');
    });
  });

  describe('create', () => {
    it('should return true when file is uploaded successfully', async () => {
      r2Mock.on(PutObjectCommand).resolves({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await r2Service.create({
        Bucket: 'test-bucket',
        Key: 'test-photo.jpg',
        Body: 'test-content',
      });

      expect(result).toBe(true);
    });

    it('should return false when upload fails', async () => {
      r2Mock.on(PutObjectCommand).resolves({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await r2Service.create({
        Bucket: 'test-bucket',
        Key: 'test-photo.jpg',
        Body: 'test-content',
      });

      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('should return true when objects are deleted successfully', async () => {
      r2Mock.on(DeleteObjectsCommand).resolves({
        $metadata: { httpStatusCode: 200 },
        Deleted: [{ Key: 'test-photo.jpg' }],
      });

      const result = await r2Service.delete({
        Bucket: 'test-bucket',
        Delete: { Objects: [{ Key: 'test-photo.jpg' }] },
      });

      expect(result).toBe(true);
    });

    it('should return false when deletion fails', async () => {
      r2Mock.on(DeleteObjectsCommand).resolves({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await r2Service.delete({
        Bucket: 'test-bucket',
        Delete: { Objects: [{ Key: 'test-photo.jpg' }] },
      });

      expect(result).toBe(false);
    });
  });

  describe('copy', () => {
    it('should return true when object is copied successfully', async () => {
      r2Mock.on(CopyObjectCommand).resolves({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await r2Service.copy({
        Bucket: 'test-bucket',
        CopySource: 'source-bucket/test-photo.jpg',
        Key: 'test-photo-copy.jpg',
      });

      expect(result).toBe(true);
    });

    it('should return false when copy fails', async () => {
      r2Mock.on(CopyObjectCommand).resolves({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await r2Service.copy({
        Bucket: 'test-bucket',
        CopySource: 'source-bucket/test-photo.jpg',
        Key: 'test-photo-copy.jpg',
      });

      expect(result).toBe(false);
    });
  });

  describe('checkIfFileExists', () => {
    it('should return true when file exists', async () => {
      r2Mock.on(HeadObjectCommand).resolves({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await r2Service.checkIfFileExists({
        Bucket: 'test-bucket',
        Key: 'test-photo.jpg',
      });

      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      r2Mock.on(HeadObjectCommand).rejects({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });

      const result = await r2Service.checkIfFileExists({
        Bucket: 'test-bucket',
        Key: 'test-photo.jpg',
      });

      expect(result).toBe(false);
    });
  });

  describe('checkIfBucketExists', () => {
    it('should return true when bucket exists', async () => {
      r2Mock.on(HeadBucketCommand).resolves({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await r2Service.checkIfBucketExists({
        Bucket: 'test-bucket',
      });

      expect(result).toBe(true);
    });

    it('should return false when bucket does not exist', async () => {
      r2Mock.on(HeadBucketCommand).rejects({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });

      const result = await r2Service.checkIfBucketExists({
        Bucket: 'test-bucket',
      });

      expect(result).toBe(false);
    });
  });

  describe('listObjects', () => {
    it('should return ListObjectsV2CommandOutput when successful', async () => {
      const mockResponse = {
        Contents: [
          {
            Key: 'test-photo.jpg',
            Size: 1024,
            LastModified: new Date('2025-01-01'),
          },
        ],
      };

      r2Mock.on(ListObjectsV2Command).resolves(mockResponse);

      const result = await r2Service.listObjects({
        Bucket: 'test-bucket',
      });

      expect(result).toEqual(mockResponse);
    });
  });

  describe('read', () => {
    it('should parse JSON body from R2 object', async () => {
      const jsonData = { key: 'value', count: 42 };
      r2Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: () => Promise.resolve(JSON.stringify(jsonData)),
        } as any,
      });

      const result = await r2Service.read({ Bucket: 'test-bucket', Key: 'data.json' });

      expect(result).toEqual(jsonData);
    });

    it('should throw when Body is empty', async () => {
      r2Mock.on(GetObjectCommand).resolves({ Body: undefined });

      await expect(r2Service.read({ Bucket: 'test-bucket', Key: 'missing.json' })).rejects.toThrow(
        'No data found in the R2 object',
      );
    });

    it('should throw when Body contains invalid JSON', async () => {
      r2Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: () => Promise.resolve('not-json'),
        } as any,
      });

      await expect(r2Service.read({ Bucket: 'test-bucket', Key: 'bad.json' })).rejects.toThrow();
    });
  });

  describe('getPresignedUploadUrl', () => {
    it('should return a presigned URL string', async () => {
      const result = await r2Service.getPresignedUploadUrl(
        'test-bucket',
        'photos/test.jpg',
        'image/jpeg',
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('test-bucket');
    });

    it('should accept custom expiresIn', async () => {
      const result = await r2Service.getPresignedUploadUrl(
        'test-bucket',
        'photos/test.jpg',
        'image/png',
        300,
      );

      expect(typeof result).toBe('string');
    });
  });

  describe('checkIfFileExists - non-404 errors', () => {
    it('should re-throw non-NotFound errors', async () => {
      r2Mock.on(HeadObjectCommand).rejects({
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });

      await expect(
        r2Service.checkIfFileExists({ Bucket: 'test-bucket', Key: 'forbidden.jpg' }),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    });
  });

  describe('checkIfBucketExists - non-404 errors', () => {
    it('should re-throw non-NotFound errors', async () => {
      r2Mock.on(HeadBucketCommand).rejects({
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });

      await expect(
        r2Service.checkIfBucketExists({ Bucket: 'forbidden-bucket' }),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    });
  });
});

/**
 * These exercise the real service against a mocked S3 client and a stubbed binding.
 *
 * The route-level tests replace the whole `R2Service` class, so they can only show that
 * the controller passed a value to a stub — they would stay green if the command this
 * class builds lost `ContentType`, `MetadataDirective` or its byte range entirely.
 */
describe('R2Service metadata and counting', () => {
  let service: R2Service;

  const bucketListing = (...pages: unknown[]) => {
    const list = vi.fn();
    for (const page of pages) list.mockResolvedValueOnce(page);
    return { list } as unknown as R2Bucket & { list: ReturnType<typeof vi.fn> };
  };

  const objects = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ key: `album/p${i}.jpg` }));

  beforeEach(() => {
    r2Mock.reset();
    service = new R2Service(testR2Config);
  });

  describe('replaceCustomMetadata', () => {
    const copyInput = () => r2Mock.commandCalls(CopyObjectCommand)[0]?.args[0]?.input;

    beforeEach(() => {
      r2Mock.on(CopyObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });
    });

    // REPLACE drops the content type along with the metadata, and a photo that comes back
    // as application/octet-stream downloads instead of rendering.
    it('should send the content type alongside the replaced metadata', async () => {
      await service.replaceCustomMetadata(
        'test-bucket',
        'album/photo.jpg',
        { latitude: '-36.8', longitude: '174.7', hasgps: 'true' },
        'image/webp',
      );

      expect(copyInput()).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'album/photo.jpg',
        MetadataDirective: 'REPLACE',
        ContentType: 'image/webp',
        Metadata: { latitude: '-36.8', longitude: '174.7', hasgps: 'true' },
      });
    });

    // Setting it to undefined is not the same as omitting it; only omission lets the
    // copy fall back rather than asserting an empty content type.
    it('should omit the content type when the source had none', async () => {
      await service.replaceCustomMetadata('test-bucket', 'album/photo.jpg', {}, undefined);

      expect(copyInput()).not.toHaveProperty('ContentType');
      expect(copyInput()?.MetadataDirective).toBe('REPLACE');
    });

    it('should copy the object onto itself, in place', async () => {
      await service.replaceCustomMetadata('test-bucket', 'album/photo.jpg', {}, 'image/jpeg');

      expect(copyInput()?.CopySource).toBe('/test-bucket/album/photo.jpg');
      expect(copyInput()?.Key).toBe('album/photo.jpg');
    });

    // The backfill runs over every object in an album, including photos uploaded before
    // the filename sanitiser existed. An unencoded `%` is an invalid escape, so the copy
    // fails and that photo can never be scanned.
    it('should percent-encode a source key containing a percent sign or a space', async () => {
      await service.replaceCustomMetadata('test-bucket', 'album/100% done photo.jpg', {}, undefined);

      expect(copyInput()?.CopySource).toBe('/test-bucket/album/100%25%20done%20photo.jpg');
      // The destination key stays raw - only the source header is an encoded URI.
      expect(copyInput()?.Key).toBe('album/100% done photo.jpg');
    });

    it('should report failure when the copy does not return 200', async () => {
      r2Mock.on(CopyObjectCommand).resolves({ $metadata: { httpStatusCode: 500 } });

      await expect(
        service.replaceCustomMetadata('test-bucket', 'album/photo.jpg', {}, undefined),
      ).resolves.toBe(false);
    });
  });

  describe('readRange', () => {
    // Reading the whole object would discard the entire bandwidth premise of doing EXIF
    // extraction on the server, and nothing else would fail if it did.
    it('should request only the leading bytes asked for', async () => {
      const get = vi.fn().mockResolvedValue({
        arrayBuffer: async () => new ArrayBuffer(8),
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { caption: 'hello' },
      });
      const bucket = { get } as unknown as R2Bucket;

      const result = await service.readRange(bucket, 'album/photo.jpg', 131072);

      expect(get).toHaveBeenCalledWith('album/photo.jpg', {
        range: { offset: 0, length: 131072 },
      });
      expect(result).toMatchObject({
        contentType: 'image/jpeg',
        customMetadata: { caption: 'hello' },
      });
      expect(result?.bytes.byteLength).toBe(8);
    });

    it('should return null for an object that is not there', async () => {
      const bucket = { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket;

      await expect(service.readRange(bucket, 'album/gone.jpg', 100)).resolves.toBeNull();
    });

    // An object with no recorded metadata must not produce `undefined` where the caller
    // spreads it into the replacement set.
    it('should default missing custom metadata to an empty object', async () => {
      const bucket = {
        get: vi.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) }),
      } as unknown as R2Bucket;

      const result = await service.readRange(bucket, 'album/bare.jpg', 100);

      expect(result?.customMetadata).toEqual({});
      expect(result?.contentType).toBeUndefined();
    });
  });

  describe('countObjects', () => {
    it('should count everything under the prefix when below the limit', async () => {
      const bucket = bucketListing({ objects: objects(7), truncated: false });

      await expect(service.countObjects(bucket, 'album/', 1000)).resolves.toBe(7);
    });

    it('should follow the cursor across pages', async () => {
      const bucket = bucketListing(
        { objects: objects(3), truncated: true, cursor: 'c1' },
        { objects: objects(2), truncated: false },
      );

      await expect(service.countObjects(bucket, 'album/', 1000)).resolves.toBe(5);
      expect(bucket.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'c1' }));
    });

    // The early exit is the point of the `stopAt` argument: the caller only ever asks
    // "is this album at the cap?", so paging through the rest is wasted R2 operations.
    it('should stop listing as soon as the answer can no longer change', async () => {
      const bucket = bucketListing(
        { objects: objects(5), truncated: true, cursor: 'c1' },
        { objects: objects(5), truncated: true, cursor: 'c2' },
      );

      const count = await service.countObjects(bucket, 'album/', 5);

      expect(count).toBe(5);
      expect(bucket.list).toHaveBeenCalledTimes(1);
    });

    it('should skip the folder marker on the first page only', async () => {
      const bucket = bucketListing(
        { objects: objects(1), truncated: true, cursor: 'c1' },
        { objects: objects(1), truncated: false },
      );

      await service.countObjects(bucket, 'album/', 1000);

      expect(bucket.list).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ startAfter: 'album/' }),
      );
      expect(bucket.list.mock.calls[1]?.[0]).not.toHaveProperty('startAfter');
    });

    // No `include`, so pages are the full 1000 rather than the variable size a metadata
    // listing returns - counting does not need the metadata.
    it('should not request custom metadata it has no use for', async () => {
      const bucket = bucketListing({ objects: [], truncated: false });

      await service.countObjects(bucket, 'album/', 1000);

      expect(bucket.list.mock.calls[0]?.[0]).not.toHaveProperty('include');
    });

    it('should return zero for an empty album', async () => {
      const bucket = bucketListing({ objects: [], truncated: false });

      await expect(service.countObjects(bucket, 'album/', 1000)).resolves.toBe(0);
    });
  });
});

/**
 * The storage keys must stay lowercase, and the writer and reader must agree on them.
 *
 * R2 lowercases custom-metadata keys in transit — they travel as `x-amz-meta-<key>` HTTP
 * headers. Verified against a real bucket: a `CopyObject` sending
 * `Metadata: { latitude, takenAt, hasGps }` read back from `HeadObject` as
 * `{ hasgps, latitude, takenat }`.
 *
 * A camelCase spelling therefore round-trips to nothing, and it fails *quietly*: latitude
 * and longitude are already lowercase, so pins keep working while `hasGps` reads back
 * `undefined` — every photo looks unscanned forever, and each re-scan re-reads the whole
 * album. Nothing in a mocked round trip can catch that, so these assert the literal
 * spellings instead.
 */
describe('photo metadata storage keys', () => {
  it('should be lowercase, because R2 lowercases them in transit', () => {
    for (const key of Object.values(PHOTO_METADATA_KEYS)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('should be the exact spellings the bucket stores', () => {
    expect(PHOTO_METADATA_KEYS).toEqual({
      latitude: 'latitude',
      longitude: 'longitude',
      takenAt: 'takenat',
      hasGps: 'hasgps',
    });
  });

  // The API contract is unchanged: only the storage keys are lowercase.
  it('should not change the camelCase field names the API returns', () => {
    const service = new R2Service(testR2Config);
    const bucket = {
      list: vi.fn().mockResolvedValue({
        truncated: false,
        objects: [
          {
            key: 'album/p.jpg',
            size: 1,
            uploaded: new Date('2025-01-01'),
            customMetadata: {
              latitude: '-36.8',
              longitude: '174.7',
              takenat: '2025-01-01T10:00:00',
              hasgps: 'true',
            },
          },
        ],
      }),
    } as unknown as R2Bucket;

    return service.findAll(bucket, 'album/').then(([photo]) => {
      expect(photo).toMatchObject({
        latitude: -36.8,
        longitude: 174.7,
        takenAt: '2025-01-01T10:00:00',
        hasGps: true,
      });
    });
  });

  // The pre-fix bug, stated as a test: camelCase keys on the object are not the keys the
  // reader looks for, so they are simply absent.
  it('should ignore camelCase keys, which is what the bug looked like', () => {
    const service = new R2Service(testR2Config);
    const bucket = {
      list: vi.fn().mockResolvedValue({
        truncated: false,
        objects: [
          {
            key: 'album/p.jpg',
            size: 1,
            uploaded: new Date('2025-01-01'),
            customMetadata: { takenAt: '2025-01-01T10:00:00', hasGps: 'true' },
          },
        ],
      }),
    } as unknown as R2Bucket;

    return service.findAll(bucket, 'album/').then(([photo]) => {
      expect(photo).not.toHaveProperty('takenAt');
      expect(photo).not.toHaveProperty('hasGps');
    });
  });
});
