/** Fixture 采集器类型定义 */

export interface TraeDataRoots {
  os: "darwin" | "win32" | "linux";
  userDataPath: string;
  globalStoragePath: string;
  workspaceStoragePath: string;
}

export interface SqliteTableSchema {
  name: string;
  columns: { cid: number; name: string; type: string; notnull: number; pk: number }[];
  rowCount: number;
}

export interface SqliteSnapshot {
  relativePath: string;
  sha256: string;
  tables: SqliteTableSchema[];
}

export interface JsonKeyStructure {
  path: string;
  keys: string[];
  nestedKeys: Record<string, string[]>;
  arrayItemSampleKeys: string[];
  maxDepth: number;
}

export interface JsonFileSnapshot {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  structure: JsonKeyStructure;
}

export interface DirectorySnapshot {
  relativePath: string;
  entries: {
    relativePathHash: string;
    extension: string;
    depth: number;
    sizeBytes: number;
    sha256: string;
  }[];
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  jsonFiles: JsonFileSnapshot[];
  sqliteFiles: SqliteSnapshot[];
  directories: DirectorySnapshot[];
  /** 用于判断存储 profile 版本的特征 */
  profileFeatures: ProfileFeatures;
}

export interface ProfileFeatures {
  hasMementoStorage: boolean;
  hasLongText: boolean;
  hasPasteFiles: boolean;
  /** state.vscdb 中的关键表名列表 */
  keyTables: string[];
  /** workspace.json 中的关键顶层 key */
  workspaceJsonKeys: string[];
}

export interface FixtureReport {
  collectorVersion: string;
  collectedAt: string;
  os: string;
  traeRoots: TraeDataRoots;
  globalStorage: {
    stateVscdb: SqliteSnapshot | null;
  };
  workspaces: WorkspaceSnapshot[];
  summary: {
    totalWorkspaces: number;
    totalSqliteFiles: number;
    totalJsonFiles: number;
    totalFileEntriesInDirs: number;
    profileCounts: Record<string, number>;
  };
}

export interface CollectorOptions {
  traeRoot?: string;
  /** 限制最多处理的 workspace 数 */
  maxWorkspaces?: number;
  /** 输出路径 */
  output?: string;
}
