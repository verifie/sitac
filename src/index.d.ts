/**
 * SITAC — Stable-Identity Temporal Audit Chain
 * Type definitions for sitac-core (MySQL and PostgreSQL)
 */

export interface SitacChildConfig {
  /** Child table name (trusted identifier) */
  table: string;
  /** Foreign-key column on the child that points to the parent */
  fk: string;
  /** When true, only copy rows where deleted_at IS NULL */
  liveOnly?: boolean;
}

export interface SitacSnapshotOptions {
  /** Entity table name (must be a trusted identifier) */
  table: string;
  /** Canonical row id */
  id: number | string;
  /** Acting user's id */
  editorId: number | string;
  /** Child tables to archive together with the parent */
  children?: SitacChildConfig[];
  /**
   * Columns that must be written as NULL in the snapshot
   * (e.g. password, secrets, large blobs that must not appear in history)
   */
  nullColumns?: string[];
  /** When true, increment version_name (vN → vN+1) on the canonical */
  versionName?: boolean;
  /** Bypass the internal column-name cache for this call */
  forceRefreshColumns?: boolean;
}

export interface SitacRestoreOptions {
  table: string;
  id: number | string;
  editorId: number | string;
  children?: SitacChildConfig[];
  nullColumns?: string[];
  /**
   * Additional trusted SQL SET fragments applied on revival
   * e.g. ['do_not_show = FALSE']
   */
  extraSet?: string[];
  forceRefreshColumns?: boolean;
}

export type SitacResult =
  | { snapshotId: number }
  | { skipped: string };

/**
 * Minimal connection contract.
 * - MySQL (mysql2): pool.getConnection() → connection
 * - PostgreSQL (pg): pool.connect() → client
 */
export interface SitacConnection {
  query(sql: string, params?: any[]): Promise<any>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Archive the live canonical row as an immutable snapshot, then stamp
 * the canonical with the new version metadata.
 */
export function sitacSnapshotAndStamp(
  conn: SitacConnection,
  opts: SitacSnapshotOptions
): Promise<SitacResult>;

/**
 * Restore a soft-deleted canonical row while preserving the original
 * deletion evidence inside a new snapshot.
 */
export function sitacRestore(
  conn: SitacConnection,
  opts: SitacRestoreOptions
): Promise<SitacResult>;

/**
 * Returns true when the payload contains at least one material field.
 */
export function hasMaterialChange(
  body: Record<string, any> | null | undefined,
  allowed: string[],
  nonMaterial: Set<string> | string[]
): boolean;

/**
 * Clear the internal SHOW COLUMNS / information_schema cache.
 * Call after any DDL that changes columns on versioned tables.
 */
export function clearColumnCache(): void;

/**
 * Low-level helper — mainly for advanced use and testing.
 */
export function tableColumns(
  conn: SitacConnection,
  table: string,
  forceRefresh?: boolean
): Promise<string[]>;
