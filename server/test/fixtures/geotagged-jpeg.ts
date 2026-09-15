/**
 * Builds real, decodable JPEG files carrying EXIF GPS, in memory.
 *
 * The EXIF scan is the one part of this feature that cannot be tested against a hand-made
 * object: it has to parse an actual APP1 segment. Rather than commit an opaque binary
 * fixture, this assembles the bytes so a reader can see exactly which tags are present
 * and change them — the southern/western hemisphere cases in particular, which are where
 * the sign handling goes wrong and which no photo taken locally would exercise.
 *
 * Layout produced: `SOI · APP1(Exif) · <body of a minimal 1×1 baseline JPEG>`. Exif files
 * put APP1 immediately after SOI, which is what this does.
 */

/**
 * A minimal valid 1×1 baseline JPEG, used for everything after the APP1 segment so the
 * result is a file a decoder would actually accept rather than a bare EXIF blob.
 */
const MINIMAL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** EXIF tag ids, named so the IFD assembly below reads as something other than magic numbers. */
const TAG = {
  EXIF_IFD_POINTER: 0x8769,
  GPS_IFD_POINTER: 0x8825,
  GPS_LATITUDE_REF: 0x0001,
  GPS_LATITUDE: 0x0002,
  GPS_LONGITUDE_REF: 0x0003,
  GPS_LONGITUDE: 0x0004,
  DATE_TIME_ORIGINAL: 0x9003,
} as const;

/** EXIF field types used here. */
const TYPE = { ASCII: 2, LONG: 4, RATIONAL: 5 } as const;

/** Degrees, minutes and seconds, as EXIF stores a coordinate. */
export type Dms = readonly [number, number, number];

export interface GeotaggedJpegOptions {
  latitude: Dms;
  latitudeRef: 'N' | 'S';
  longitude: Dms;
  longitudeRef: 'E' | 'W';
  /** EXIF format: `YYYY:MM:DD HH:MM:SS`. Omit to leave the tag out entirely. */
  dateTimeOriginal?: string;
}

/** Decode the base64 body without depending on a runtime-specific helper. */
const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64'));

/**
 * Write one 12-byte IFD entry.
 *
 * Values of four bytes or fewer live in the entry itself; anything larger is written
 * elsewhere in the TIFF block and referenced by offset. That is the rule the caller has
 * to respect when laying out `dataOffset`s.
 */
const writeEntry = (
  view: DataView,
  at: number,
  tag: number,
  type: number,
  count: number,
  inlineOrOffset: number | Uint8Array,
): void => {
  view.setUint16(at, tag, true);
  view.setUint16(at + 2, type, true);
  view.setUint32(at + 4, count, true);

  if (typeof inlineOrOffset === 'number') {
    view.setUint32(at + 8, inlineOrOffset, true);
    return;
  }
  for (let i = 0; i < 4; i++) {
    view.setUint8(at + 8 + i, inlineOrOffset[i] ?? 0);
  }
};

/** Write three RATIONALs (numerator/denominator pairs) for one DMS coordinate. */
const writeDms = (view: DataView, at: number, [degrees, minutes, seconds]: Dms): void => {
  // Seconds carry two decimal places, which is ~0.3 m — finer than any consumer camera.
  const parts: Array<[number, number]> = [
    [degrees, 1],
    [minutes, 1],
    [Math.round(seconds * 100), 100],
  ];
  parts.forEach(([numerator, denominator], index) => {
    view.setUint32(at + index * 8, numerator, true);
    view.setUint32(at + index * 8 + 4, denominator, true);
  });
};

/**
 * A NUL-terminated ASCII value, as EXIF stores strings.
 *
 * `TextEncoder` rather than a `charCodeAt` loop: it encodes by code point instead of by
 * UTF-16 code unit, so a character outside the BMP produces its real bytes rather than a
 * truncated surrogate half. Every caller here passes ASCII, where the two agree — but the
 * byte count is what the IFD entry declares, so the two must not be able to disagree.
 */
const asciiBytes = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded, 0);
  return bytes;
};

/**
 * Assemble the TIFF block that sits inside the APP1 segment.
 *
 * Offsets are all relative to the start of this block, which is what the TIFF header
 * declares and what a parser resolves against.
 */
const buildTiffBlock = (options: GeotaggedJpegOptions): Uint8Array => {
  const dateTime = options.dateTimeOriginal;
  const dateBytes = dateTime ? asciiBytes(dateTime) : undefined;

  // Laid out front to back: header, IFD0, GPS IFD, the two coordinate arrays, then the
  // Exif IFD and its one string. Each offset is the end of everything before it.
  const ifd0At = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const gpsIfdAt = ifd0At + ifd0Size;
  const gpsIfdSize = 2 + 4 * 12 + 4;
  const latitudeAt = gpsIfdAt + gpsIfdSize;
  const longitudeAt = latitudeAt + 24;
  const exifIfdAt = longitudeAt + 24;
  const exifIfdSize = 2 + (dateBytes ? 12 : 0) + 4;
  const dateAt = exifIfdAt + exifIfdSize;
  const total = dateAt + (dateBytes?.length ?? 0);

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // TIFF header: little-endian ("II"), magic 42, offset of IFD0.
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0At, true);

  // IFD0 holds only the two pointers; the interesting tags live in the sub-IFDs.
  view.setUint16(ifd0At, 2, true);
  writeEntry(view, ifd0At + 2, TAG.GPS_IFD_POINTER, TYPE.LONG, 1, gpsIfdAt);
  writeEntry(view, ifd0At + 14, TAG.EXIF_IFD_POINTER, TYPE.LONG, 1, exifIfdAt);
  view.setUint32(ifd0At + 26, 0, true);

  view.setUint16(gpsIfdAt, 4, true);
  writeEntry(
    view,
    gpsIfdAt + 2,
    TAG.GPS_LATITUDE_REF,
    TYPE.ASCII,
    2,
    asciiBytes(options.latitudeRef),
  );
  writeEntry(view, gpsIfdAt + 14, TAG.GPS_LATITUDE, TYPE.RATIONAL, 3, latitudeAt);
  writeEntry(
    view,
    gpsIfdAt + 26,
    TAG.GPS_LONGITUDE_REF,
    TYPE.ASCII,
    2,
    asciiBytes(options.longitudeRef),
  );
  writeEntry(view, gpsIfdAt + 38, TAG.GPS_LONGITUDE, TYPE.RATIONAL, 3, longitudeAt);
  view.setUint32(gpsIfdAt + 50, 0, true);

  writeDms(view, latitudeAt, options.latitude);
  writeDms(view, longitudeAt, options.longitude);

  view.setUint16(exifIfdAt, dateBytes ? 1 : 0, true);
  if (dateBytes) {
    writeEntry(
      view,
      exifIfdAt + 2,
      TAG.DATE_TIME_ORIGINAL,
      TYPE.ASCII,
      dateBytes.length,
      dateAt,
    );
    bytes.set(dateBytes, dateAt);
  }
  view.setUint32(exifIfdAt + exifIfdSize - 4, 0, true);

  return bytes;
};

/** Wrap a TIFF block in an APP1 segment and splice it in after the SOI marker. */
const withApp1 = (tiff: Uint8Array): Uint8Array => {
  const identifier = asciiBytes('Exif'); // 'Exif\0'
  // The EXIF identifier is 'Exif' plus *two* NULs, and `asciiBytes` supplies only one.
  const header = new Uint8Array(identifier.length + 1);
  header.set(identifier, 0);

  // The length field counts itself but not the FFE1 marker.
  const segmentLength = 2 + header.length + tiff.length;
  const body = decodeBase64(MINIMAL_JPEG_BASE64);

  const out = new Uint8Array(2 + 2 + segmentLength + (body.length - 2));
  let at = 0;
  out[at++] = 0xff; // SOI
  out[at++] = 0xd8;
  out[at++] = 0xff; // APP1
  out[at++] = 0xe1;
  out[at++] = (segmentLength >> 8) & 0xff;
  out[at++] = segmentLength & 0xff;
  out.set(header, at);
  at += header.length;
  out.set(tiff, at);
  at += tiff.length;
  // Everything after the original SOI: APP0, quantisation and Huffman tables, scan, EOI.
  out.set(body.subarray(2), at);

  return out;
};

/** A decodable 1×1 JPEG carrying the GPS tags described by `options`. */
export const buildGeotaggedJpeg = (options: GeotaggedJpegOptions): Uint8Array =>
  withApp1(buildTiffBlock(options));

/** The same minimal JPEG with no EXIF at all — the "photo has no GPS" case. */
export const buildJpegWithoutGps = (): Uint8Array => decodeBase64(MINIMAL_JPEG_BASE64);

/** Auckland, New Zealand: southern and eastern, so both refs are exercised at once. */
export const AUCKLAND: GeotaggedJpegOptions = {
  latitude: [36, 50, 54.24],
  latitudeRef: 'S',
  longitude: [174, 45, 47.88],
  longitudeRef: 'E',
  dateTimeOriginal: '2025:01:01 10:00:00',
};
