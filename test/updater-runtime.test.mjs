import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/runtime.mjs';
import { runUpdate } from '../src/updater.mjs';

const integrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function setup(t, failCatalog) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'setup-live-update-')));
  const config = {
    schemaVersion: 1,
    root,
    node: process.execPath,
    strategy: 'sequential',
    codexHome: path.join(root, 'native'),
    clientApiKey: 'isolated-test-private-api-key',
    ports: { router: await port(), gateway: await port() },
    updates: { enabled: true, delayHours: 48, cli: false },
  };
  await mkdir(path.join(root, 'data', 'multi-auth'), { recursive: true });
  const tokenFile = path.join(root, 'data', 'multi-auth', 'test-tokens.json');
  await writeFile(tokenFile, JSON.stringify({ token: 'before-update' }));
  const packages = [];
  for (const version of ['1.0.0', '1.1.0']) {
    const wrapper = path.join(root, 'releases', `proxy-${version}`);
    const packagePath = path.join(wrapper, 'node_modules', 'codex-multi-auth');
    packages.push(packagePath);
    await mkdir(path.join(packagePath, 'scripts'), { recursive: true });
    await writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({ name: 'codex-multi-auth', type: 'module', version }),
    );
    const lock = JSON.stringify({ packages: {} });
    await writeFile(path.join(wrapper, 'package-lock.json'), lock);
    await writeFile(
      path.join(packagePath, '.setup-release.json'),
      JSON.stringify({
        kind: 'proxy',
        version,
        integrity,
        lockSha256: createHash('sha256').update(lock).digest('hex'),
      }),
    );
    await writeFile(
      path.join(packagePath, 'scripts', 'codex-app-router.js'),
      `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--state') + 1]));
const version = ${JSON.stringify(version)};
if (version === '1.1.0') writeFileSync(${JSON.stringify(tokenFile)}, JSON.stringify({token:'refreshed-by-new-release'}));
const server = http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== state.clientApiKey) { res.writeHead(401); res.end(); return; }
  if (req.url === '/__setup_router_ready__') { res.writeHead(404); res.end(); return; }
  if (req.url === '/models?client_version=0.164.0') { res.end(JSON.stringify({data: version==='1.1.0' && ${Boolean(failCatalog)} ? [] : [{id:'test-model'}]})); return; }
  if (req.url === '/stream') { res.write('first'); setTimeout(() => res.end('last'), 300); return; }
  res.end(JSON.stringify({version,pid:process.pid}));
});
server.listen(state.port, '127.0.0.1', () => writeFileSync(state.statusPath, JSON.stringify({state:'running',pid:process.pid})));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
    );
  }
  await symlink(packages[0], path.join(root, 'current-proxy'));
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const bin = path.join(config.codexHome, 'packages', 'app-server-daemon', 'current', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, 'codex'),
    `#!${process.execPath}
console.log(JSON.stringify({status:'running',appServerVersion:'0.164.0'}));
`,
  );
  await chmod(path.join(bin, 'codex'), 0o700);
  const runtime = await startServer(config);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url !== 'https://registry.npmjs.org/codex-multi-auth') return originalFetch(url, options);
    const versions = Object.fromEntries(
      ['1.0.0', '1.1.0'].map((version) => [
        version,
        {
          name: 'codex-multi-auth',
          version,
          dist: {
            integrity,
            tarball: `https://registry.npmjs.org/codex-multi-auth/-/codex-multi-auth-${version}.tgz`,
          },
        },
      ]),
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.1.0' },
          versions,
          time: { '1.0.0': '2000-01-01T00:00:00Z', '1.1.0': '2000-01-02T00:00:00Z' },
        }),
      ),
    );
  });
  return { root, config, packages, tokenFile, url: `http://127.0.0.1:${config.ports.gateway}` };
}

test('real supervisor drains a streaming request before activating staged update', async (t) => {
  const fixture = await setup(t, false);
  const previous = await (await fetch(`${fixture.url}/version`)).json();
  const stream = await fetch(`${fixture.url}/stream`);
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  const update = runUpdate(fixture.root);
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'last');
  const result = await update;
  assert.equal(result.outcome, 'updated', JSON.stringify(result));
  const current = await (await fetch(`${fixture.url}/version`)).json();
  assert.equal(current.version, '1.1.0');
  assert.notEqual(current.pid, previous.pid);
  assert.throws(() => process.kill(previous.pid, 0), { code: 'ESRCH' });
  assert.equal(await readlink(path.join(fixture.root, 'current-proxy')), fixture.packages[1]);
  assert.equal(
    JSON.parse(await readFile(path.join(result.backup, 'data/multi-auth/test-tokens.json'))).token,
    'before-update',
  );
  assert.equal(JSON.parse(await readFile(fixture.tokenFile)).token, 'refreshed-by-new-release');
  await assert.rejects(stat(path.join(fixture.root, 'maintenance.lock')), { code: 'ENOENT' });
});

test('real supervisor rolls failed catalog back without reverting refreshed account state', async (t) => {
  const fixture = await setup(t, true);
  const result = await runUpdate(fixture.root);
  assert.equal(result.outcome, 'rolled-back', JSON.stringify(result));
  assert.equal((await (await fetch(`${fixture.url}/version`)).json()).version, '1.0.0');
  assert.equal(await readlink(path.join(fixture.root, 'current-proxy')), fixture.packages[0]);
  assert.equal(JSON.parse(await readFile(fixture.tokenFile)).token, 'refreshed-by-new-release');
  await assert.rejects(stat(path.join(fixture.root, 'maintenance-state/transaction.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(stat(path.join(fixture.root, 'maintenance.lock')), { code: 'ENOENT' });
});
