/**
 * Access state of the embedded (third-party) frame to its unpartitioned cookies.
 *
 * - `unknown`            check() has not finished yet
 * - `not-needed`         cookies are already reachable (e.g. Chrome with 3P cookies allowed)
 * - `granted`            Storage Access API granted access in this document
 * - `needs-gesture`      a click inside the iframe is required (use `attach(button)`)
 * - `needs-first-party`  browser wants a prior top-level visit to our site (Safari, Firefox);
 *                        the next click opens a popup on our origin
 * - `waiting-host`       access needs asking, but the embedding page is not verified yet as one
 *                        of `allowedHosts`; nothing is requested until it is (clickjacking guard)
 * - `denied`             the user or the browser refused
 * - `unsupported`        no Storage Access API and no cookie access: use a fallback
 */
export type AccessState =
  | 'unknown'
  | 'not-needed'
  | 'granted'
  | 'needs-gesture'
  | 'needs-first-party'
  | 'waiting-host'
  | 'denied'
  | 'unsupported';

export function hasAccess(state: AccessState): boolean {
  return state === 'not-needed' || state === 'granted';
}

export const NS = 'framepass';
export const DEFAULT_BASE_PATH = '/__framepass';

export type Message =
  | { ns: typeof NS; kind: 'hello' }
  | { ns: typeof NS; kind: 'ready'; state: AccessState }
  | { ns: typeof NS; kind: 'state'; state: AccessState }
  | { ns: typeof NS; kind: 'call'; id: number; method: string; params?: unknown }
  | { ns: typeof NS; kind: 'result'; id: number; ok: true; value: unknown }
  | { ns: typeof NS; kind: 'result'; id: number; ok: false; error: string }
  | { ns: typeof NS; kind: 'visited' }
  | { ns: typeof NS; kind: 'event'; name: string; data?: unknown };

export function isMessage(data: unknown): data is Message {
  return typeof data === 'object' && data !== null && (data as { ns?: unknown }).ns === NS;
}

/** Unpartitioned storage types Chrome can hand out via `requestStorageAccess(types)`. */
export type StorageType =
  | 'localStorage'
  | 'sessionStorage'
  | 'indexedDB'
  | 'locks'
  | 'caches'
  | 'getDirectory'
  | 'estimate'
  | 'createObjectURL'
  | 'revokeObjectURL'
  | 'BroadcastChannel'
  | 'SharedWorker';

/** What `requestStorageAccess(types)` resolves to in Chromium. Only requested members are usable. */
export interface StorageAccessHandle {
  localStorage?: Storage;
  sessionStorage?: Storage;
  indexedDB?: IDBFactory;
  caches?: CacheStorage;
  locks?: LockManager;
  [key: string]: unknown;
}

export interface Capabilities {
  /** `document.hasStorageAccess` / `requestStorageAccess` exist. */
  storageAccessApi: boolean;
  /** `navigator.permissions.query({ name: 'storage-access' })` works. */
  permissionQuery: boolean;
}

export function detect(doc: Document = document): Capabilities {
  const d = doc as Partial<Document>;
  return {
    storageAccessApi: typeof d.hasStorageAccess === 'function' && typeof d.requestStorageAccess === 'function',
    permissionQuery: typeof navigator !== 'undefined' && typeof navigator.permissions?.query === 'function',
  };
}

/** Resolves to the `storage-access` permission state, or undefined where it can't be queried. */
export async function queryPermission(nav: Navigator | undefined = globalThis.navigator): Promise<PermissionState | undefined> {
  try {
    const status = await nav?.permissions?.query({ name: 'storage-access' as PermissionName });
    return status?.state;
  } catch {
    return undefined;
  }
}
