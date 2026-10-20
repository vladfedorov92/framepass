import { NS, isMessage, type AccessState, type Message } from '../core/index.js';

export type { AccessState } from '../core/index.js';
export { hasAccess } from '../core/index.js';

export interface MountOptions {
  /** URL of the embed page (served from the third-party origin). */
  src: string;
  /**
   * Extra sandbox tokens. When set, the tokens framepass needs are appended;
   * when omitted, the iframe is not sandboxed at all.
   */
  sandbox?: string[];
  title?: string;
  attributes?: Record<string, string>;
  /** How long `call()` waits for an answer, ms (default 15000). */
  timeout?: number;
}

export interface MountedEmbed {
  readonly iframe: HTMLIFrameElement;
  readonly state: AccessState;
  /** Resolves with the first state once the embed answered the handshake. */
  readonly ready: Promise<AccessState>;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  on(event: 'state', fn: (state: AccessState) => void): () => void;
  destroy(): void;
}

export const REQUIRED_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-storage-access-by-user-activation',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
];

const HELLO_INTERVAL = 300;
const HELLO_ATTEMPTS = 50;

export function mountEmbed(target: string | Element, options: MountOptions): MountedEmbed {
  const container = typeof target === 'string' ? document.querySelector(target) : target;
  if (!container) throw new Error(`framepass: container ${String(target)} not found`);

  const origin = new URL(options.src, location.href).origin;
  const timeout = options.timeout ?? 15000;
  const listeners = new Set<(state: AccessState) => void>();
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  const queue: Message[] = [];

  let state: AccessState = 'unknown';
  let isReady = false;
  let nextId = 1;
  let helloTimer: number | undefined;
  let resolveReady!: (state: AccessState) => void;
  const ready = new Promise<AccessState>((resolve) => (resolveReady = resolve));

  const iframe = document.createElement('iframe');
  iframe.src = options.src;
  iframe.title = options.title ?? 'Embedded content';
  iframe.allow = 'storage-access';
  if (options.sandbox) {
    iframe.setAttribute('sandbox', [...new Set([...options.sandbox, ...REQUIRED_SANDBOX])].join(' '));
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) iframe.setAttribute(name, value);

  function send(msg: Message) {
    iframe.contentWindow?.postMessage(msg, origin);
  }

  function setState(next: AccessState) {
    if (next === state) return;
    state = next;
    listeners.forEach((fn) => fn(state));
  }

  // The embed script may boot after the iframe's load event, so keep knocking until it answers.
  function startHello() {
    stopHello();
    let attempts = 0;
    send({ ns: NS, kind: 'hello' });
    helloTimer = window.setInterval(() => {
      if (isReady || ++attempts >= HELLO_ATTEMPTS) return stopHello();
      send({ ns: NS, kind: 'hello' });
    }, HELLO_INTERVAL);
  }

  function stopHello() {
    if (helloTimer !== undefined) window.clearInterval(helloTimer);
    helloTimer = undefined;
  }

  function onMessage(event: MessageEvent) {
    if (event.origin !== origin || event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!isMessage(msg)) return;

    if (msg.kind === 'ready') {
      stopHello();
      setState(msg.state);
      if (!isReady) {
        isReady = true;
        resolveReady(msg.state);
        queue.splice(0).forEach(send);
      }
    } else if (msg.kind === 'state') {
      setState(msg.state);
    } else if (msg.kind === 'result') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      window.clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new Error(msg.error));
    }
  }

  function onLoad() {
    // A reload of the frame (e.g. after login) needs a fresh handshake.
    isReady = false;
    startHello();
  }

  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', onLoad);
  container.appendChild(iframe);

  return {
    iframe,
    get state() {
      return state;
    },
    ready,
    call<T>(method: string, params?: unknown) {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`framepass: "${method}" timed out`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        const msg: Message = { ns: NS, kind: 'call', id, method, params };
        if (isReady) send(msg);
        else queue.push(msg);
      });
    },
    on(_event, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      stopHello();
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      pending.forEach(({ reject, timer }) => {
        window.clearTimeout(timer);
        reject(new Error('framepass: embed destroyed'));
      });
      pending.clear();
      listeners.clear();
      iframe.remove();
    },
  };
}
