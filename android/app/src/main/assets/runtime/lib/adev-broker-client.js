#!/usr/bin/env node
'use strict';

const net = require('net');

function brokerRequest(payload) {
  const port = Number(process.env.ADEV_GIT_CREDENTIAL_PORT || 0);
  const session = process.env.ADEV_GIT_CREDENTIAL_SESSION || '';
  if (!port || !session) {
    return Promise.reject(new Error('native credential broker is unavailable'));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(15000);
    socket.on('connect', () => {
      socket.end(`${JSON.stringify({ ...payload, session })}\n`);
    });
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 1024 * 1024) socket.destroy(new Error('broker response too large'));
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response.trim() || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('timeout', () => socket.destroy(new Error('credential broker timed out')));
    socket.on('error', reject);
  });
}

module.exports = { brokerRequest };
