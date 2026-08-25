#!/usr/bin/env node
/**
 * adev-ports-cli.js — netstat/ss/lsof-compatible listing of servers started
 * inside A Dev Studio. Android 10+ hides /proc/net from apps (SELinux), so
 * these commands cannot read kernel tables; instead they render the app's own
 * verified task-port registry (TaskRegistry), which is populated from
 * structured listen events and confirmed by 127.0.0.1 connect probes.
 *
 * Foreign apps' sockets are invisible by OS design and are never listed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function snapshotPath() {
  return (
    process.env.ADEV_PORTS_FILE ||
    path.join(process.env.PREFIX || '', 'tmp', 'adev-ports.json')
  );
}

function loadPorts() {
  try {
    const raw = fs.readFileSync(snapshotPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.ports) ? parsed.ports : [];
  } catch (_) {
    return [];
  }
}

function pad(value, width) {
  value = String(value);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function prefixPad(value, width) {
  value = String(value);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

const mode = (process.argv[2] || 'netstat').toLowerCase();
const args = process.argv.slice(3);

if (args.includes('-h') || args.includes('--help')) {
  console.log(
    'Usage: ' +
      mode +
      ' — lists listening servers started inside A Dev Studio.\n' +
      'Android 10+ forbids apps from reading /proc/net, so system netstat/ss/lsof\n' +
      'cannot work; this tool reports the app\'s own verified task ports instead.'
  );
  process.exit(0);
}

let ports = loadPorts();

// lsof -i[:PORT] filtering (also tolerate netstat-style nothing).
if (mode === 'lsof') {
  const joined = args.join(' ');
  const match = joined.match(/-i\s*:?\s*(\d{1,5})/) || joined.match(/-i(\d{1,5})/);
  if (match) {
    const wanted = parseInt(match[1], 10);
    ports = ports.filter((entry) => entry.port === wanted);
  }
  if (args.includes('-t')) {
    const pids = [...new Set(ports.map((entry) => String(entry.pid)))];
    console.log(pids.join('\n'));
    process.exit(0);
  }
}

if (mode === 'ss') {
  console.log('State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process');
  for (const entry of ports) {
    console.log(
      pad('LISTEN', 6) +
        ' ' +
        pad(0, 6) +
        ' ' +
        pad(0, 6) +
        ' ' +
        pad('*:' + entry.port, 19) +
        ' ' +
        pad('*:*', 18) +
        ' users:(("task",pid=' + entry.pid + ',taskId=' + entry.taskId + '))'
    );
  }
  process.exit(0);
}

if (mode === 'lsof') {
  console.log('COMMAND PID   TASK   TYPE NODE NAME');
  for (const entry of ports) {
    console.log(
      pad('node', 7) +
        prefixPad(entry.pid, 5) +
        prefixPad(entry.taskId, 7) +
        '  IPv4  LISTEN  tcp  *:' +
        entry.port
    );
  }
  process.exit(0);
}

// Default: netstat style.
console.log('Active Internet connections (only servers, A Dev Studio tasks)');
console.log(
  pad('Proto', 6) +
    ' ' +
    prefixPad('Recv-Q', 6) +
    ' ' +
    prefixPad('Send-Q', 6) +
    ' ' +
    pad('Local Address', 22) +
    ' ' +
    pad('Foreign Address', 22) +
    ' ' +
    pad('State', 12) +
    ' PID/Task'
);
for (const entry of ports) {
  console.log(
    pad('tcp', 6) +
      ' ' +
      prefixPad(0, 6) +
      ' ' +
      prefixPad(0, 6) +
      ' ' +
      pad('*:' + entry.port, 22) +
      ' ' +
      pad('*:*', 22) +
      ' ' +
      pad('LISTEN', 12) +
      ' ' +
      entry.pid +
      '/' +
      entry.taskId
  );
}
process.exit(0);
