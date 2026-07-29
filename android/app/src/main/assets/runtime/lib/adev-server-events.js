'use strict';

// Structured, framework-independent server lifecycle events for Android.
// Process/PTY managers consume these control records and independently verify
// loopback reachability before publishing a preview URL.
const net = require('node:net');

const PATCHED = Symbol.for('adev.server.events.patched');
const PREFIX = '\u001eADEV_SERVER_EVENT ';

function emit(event) {
  try {
    process.stderr.write(
      PREFIX + JSON.stringify({ ...event, pid: process.pid, timestamp: Date.now() }) + '\n',
    );
  } catch {
    // Diagnostics must never prevent a user server from starting.
  }
}

if (!net.Server.prototype[PATCHED]) {
  const originalListen = net.Server.prototype.listen;
  Object.defineProperty(net.Server.prototype, PATCHED, {
    value: true,
    enumerable: false,
  });

  net.Server.prototype.listen = function adevListen(...args) {
    let reportedAddress = null;

    this.once('listening', () => {
      const address = this.address();
      if (!address || typeof address === 'string') return;
      reportedAddress = address;
      emit({
        event: 'listening',
        address: address.address,
        family: address.family,
        port: address.port,
        protocol: 'tcp',
      });
    });

    this.once('close', () => {
      if (reportedAddress) {
        emit({
          event: 'close',
          address: reportedAddress.address,
          port: reportedAddress.port,
          protocol: 'tcp',
        });
      }
    });

    this.once('error', error => {
      emit({
        event: 'error',
        code: error && error.code ? String(error.code) : 'LISTEN_ERROR',
        message: error && error.message ? String(error.message) : 'Server listen failed',
        port: reportedAddress && reportedAddress.port ? reportedAddress.port : -1,
      });
    });

    return originalListen.apply(this, args);
  };
}
