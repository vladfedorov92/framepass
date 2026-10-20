import {
  DEFAULT_BASE_PATH,
  NS,
  hasAccess,
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
  /**
   * Turns an always-visible "Sign in" button into the whole flow: storage access on click,
   * then either `signed-in` for the host or a top-level redirect to `loginUrl`.
   * Returns an unbinding function.
   */
  attachLogin(el: HTMLElement, options: LoginOptions): () => void;
  /** Sends an event to the host page (`widget.on('event', fn)`). */
  emit(name: string, data?: unknown): void;
  expose(methods: Methods): void;
  on(event: 'change', fn: (state: AccessState) => void): () => void;
  destroy(): void;
}

export interface LoginOptions {
  /** Your sign-in page; opened in the top window when there is no session or no cookie access. */
  loginUrl: string;
  /** Resolves true when the session is visible, e.g. `() => fetch('/api/me', { credentials: 'include' }).then((r) => r.ok)`. */
  isSignedIn: () => Promise<boolean>;
  /** Also check silently whenever access is already there, without a click (default true). */
  silent?: boolean;
}

/** `data-framepass-login` on the button while the flow runs. */
export type LoginStatus = 'idle' | 'busy' | 'signed-in' | 'redirect';

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
  const ancestors = checkAncestors(win, options.allowedHosts);
  // A handshake proves only the parent; where the whole chain is visible it has the final word.
  const trusted = () => ancestors === 'allowed' || (ancestors === 'unknown' && hostOrigin !== undefined);
  let visited = false;
  let checking: Promise<AccessState> | undefined;
  // Events raised before the host's handshake (e.g. a silent sign-in) wait for it.
  const pendingEvents: Message[] = [];

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
    return requestAccess();
  }

  // The bare Storage Access request, without the first-party popup step.
  function requestAccess(): Promise<AccessState> {
    if (!trusted() || !supported) return Promise.resolve(state);

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
      pendingEvents.splice(0).forEach(post);
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
    attachLogin(el, login) {
      let status: LoginStatus = 'idle';
      // Once a redirect was due, the next click navigates synchronously: if the first attempt
      // came too late after the click (activation expired), the browser may have blocked it.
      let redirectDue = false;
      const setStatus = (s: LoginStatus) => {
        status = s;
        el.dataset.framepassLogin = s;
      };
      const signedIn = async () => hasAccess(state) && (await login.isSignedIn().catch(() => false));
      const reportSignedIn = () => {
        setStatus('signed-in');
        embed.emit('signed-in');
      };
      const redirect = () => {
        redirectDue = true;
        setStatus('redirect');
        win.open(login.loginUrl, '_top');
      };

      const onClick = (event: Event) => {
        event.preventDefault();
        if (status === 'busy') return;
        if (status === 'signed-in') return reportSignedIn();
        if (redirectDue) return redirect();
        setStatus('busy');
        // Synchronous up to requestStorageAccess(), like request().
        const access = hasAccess(state) ? Promise.resolve(state) : requestAccess();
        void access
          .then(signedIn)
          .then((ok) => (ok ? reportSignedIn() : redirect()))
          .catch(() => setStatus('idle'));
      };

      // Chrome with third-party cookies, or a grant remembered from an earlier visit:
      // sign in without a click. Never redirect without one.
      let silentRun = false;
      const trySilent = (s: AccessState) => {
        if (login.silent === false || silentRun || status !== 'idle' || !hasAccess(s)) return;
        silentRun = true;
        void signedIn().then((ok) => {
          if (ok && status === 'idle') reportSignedIn();
        });
      };

      setStatus('idle');
      el.addEventListener('click', onClick);
      trySilent(state);
      const off = embed.on('change', trySilent);
      return () => {
        el.removeEventListener('click', onClick);
        off();
      };
    },
    emit(name, data) {
      const msg: Message = { ns: NS, kind: 'event', name, data };
      if (hostOrigin) post(msg);
      else pendingEvents.push(msg);
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

/**
 * Storage access is granted for (our site, top-level site), so every ancestor must be allowed,
 * not just the parent: an allowed partner page framed by an attacker must not count.
 * Chromium and Safari list the chain in `ancestorOrigins`; Firefox doesn't, so it falls back
 * to the parent handshake plus `frame-ancestors`, which browsers check along the whole chain.
 */
function checkAncestors(win: Window, allowedHosts: string[]): 'allowed' | 'forbidden' | 'unknown' {
  if (win.parent === win) return 'forbidden';
  const list = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (!list || list.length === 0) return 'unknown';
  const origins = Array.from({ length: list.length }, (_, i) => list[i]);
  // Chromium masks ancestors as "null" under `referrerpolicy="no-referrer"`.
  if (origins.some((o) => o !== 'null' && !allowedHosts.includes(o))) return 'forbidden';
  return origins.includes('null') ? 'unknown' : 'allowed';
}

function defaultEnv(): EmbedEnv {
  return { window, document, navigator, fetch: fetch.bind(globalThis) };
}
