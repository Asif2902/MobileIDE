'use strict';

/**
 * Android loopback compatibility for Node HTTP servers.
 *
 * Binding `0.0.0.0` (IPv4 wildcard) is what HOST/HOSTNAME=0.0.0.0 ask for, but
 * Chrome on Android often connects to `localhost` as `::1`. That address is not
 * served by an IPv4-only socket, so the page fails while `http://127.0.0.1`
 * still works. Binding `::` with `ipv6Only: false` accepts IPv4-mapped and
 * IPv6 loopback on this platform (verified on Bionic).
 *
 * Unix-domain sockets and explicit non-loopback hosts are left alone.
 */

function isUnixPath(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || value.startsWith('\0') || value.includes('/'))
  );
}

function isLoopbackOrWildcard(host) {
  if (host == null || host === '') return true;
  const normalized = String(host).toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '[::]' ||
    normalized === '[::1]' ||
    normalized === '127.0.0.1' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback'
  );
}

function dualStackOptions(extra) {
  return {host: '::', ipv6Only: false, ...extra};
}

/**
 * Rewrite `net.Server#listen` arguments so loopback/wildcard binds are
 * dual-stack. Returns `{passthrough: true}` when the call must not be changed
 * (IPC paths), otherwise `{options, callback}`.
 */
function normalizeListenArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
  if (list.length === 0) {
    return {options: dualStackOptions({port: 0}), callback};
  }

  const first = list[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    if (first.path) return {passthrough: true, args};
    const options = {...first};
    if (isLoopbackOrWildcard(options.host)) {
      options.host = '::';
      options.ipv6Only = false;
    }
    return {options, callback};
  }

  if (isUnixPath(first)) return {passthrough: true, args};

  const port =
    typeof first === 'string' && /^\d+$/.test(first) ? Number(first) : first;
  if (typeof port === 'string') return {passthrough: true, args};

  const host = typeof list[1] === 'string' ? list[1] : undefined;
  const backlog =
    typeof list[1] === 'number' ? list[1] : typeof list[2] === 'number' ? list[2] : undefined;
  const extra = {port};
  if (backlog != null) extra.backlog = backlog;
  if (host && !isLoopbackOrWildcard(host)) {
    extra.host = host;
    return {options: extra, callback};
  }
  return {options: dualStackOptions(extra), callback};
}

function applyNormalizedListen(server, originalListen, args) {
  const normalized = normalizeListenArgs(args);
  if (normalized.passthrough) return originalListen.apply(server, args);
  if (normalized.callback) {
    return originalListen.call(server, normalized.options, normalized.callback);
  }
  return originalListen.call(server, normalized.options);
}

module.exports = {
  applyNormalizedListen,
  isLoopbackOrWildcard,
  normalizeListenArgs,
};
