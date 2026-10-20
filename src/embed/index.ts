import {
  DEFAULT_BASE_PATH,
  NS,
  isMessage,
  queryPermission,
  type AccessState,
  type Message,
  type StorageAccessHandle,
  type StorageType,
} from '../core/index.js';

export type { AccessState, StorageAccessHandle, StorageType } from '../core/index.js';
export { hasAccess } from '../core/index.js';

export interface MethodContext {
  state: AccessState;
  storage: StorageAccessHandle | undefined;
  origin: string;
}

export type Methods = Record<string, (params: any, ctx: MethodContext) => unknown>;

/**
 * Throw it from a method to send its message to the host page as is.
 * Other errors reach the host as a generic message unless `exposeErrors` is on.
 */
export class PublicError extends Error {
  override name = 'PublicError';
}

export interface EmbedOptions {
  /**
   * Origins allowed to embed this frame and call its methods, e.g. `['https://shop.example']`.
   * Storage access is only requested once the embedding page is verified as one of them:
   * by `location.ancestorOrigins` where available, otherwise by the `framepass/host` handshake.
   */
  allowedHosts: string[];
  /** Send real error messages of failed methods to the host (default false). */
  exposeErrors?: boolean;
  /** Endpoint served by `framepass/server`; tells whether first-party cookies reach us. */
  probeUrl?: string | null;
  /** Page served by `framepass/server` that records a first-party visit; `null` disables the popup step. */
  firstPartyUrl?: string | null;
  /** Unpartitioned non-cookie storage to request (Chromium only, ignored elsewhere). */
  unpartitioned?: StorageType[];
  /** Methods callable from the host page via `embed.call()`. */
  methods?: Methods;
  /** Run `check()` right away (default true). */
  autoCheck?: boolean;
}

export interface Embed {
  readonly state: AccessState;
  readonly storage: StorageAccessHandle | undefined;
  /** Works out the current state without prompting. Repeated calls share one run. */
  check(): Promise<AccessState>;
  /** Asks for access. Call it synchronously from a click handler inside this frame. */
  request(): Promise<AccessState>;
  /** Wires a button to `request()` and toggles its `hidden` flag by state. Returns an unbinding function. */
  attach(el: HTMLElement): () => void;
  expose(methods: Methods): void;
  on(event: 'change', fn: (state: AccessState) => void): () => void;
  destroy(): void;
}

/** Globals the embed touches; injectable for tests. */
export interface EmbedEnv {
  window: Window;
  document: Document;
  navigator: Navigator;
  fetch: typeof fetch;
}

// `waiting-host` is deliberately absent: no button until the host is verified.
const ACTIONABLE: AccessState[] = ['needs-gesture', 'needs-first-party', 'denied'];

export function createEmbed(options: EmbedOptions, env: EmbedEnv = defaultEnv()): Embed {
  const { window: win, document: doc } = env;
  const probeUrl = options.probeUrl === undefined ? `${DEFAULT_BASE_PATH}/probe` : options.probeUrl;
  const firstPartyUrl = options.firstPartyUrl === undefined ? `${DEFAULT_BASE_PATH}/visit` : options.firstPartyUrl;
  const methods: Methods = { ...options.methods };
  const listeners = new Set<(state: AccessState) => void>();

  let state: AccessState = 'unknown';
  let storage: StorageAccessHandle | undefined;
  // Set only by a handshake from our parent on an allowed origin.
  let hostOrigin: string | undefined;
  const ancestorTrusted = isAllowedParent(win, options.allowedHosts);
  const trusted = () => ancestorTrusted || hostOrigin !== undefined;
  let visited = false;
  let checking: Promise<AccessState> | undefined;

  const api = doc as Document & {
    hasStorageAccess?: () => Promise<boolean>;
    requestStorageAccess?: (types?: Record<string, boolean>) => Promise<StorageAccessHandle | undefined>;
  };
  const supported = typeof api.hasStorageAccess === 'function' && typeof api.requestStorageAccess === 'function';

  function set(next: AccessState): AccessState {
    if (next !== state) {
      state = next;
      post({ ns: NS, kind: 'state', state });
      listeners.forEach((fn) => fn(state));
    }
    return state;
  }

  function post(msg: Message) {
    if (hostOrigin && win.parent !== win) win.parent.postMessage(msg, hostOrigin);
  }

  async function probe(): Promise<boolean> {
    if (!probeUrl) return false;
    try {
      const res = await env.fetch(probeUrl, { credentials: 'include', cache: 'no-store' });
      return res.ok && (await res.json()).access === true;
    } catch {
      return false;
    }
  }

  // Must stay synchronous up to the requestStorageAccess() call: the browser
  // only honours it while the click's transient activation is alive.
  function callRequest(): Promise<void> {
    const types = options.unpartitioned?.length
      ? Object.fromEntries([['cookies', true], ...options.unpartitioned.map((t) => [t, true])])
      : undefined;
    const pending = types ? api.requestStorageAccess!(types) : api.requestStorageAccess!();
    return Promise.resolve(pending).then((handle) => {
      if (handle && typeof handle === 'object') storage = handle;
    });
  }

  async function runCheck(): Promise<AccessState> {
    const wantsStorage = !!options.unpartitioned?.length;

    if (!supported) return set((await probe()) ? 'not-needed' : 'unsupported');

    // Unpartitioned storage needs a handle even when cookies already flow.
    if (!wantsStorage) {
      if (await api.hasStorageAccess!().catch(() => false)) return set(state === 'granted' ? 'granted' : 'not-needed');
      if (await probe()) return set('not-needed');
    }

    const permission = await queryPermission(env.navigator);
    if (permission === 'denied') return set('denied');
    // Never ask, even silently, on behalf of a page we have not verified.
    if (!trusted()) return set('waiting-host');
    if (permission === 'granted') {
      // Granted earlier for this pair of sites: Chromium re-activates without a gesture.
      try {
        await callRequest();
        return set('granted');
      } catch {
        // fall through to an explicit gesture
      }
    }
    return set('needs-gesture');
  }

  function openFirstParty() {
    if (!firstPartyUrl) return;
    win.open(firstPartyUrl, 'framepass', 'popup,width=480,height=640');
  }

  function request(): Promise<AccessState> {
    if (!trusted()) return Promise.resolve(state);
    if (state === 'needs-first-party') {
      openFirstParty();
      return Promise.resolve(state);
    }
    if (!supported) return Promise.resolve(state);

    let pending: Promise<void>;
    try {
      pending = callRequest();
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then(
      () => set('granted'),
      // Safari and Firefox reject outright if we were never visited as a first party.
      () => set(firstPartyUrl && !visited ? 'needs-first-party' : 'denied'),
    );
  }

  function onMessage(event: MessageEvent) {
    const msg = event.data;
    if (!isMessage(msg)) return;

    if (msg.kind === 'visited' && event.origin === win.location.origin) {
      visited = true;
      // The popup click spent the activation; one more click in the frame is needed.
      set(trusted() ? 'needs-gesture' : 'waiting-host');
      return;
    }

    if (event.source !== win.parent || win.parent === win || !options.allowedHosts.includes(event.origin)) return;

    if (msg.kind === 'hello') {
      const wasTrusted = trusted();
      hostOrigin = event.origin;
      post({ ns: NS, kind: 'ready', state });
      // A check may be in flight and still conclude `waiting-host`: re-check once it settles.
      if (!wasTrusted) {
        void (checking ?? Promise.resolve()).then(() => {
          if (state === 'waiting-host') void embed.check();
        });
      }
    } else if (msg.kind === 'call') {
      void handleCall(msg.id, msg.method, msg.params, event.origin);
    }
  }

  async function handleCall(id: number, method: string, params: unknown, origin: string) {
    const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
    try {
      if (!fn) throw new PublicError(`framepass: unknown method "${method}"`);
      const value = await fn(params, { state, storage, origin });
      post({ ns: NS, kind: 'result', id, ok: true, value });
    } catch (err) {
      const reveal = err instanceof PublicError || options.exposeErrors;
      const error = reveal ? (err instanceof Error ? err.message : String(err)) : `framepass: "${method}" failed`;
      post({ ns: NS, kind: 'result', id, ok: false, error });
    }
  }

  win.addEventListener('message', onMessage);

  const embed: Embed = {
    get state() {
      return state;
    },
    get storage() {
      return storage;
    },
    check() {
      checking ??= runCheck().finally(() => {
        checking = undefined;
      });
      return checking;
    },
    request,
    attach(el) {
      const onClick = () => void request();
      const sync = (s: AccessState) => {
        el.hidden = !ACTIONABLE.includes(s);
        el.dataset.framepassState = s;
      };
      el.addEventListener('click', onClick);
      sync(state);
      const off = embed.on('change', sync);
      return () => {
        el.removeEventListener('click', onClick);
        off();
      };
    },
    expose(more) {
      Object.assign(methods, more);
    },
    on(_event, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      win.removeEventListener('message', onMessage);
      listeners.clear();
    },
  };

  if (options.autoCheck !== false) void embed.check();
  return embed;
}

/** Chromium and Safari expose the parent's origin synchronously; Firefox relies on the handshake. */
function isAllowedParent(win: Window, allowedHosts: string[]): boolean {
  if (win.parent === win) return false;
  const parent = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
  return parent !== undefined && allowedHosts.includes(parent);
}

function defaultEnv(): EmbedEnv {
  return { window, document, navigator, fetch: fetch.bind(globalThis) };
}
