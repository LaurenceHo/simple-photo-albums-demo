import type { ApiResponse, PhotoMetadataResult, PhotoResponse, ResponseStatus } from '@/schema';
import { ApiBaseUrl } from '@/services/api-base-url';
import { BaseApiRequestService } from '@/services/base-api-request-service';

export const PhotoService = {
  getPhotosByAlbumId: async (
    albumId: string,
    year: string,
  ): Promise<ApiResponse<PhotoResponse>> => {
    const response = await BaseApiRequestService.perform(
      'GET',
      `${ApiBaseUrl}/photos/${year}/${albumId}`,
    );

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return response.json();
  },

  uploadPhotos: async (file: File, albumId: string, filename?: string): Promise<ResponseStatus> => {
    const queryParams = new URLSearchParams({
      filename: filename || file.name,
      mimeType: file.type,
    });

    // POST, not GET: this mints a presigned upload credential, so it must not present as
    // a safe method. The server's verifyOrigin CSRF check skips GET/HEAD/OPTIONS, so as a
    // GET this endpoint was exempt from it.
    const response = await BaseApiRequestService.perform(
      'POST',
      `${ApiBaseUrl}/photos/upload/${albumId}?${queryParams.toString()}`,
    );

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    const { data } = (await response.json()) as ApiResponse<{ uploadUrl: string }>;

    if (!data?.uploadUrl) {
      throw new Error('Upload URL not found');
    }

    const uploadResponse = await fetch(data.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type,
      },
    });

    if (uploadResponse.ok) {
      return {
        code: 200,
        status: 'Success',
        message: 'ok',
      };
    } else {
      console.error('Upload failed:', uploadResponse.statusText);
      throw new Error('Upload failed');
    }
  },

  /**
   * Move photos from one album to another
   * @param albumId Original album ID
   * @param destinationAlbumId Destination album ID
   * @param photoKeys Keys of photos to be moved
   */
  movePhotos: async (
    albumId: string,
    destinationAlbumId: string,
    photoKeys: string[],
  ): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform('PUT', `${ApiBaseUrl}/photos`, {
      albumId,
      destinationAlbumId,
      photoKeys,
    });

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return response.json();
  },

  deletePhotos: async (albumId: string, photoKeys: string[]): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform('DELETE', `${ApiBaseUrl}/photos`, {
      albumId,
      photoKeys,
    });

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return response.json();
  },

  /**
   * Ask the server to read EXIF GPS from photos already in R2 and store it.
   *
   * The browser parses no EXIF and downloads no photos for this: the Worker reads the
   * leading bytes of each object itself, which is why no R2 bucket CORS is needed and why
   * a backfill does not pull gigabytes through the client.
   *
   * The batch is capped at 50 server-side, so callers must chunk. Two of them exist: the
   * uploader, straight after an upload, and the admin backfill scan.
   *
   * @param albumId Album the photos belong to.
   * @param photoKeys Filenames within the album, without the album prefix.
   * @returns One result per key, in the order they were sent.
   */
  extractPhotoMetadata: async (
    albumId: string,
    photoKeys: string[],
  ): Promise<ApiResponse<{ results: PhotoMetadataResult[] }>> => {
    const response = await BaseApiRequestService.perform(
      'POST',
      `${ApiBaseUrl}/photos/metadata/${albumId}`,
      { photoKeys },
    );

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return response.json();
  },

  renamePhoto: async (
    albumId: string,
    newPhotoKey: string,
    currentPhotoKey: string,
  ): Promise<ResponseStatus> => {
    const response = await BaseApiRequestService.perform('PUT', `${ApiBaseUrl}/photos/rename`, {
      albumId,
      newPhotoKey, // Without album id
      currentPhotoKey, // Without album id
    });

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return response.json();
  },
};
