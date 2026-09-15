import {
  CopyObjectCommand,
  CopyObjectCommandInput,
  DeleteObjectsCommand,
  DeleteObjectsCommandInput,
  GetObjectCommand,
  GetObjectCommandInput,
  HeadBucketCommand,
  HeadBucketCommandInput,
  HeadObjectCommand,
  HeadObjectCommandInput,
  ListObjectsV2Command,
  ListObjectsV2CommandInput,
  ListObjectsV2CommandOutput,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PHOTO_METADATA_KEYS } from '../constants';
import { BaseService, Photo } from '../types';
import { toCoordinates } from '../utils/coordinates';

export interface R2Config {
  accountId: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  cdnUrl?: string;
}

/**
 * Read one stored metadata value as a number.
 *
 * `Number('')` is `0`, not `NaN`, so the empty check cannot be folded into the conversion
 * — without it, a blank metadata value would become a coordinate of zero. Range and
 * finiteness are `toCoordinates`' job.
 *
 * @param raw Metadata value as stored, or `undefined` when the key is absent.
 * @returns The number, or `undefined` when there was nothing to read.
 */
const toNumber = (raw: string | undefined): number | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : Number(raw);

export default class R2Service implements BaseService<Photo> {
  public readonly r2Client: S3Client;
  public readonly cdnURL: string;

  constructor(config: R2Config) {
    this.r2Client = new S3Client({
      region: config.region || 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.cdnURL = config.cdnUrl || '';
  }

  /**
   * Every photo under `prefix`, read through the **native R2 binding**.
   *
   * ## Why this class reaches R2 two different ways
   *
   * This method uses the Workers binding; every other method here uses the S3 API via
   * `@aws-sdk/client-s3`. The duality is deliberate, not a half-finished migration:
   *
   * - **Only the binding returns custom metadata with a listing.** `include:
   *   ['customMetadata']` attaches each object's metadata to the list response, so a
   *   photo's coordinates arrive in the same call that already builds the photo list.
   *   S3's `ListObjectsV2` does not return user metadata at all, so the alternative is
   *   one `HeadObject` per photo for every visitor on every page load. Not viable.
   * - **Only the S3 client can mint presigned upload URLs.** The binding has no
   *   equivalent and the uploader depends on them, so the S3 client cannot be dropped.
   *
   * ## Pagination is mandatory here, not defensive
   *
   * `limit` maxes at 1000, but the Workers API reference warns that when metadata is
   * requested you "may receive fewer than `limit` results in your response to
   * accommodate metadata" — so the page size is variable and the reduction undocumented.
   * This repo's largest album holds ~300 photos and the loop will almost certainly run
   * once, but the failure mode of omitting it is an album silently losing photos with
   * nothing to see. The S3 listing this replaced passed `MaxKeys: 1000` and never
   * paginated at all.
   *
   * @param bucket The `BUCKET` binding from the Worker environment.
   * @param prefix Album folder prefix, including its trailing slash.
   * @returns Every photo under the prefix, in R2's lexicographic key order.
   */
  async findAll(bucket: R2Bucket, prefix: string): Promise<Photo[]> {
    const photos: Photo[] = [];
    let cursor: string | undefined;

    do {
      const listed: R2Objects = await bucket.list({
        prefix,
        include: ['customMetadata'],
        limit: 1000,
        // `startAfter` only applies to the first page, where it skips the zero-byte
        // folder marker R2 lists at the prefix itself. Once paginating, the cursor
        // carries the position and passing both would be contradictory.
        ...(cursor ? { cursor } : { startAfter: prefix }),
      });

      for (const object of listed.objects) {
        photos.push(this.toPhoto(object));
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return photos;
  }

  /**
   * Map one `R2Object` onto the `Photo` shape the API returns.
   *
   * A photo with no custom metadata — every photo predating the EXIF scan — maps to
   * exactly the shape this endpoint returned before coordinates existed, with the new
   * fields absent rather than null.
   *
   * @param object The listed R2 object.
   * @returns The photo, carrying coordinates only when both are present and valid.
   */
  private toPhoto(object: R2Object): Photo {
    const metadata = object.customMetadata ?? {};
    // Storage keys are lowercase because R2 lowercases them in transit; the `Photo` field
    // names below stay camelCase. See `PHOTO_METADATA_KEYS`.
    const takenAt = metadata[PHOTO_METADATA_KEYS.takenAt];
    const hasGps = metadata[PHOTO_METADATA_KEYS.hasGps];

    return {
      url: `${this.cdnURL}/${encodeURI(object.key)}`,
      key: object.key,
      size: object.size,
      lastModified: object.uploaded.toISOString(),
      ...toCoordinates(
        toNumber(metadata[PHOTO_METADATA_KEYS.latitude]),
        toNumber(metadata[PHOTO_METADATA_KEYS.longitude]),
      ),
      ...(takenAt ? { takenAt } : {}),
      // Only the two values the scan writes count as "scanned". Any other string is
      // treated as absent, so a stray value cannot make an unscanned photo look done.
      ...(hasGps === 'true' || hasGps === 'false' ? { hasGps: hasGps === 'true' } : {}),
    };
  }

  /**
   * How many objects sit under `prefix`, stopping as soon as `stopAt` is reached.
   *
   * The early exit is the point: the only question asked of this is "is the album at or
   * over the cap?", so there is no reason to page through the rest once the answer is
   * settled. No `include`, so pages are the full 1000 rather than the variable size a
   * metadata listing returns.
   *
   * @param bucket The `BUCKET` binding from the Worker environment.
   * @param prefix Album folder prefix, including its trailing slash.
   * @param stopAt Count at which the answer can no longer change.
   * @returns The number counted, which may be short of the true total once `stopAt` is hit.
   */
  async countObjects(bucket: R2Bucket, prefix: string, stopAt: number): Promise<number> {
    let count = 0;
    let cursor: string | undefined;

    do {
      const listed: R2Objects = await bucket.list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : { startAfter: prefix }),
      });

      count += listed.objects.length;
      if (count >= stopAt) {
        return count;
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return count;
  }

  /**
   * The first `length` bytes of an object, with its content type and custom metadata.
   *
   * Ranged through the binding rather than fetched over the CDN for two reasons: the CDN
   * strips EXIF by default, and a full download of every photo is precisely what keeping
   * this on the server avoids.
   *
   * @param bucket The `BUCKET` binding from the Worker environment.
   * @param key Full object key, including the album prefix.
   * @param length How many leading bytes to read.
   * @returns The bytes and the object's existing metadata, or `null` when it is absent.
   */
  async readRange(
    bucket: R2Bucket,
    key: string,
    length: number,
  ): Promise<{
    bytes: ArrayBuffer;
    contentType: string | undefined;
    customMetadata: Record<string, string>;
  } | null> {
    const object = await bucket.get(key, { range: { offset: 0, length } });
    if (!object) {
      return null;
    }

    return {
      bytes: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType,
      customMetadata: object.customMetadata ?? {},
    };
  }

  /**
   * Replace an object's custom metadata, in place.
   *
   * R2 cannot update metadata without rewriting the object, so this is a server-side
   * `CopyObject` onto the same key. `MetadataDirective: 'REPLACE'` is what makes the new
   * metadata take effect — and what makes the two cautions below necessary.
   *
   * **`metadata` must be the complete set.** REPLACE discards every existing key rather
   * than merging, so a caller passing only the changed fields would silently drop the
   * rest. Callers read the current metadata first and pass the merged result.
   *
   * **`contentType` must be carried over.** REPLACE drops the content type along with the
   * metadata, and an object that comes back as `application/octet-stream` downloads
   * instead of rendering. It is only omitted here when the source had none to begin with.
   *
   * @param bucketName Name of the R2 bucket.
   * @param key Full object key, including the album prefix.
   * @param metadata The complete custom metadata to store.
   * @param contentType The object's existing content type, when it has one.
   * @returns `true` when the copy succeeded.
   */
  async replaceCustomMetadata(
    bucketName: string,
    key: string,
    metadata: Record<string, string>,
    contentType: string | undefined,
  ): Promise<boolean> {
    const response = await this.r2Client.send(
      new CopyObjectCommand({
        Bucket: bucketName,
        // `encodeURI`, unlike the `copy` calls in `photo-controller`'s move and rename.
        // S3 requires the source key percent-encoded, and this is the one path that runs
        // over *every* object in an album, including photos uploaded before the filename
        // sanitiser existed. A key containing `%` is an invalid escape unencoded, so the
        // copy fails and that photo can never be scanned. `encodeURI` leaves `/` alone,
        // which the bucket-and-key form needs.
        CopySource: `/${bucketName}/${encodeURI(key)}`,
        Key: key,
        MetadataDirective: 'REPLACE',
        Metadata: metadata,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
    return response.$metadata.httpStatusCode === 200;
  }

  async read(params: GetObjectCommandInput): Promise<any> {
    const response = await this.r2Client.send(new GetObjectCommand(params));
    if (!response.Body) {
      throw new Error('No data found in the R2 object');
    }

    // Convert the response body (ReadableStream) to a string
    const bodyContents = await response.Body.transformToString();

    // Parse the string as JSON
    return JSON.parse(bodyContents);
  }

  async create(params: PutObjectCommandInput): Promise<boolean> {
    const response = await this.r2Client.send(new PutObjectCommand(params));
    return response.$metadata.httpStatusCode === 200;
  }

  async delete(params: DeleteObjectsCommandInput): Promise<boolean> {
    const response = await this.r2Client.send(new DeleteObjectsCommand(params));
    if (response.$metadata.httpStatusCode === 200) {
      const deletedKeys = response.Deleted?.map((deleted) => deleted.Key).join(',');
      console.log(`##### Delete objects: ${deletedKeys}`);
    }
    return response.$metadata.httpStatusCode === 200;
  }

  async copy(params: CopyObjectCommandInput): Promise<boolean> {
    const response = await this.r2Client.send(new CopyObjectCommand(params));
    return response.$metadata.httpStatusCode === 200;
  }

  async listObjects(params: ListObjectsV2CommandInput): Promise<ListObjectsV2CommandOutput> {
    return await this.r2Client.send(new ListObjectsV2Command(params));
  }

  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    contentType: string,
    expiresIn = 60,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.r2Client, command, { expiresIn });
  }

  async checkIfFileExists(params: HeadObjectCommandInput): Promise<boolean> {
    try {
      const response = await this.r2Client.send(new HeadObjectCommand(params));
      return response.$metadata.httpStatusCode === 200;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async checkIfBucketExists(params: HeadBucketCommandInput): Promise<boolean> {
    try {
      const response = await this.r2Client.send(new HeadBucketCommand(params));
      return response.$metadata.httpStatusCode === 200;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }
}
