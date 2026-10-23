import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { startServer } from '../src/runtime.mjs';
import { startForwarder, sshArguments } from '../src/forwarder.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multi-auth-runtime-'));
  const config = {
    root,
    node: process.execPath,
    strategy: 'sequential',
    mode: 'local',
    clientApiKey: 'test-private-key-never-production',
    ports: { router: await freePort(), gateway: await freePort(), client: await freePort() },
    ...overrides,
  };
  await mkdir(path.join(root, 'current-proxy', 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'current-proxy', 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'current-proxy', 'scripts', 'codex-app-router.js'),
    `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--state') + 1]));
const server = http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== state.clientApiKey) { res.writeHead(401); res.end(); return; }
  if (req.url.startsWith('/models')) writeFileSync(state.statusPath + '.catalog-request', req.url);
  if (req.url.startsWith('/models?') && req.url !== '/models?client_version=0.164.0') { res.writeHead(400); res.end(); return; }
  if (req.url === '/__setup_router_ready__') { res.writeHead(404); res.end(); return; }
  if (req.url === '/models' || req.url === '/models?client_version=0.164.0') { res.end(JSON.stringify({data:[{id:'test-model'}]})); return; }
  if (req.url === '/stream') {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write('data: first\\n\\n');
    const timer = setTimeout(() => res.end('data: last\\n\\n'), 350);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  res.end(JSON.stringify({strategy:process.env.CODEX_AUTH_SCHEDULING_STRATEGY, pid:process.pid,
    codexHome:process.env.CODEX_HOME, pool:process.env.CODEX_MULTI_AUTH_DIR,
    auth:req.headers.authorization, keyMatches:req.headers['x-api-key']===state.clientApiKey}));
});
server.listen(state.port, '127.0.0.1', () => writeFileSync(state.statusPath, JSON.stringify({state:'running',pid:process.pid})));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  );
  const bin = path.join(root, 'current-cli', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, 'codex'),
    `#!${process.execPath}
console.log(JSON.stringify({status:'running',appServerVersion:'0.164.0',managedCodexVersion:'0.163.0'}));
`,
  );
  await chmod(path.join(bin, 'codex'), 0o700);
  const runtime = await startServer(config);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${config.ports.gateway}`;
  const control = (action, extra = {}, key = config.clientApiKey) =>
    fetch(`${url}/__setup_control`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
  return { config, root, runtime, url, control };
}

test('owned readiness, isolated child state, key injection, and protected control', async (t) => {
  const { config, root, url, control } = await fixture(t);
  const health = await (await fetch(`${url}/__setup_health`)).json();
  assert.deepEqual(health, { service: 'codex-multi-auth-setup', ready: true, maintenance: false });
  const echo = await (
    await fetch(`${url}/echo`, {
      headers: { 'x-api-key': 'wrong', authorization: 'Bearer client-native-token' },
    })
  ).json();
  assert.equal(echo.keyMatches, true);
  assert.equal(echo.strategy, 'sequential');
  assert.equal(echo.codexHome, path.join(root, 'data', 'codex'));
  assert.equal(echo.pool, path.join(root, 'data', 'multi-auth'));
  assert.equal((await stat(path.join(root, 'router-state.json'))).mode & 0o777, 0o600);
  assert.equal((await control('status', {}, 'wrong')).status, 401);
  assert.equal(
    (await fetch(`${url}/models`, { headers: { origin: 'https://untrusted.example' } })).status,
    403,
  );
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(
      `${url}/models`,
      { headers: { host: 'untrusted.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
  });
  assert.equal(rebound, 403);
  const status = await (await control('status')).json();
  assert.equal(status.pid, echo.pid);
  assert.equal(status.activeRequests, 0);
  assert.deepEqual(await (await control('probe')).json(), {
    ok: true,
    modelCount: 1,
    models: ['test-model'],
  });
  assert.equal(
    await readFile(path.join(root, 'router-status.json.catalog-request'), 'utf8'),
    '/models?client_version=0.164.0',
  );
  const state = JSON.parse(await readFile(path.join(root, 'router-state.json')));
  assert.equal(state.nativeOpenai, true);
  assert.equal(state.host, '127.0.0.1');
  assert.equal(state.port, config.ports.router);
});

test('streaming stays active during maintenance; drain precedes reload and strategy applies', async (t) => {
  const { config, root, url, control } = await fixture(t);
  const oldPid = (await (await control('status')).json()).pid;
  const stream = await fetch(`${url}/stream`);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  await mkdir(path.join(root, 'maintenance.lock'));
  assert.equal((await fetch(`${url}/models`)).status, 503);
  assert.equal((await control('reload')).status, 409);
  assert.equal((await control('drain', { timeoutMs: 0 })).status, 409);
  const drained = control('drain', { timeoutMs: 2000 });
  assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
  assert.equal((await drained).status, 200);
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ ...config, strategy: 'hybrid' }),
  );
  const reloaded = await (await control('reload')).json();
  assert.notEqual(reloaded.pid, oldPid);
  assert.equal(reloaded.ready, true);
  assert.equal((await control('probe')).status, 200);
  await rm(path.join(root, 'maintenance.lock'), { recursive: true });
  assert.equal((await (await fetch(`${url}/echo`)).json()).strategy, 'hybrid');
});

test('websocket upgrade explicitly falls back to HTTP with426', async (t) => {
  const { config } = await fixture(t);
  const code = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: config.ports.gateway,
        headers: { connection: 'Upgrade', upgrade: 'websocket' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
  });
  assert.equal(code, 426);
});

test('local forwarder waits for owned health and closes sockets without orphaning child', async (t) => {
  const { config, runtime, control } = await fixture(t);
  const pid = (await (await control('status')).json()).pid;
  const forwarder = await startForwarder(config);
  t.after(() => forwarder.close());
  const response = await fetch(`http://127.0.0.1:${config.ports.client}/models`);
  assert.equal(response.status, 200);
  assert.equal(forwarder.ready(), true);
  await forwarder.close();
  await runtime.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  for (const port of [config.ports.client, config.ports.gateway, config.ports.router]) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/__setup_health`));
  }
});

test('unexpected router exit restarts with a new owned process', async (t) => {
  const { control } = await fixture(t);
  const previous = (await (await control('status')).json()).pid;
  process.kill(previous, 'SIGKILL');
  let state;
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    state = await (await control('status')).json();
    if (state.ready && state.pid !== previous) break;
  }
  assert.equal(state.ready, true);
  assert.notEqual(state.pid, previous);
});

test('forwarder refuses another installation even with a valid owned health marker', async (t) => {
  const { config, url } = await fixture(t, { installationId: 'expected-installation' });
  assert.equal(
    (await (await fetch(`${url}/__setup_health`)).json()).installationId,
    'expected-installation',
  );
  const mismatched = await startForwarder({ ...config, installationId: 'different-installation' });
  t.after(() => mismatched.close());
  await sleep(600);
  assert.equal(mismatched.ready(), false);
  await mismatched.close();
  const matched = await startForwarder(config);
  t.after(() => matched.close());
  assert.equal((await fetch(`http://127.0.0.1:${config.ports.client}/models`)).status, 200);
  assert.equal(matched.ready(), true);
});

test('account maintenance pauses the only router until explicit reload', async (t) => {
  const { root, url, control } = await fixture(t);
  assert.equal((await control('pause')).status, 409);
  await mkdir(path.join(root, 'maintenance.lock'));
  const paused = await (await control('pause')).json();
  assert.equal(paused.ready, false);
  assert.equal(paused.pid, null);
  await sleep(1200);
  assert.equal((await (await control('status')).json()).pid, null);
  assert.equal((await fetch(`${url}/__setup_health`)).status, 503);
  assert.equal((await control('reload')).status, 200);
  assert.equal((await (await control('status')).json()).ready, true);
});

test('SSH tunnel uses configured addresses and strict host verification without shell', () => {
  const config = {
    ports: { tunnel: 12345, gateway: 23456 },
    ssh: { port: 2222, identityFile: '/tmp/key with spaces', hostKeyAlias: 'trusted-server' },
  };
  const args = sshArguments(config, 'alice@server');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ControlPath=none'));
  assert.ok(args.includes('HostKeyAlias=trusted-server'));
  assert.ok(args.includes('127.0.0.1:12345:127.0.0.1:23456'));
  assert.ok(args.includes('/tmp/key with spaces'));
  assert.equal(args.at(-1), 'alice@server');
  assert.throws(() => sshArguments(config, '-oProxyCommand=bad'));
});

test('SSH forwarding falls back, reconnects after child failure, and reaps owned children', async (t) => {
  const { config, root } = await fixture(t);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const executable = path.join(bin, 'ssh');
  const pidFile = path.join(root, 'ssh.pid');
  const attemptsFile = path.join(root, 'ssh.attempts');
  await writeFile(
    executable,
    `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const host = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(attemptsFile)}, host + '\\n');
if (host === 'unavailable-primary') process.exit(1);
const [bind, local, remote, port] = process.argv[process.argv.indexOf('-L') + 1].split(':');
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy()); };
const server = net.createServer(socket => {
  track(socket);
  const upstream = net.connect(Number(port), remote);
  track(upstream);
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  socket.pipe(upstream); upstream.pipe(socket);
});
server.listen(Number(local), bind, () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
`,
  );
  await chmod(executable, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const forwarder = await startForwarder({
    ...config,
    mode: 'ssh',
    ports: { ...config.ports, tunnel: await freePort() },
    ssh: {
      host: 'unavailable-primary',
      fallbackHost: 'reachable-fallback',
      hostKeyAlias: 'known-test-host',
    },
  });
  t.after(() => forwarder.close());
  assert.equal((await fetch(`http://127.0.0.1:${config.ports.client}/models`)).status, 200);
  const firstPid = Number(await readFile(pidFile, 'utf8'));
  process.kill(firstPid, 'SIGKILL');
  let nextPid = firstPid;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    nextPid = Number(await readFile(pidFile, 'utf8'));
    if (nextPid !== firstPid && forwarder.ready()) break;
  }
  assert.notEqual(nextPid, firstPid);
  assert.equal((await fetch(`http://127.0.0.1:${config.ports.client}/models`)).status, 200);
  const attempts = (await readFile(attemptsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(attempts, [
    'unavailable-primary',
    'reachable-fallback',
    'unavailable-primary',
    'reachable-fallback',
  ]);
  await forwarder.close();
  assert.throws(() => process.kill(nextPid, 0), { code: 'ESRCH' });
});

test('catalog probe reports missing client version instead of issuing an unversioned request', async (t) => {
  const { root, control } = await fixture(t);
  await rm(path.join(root, 'current-cli'), { recursive: true });
  const response = await control('probe');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'Model catalog probe requires a detectable native Codex version',
  });
});
