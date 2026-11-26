// Which wallet choices make sense on this device.
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isAndroid = /android/i.test(ua);
export const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
export const isPhone = isAndroid || isIOS;
/** iPhone, but not Safari (Chrome, Firefox, Edge… on iOS): the Phantom app answers a deeplink in Safari, not here. */
export const isIOSOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|Brave/i.test(ua);

/** Links that open this page inside a wallet app's own browser (where the wallet is built in). */
export function browseLinks(url = typeof location !== 'undefined' ? location.href : '') {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(typeof location !== 'undefined' ? location.origin : '');
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
  ];
}
