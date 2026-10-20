import { NS, type Message } from '../core/index.js';

/**
 * For pages on your own site that the embed opens as its first-party popup
 * (`firstPartyUrl`), e.g. a login page.
 */

export interface NotifyOptions {
  /** Close the popup after notifying (default true). */
  close?: boolean;
}

/** True when this page was opened by the embed and can report the visit. */
export function isVisitPopup(win: Window = window): boolean {
  return !!win.opener && win.opener !== win;
}

/**
 * Tells the embed that the user has visited our site as a first party; it then
 * asks for one more click to request storage access. Returns false when there is no opener.
 * Call it after a real user interaction (a click, a submitted login form): Safari only
 * counts visits the user interacted with.
 */
export function notifyVisited(options: NotifyOptions = {}, win: Window = window): boolean {
  if (!isVisitPopup(win)) return false;
  const msg: Message = { ns: NS, kind: 'visited' };
  // Only a frame on our own origin may hear it.
  win.opener!.postMessage(msg, win.location.origin);
  if (options.close !== false) win.close();
  return true;
}
