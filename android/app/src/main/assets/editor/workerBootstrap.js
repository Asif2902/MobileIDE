/*
 * Legacy worker bootstrap kept for compatibility. The editor now uses
 * stub workers (see index.html) because Android file:// WebView cannot
 * reliably importScripts real Monaco language workers.
 */
self.MonacoEnvironment = { baseUrl: 'file:///android_asset/editor/' };
self.onmessage = function () {};
