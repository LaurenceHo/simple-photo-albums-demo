import { Album } from '../types/album';
import { assertSafeColumn, D1Service } from './d1-service';

export default class AlbumService extends D1Service<Album> {
  constructor(db: D1Database) {
    super(db, 'albums');
  }

  override async getAll(where?: Record<string, any>): Promise<Album[]> {
    let sql = `
      SELECT a.*,
             (SELECT json_group_array(tag) FROM album_tags_map WHERE albumId = a.id) as tags
      FROM albums a
    `;
    const values: any[] = [];

    if (where) {
      const conditions: string[] = [];
      for (const [key, value] of Object.entries(where)) {
        if (value !== undefined) {
          // Same identifier hazard as D1Service: `key` lands in the SQL text, not a bind.
          conditions.push(`a.${assertSafeColumn(key)} = ?`);
          values.push(value);
        }
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const { results } = await this.db
      .prepare(sql)
      .bind(...values)
      .all();
    return results.map((item) => this.mapAlbum(item));
  }

  override async getById(id: string): Promise<Album | null> {
    const sql = `
      SELECT a.*,
             (SELECT json_group_array(tag) FROM album_tags_map WHERE albumId = a.id) as tags
      FROM albums a
      WHERE a.id = ?
    `;
    const result = await this.db.prepare(sql).bind(id).first();
    return result ? this.mapAlbum(result) : null;
  }

  override async create(item: Album): Promise<any> {
    const tags = item.tags || [];
    const album = { ...item };
    delete album.tags;

    // Insert album
    await super.create(album);

    // Insert tags
    if (tags.length > 0) {
      // Ensure tags exist in album_tags table
      const tagStmt = this.db.prepare(
        'INSERT OR IGNORE INTO album_tags (tag, createdAt, createdBy) VALUES (?, ?, ?)',
      );
      const tagBatch = tags.map((tag: string) =>
        tagStmt.bind(tag, new Date().toISOString(), item.createdBy || 'system'),
      );
      await this.db.batch(tagBatch);

      // Link tags in album_tags_map
      const stmt = this.db.prepare('INSERT INTO album_tags_map (albumId, tag) VALUES (?, ?)');
      const batch = tags.map((tag: string) => stmt.bind(album.id, tag));
      await this.db.batch(batch);
    }
  }

  /**
   * `Partial<Album>` rather than `Album`, so a caller changing one column can pass only
   * that column. `D1Service.update` skips undefined keys, and the `tags !== undefined`
   * guard below means an omitted `tags` leaves the album's tag rows untouched instead of
   * deleting and re-inserting them.
   *
   * This also matches the base `D1Service<T>.update` signature. Narrowing it to `Album`
   * was unsound: parameter bivariance let it compile, but any `D1Service<Album>`
   * reference could already pass a partial.
   */
  override async update(id: string, item: Partial<Album>): Promise<any> {
    const tags = item.tags;
    const album = { ...item };
    delete album.tags;

    // Update album
    await super.update(id, album);

    // Update tags if provided
    if (tags !== undefined) {
      // Delete existing tags map entries
      await this.db.prepare('DELETE FROM album_tags_map WHERE albumId = ?').bind(id).run();

      // Insert new tags
      if (tags.length > 0) {
        // Ensure tags exist in album_tags table
        const tagStmt = this.db.prepare(
          'INSERT OR IGNORE INTO album_tags (tag, createdAt, createdBy) VALUES (?, ?, ?)',
        );
        const tagBatch = tags.map((tag: string) =>
          tagStmt.bind(tag, new Date().toISOString(), item.updatedBy || 'system'),
        );
        await this.db.batch(tagBatch);

        // Link tags in album_tags_map
        const stmt = this.db.prepare('INSERT INTO album_tags_map (albumId, tag) VALUES (?, ?)');
        const batch = tags.map((tag: string) => stmt.bind(id, tag));
        await this.db.batch(batch);
      }
    }
  }

  private mapAlbum(item: any): Album {
    // Parse tags
    if (item.tags && typeof item.tags === 'string') {
      try {
        item.tags = JSON.parse(item.tags);
      } catch {
        item.tags = [];
      }
    } else if (!item.tags) {
      item.tags = [];
    }

    // Parse place
    if (item.place && typeof item.place === 'string') {
      try {
        item.place = JSON.parse(item.place);
      } catch (e) {
        console.warn(`##### Failed to parse place JSON for album ${item.id}:`, e);
        item.place = undefined;
      }
    }

    // Convert booleans
    // D1/SQLite stores booleans as 0 or 1
    if (item.isUnlisted !== undefined) {
      item.isUnlisted = !!item.isUnlisted;
    }
    if (item.isFeatured !== undefined) {
      item.isFeatured = !!item.isFeatured;
    }

    return item as Album;
  }
}
