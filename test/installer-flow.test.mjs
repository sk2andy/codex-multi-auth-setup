import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/runtime.mjs';
import { run } from '../src/process.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

test('worker account/configuration flow pauses sole router, preserves native auth, resumes after errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'setup-worker-flow-'));
  const scripts = path.join(root, 'current-proxy', 'scripts');
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(root, 'native'));
  const nativeAuth = path.join(root, 'native', 'auth.json');
  await writeFile(nativeAuth, '{"native":"untouched"}');
  const config = {
    schemaVersion: 1,
    root,
    appDir: project,
    node: process.execPath,
    mode: 'local',
    strategy: 'sequential',
    clientApiKey: 'isolated-worker-test-private-key',
    initialized: true,
    codexHome: path.join(root, 'native'),
    ports: {
      client: await port(),
      router: await port(),
      gateway: await port(),
      tunnel: await port(),
    },
    updates: { enabled: false, cli: false, delayHours: 48, intervalHours: 1 },
  };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'current-proxy', 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(scripts, 'codex-app-router.js'),
    `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--state')+1]));
const server = http.createServer((req,res) => {
  if (req.headers['x-api-key'] !== state.clientApiKey) {res.writeHead(401);res.end();return;}
  if (req.url === '/__setup_router_ready__') {res.writeHead(404);res.end();return;}
  res.end(JSON.stringify({pid:process.pid,strategy:process.env.CODEX_AUTH_SCHEDULING_STRATEGY}));
});
server.listen(state.port,'127.0.0.1',()=>writeFileSync(state.statusPath,JSON.stringify({pid:process.pid,state:'running'})));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
  );
  await writeFile(
    path.join(scripts, 'codex-multi-auth.js'),
    `
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const old = JSON.parse(readFileSync('router-status.json')).pid;
try {process.kill(old,0);process.exit(9);} catch(error) {if(error.code!=='ESRCH')throw error;}
if(process.argv.includes('--fail'))process.exit(7);
if(process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI!=='0'||process.env.CODEX_MULTI_AUTH_APP_BIND!=='0')process.exit(8);
writeFileSync(path.join(process.env.CODEX_MULTI_AUTH_DIR,'test-account.json'),JSON.stringify({scope:process.env.CODEX_HOME}));
console.log(JSON.stringify({args:process.argv.slice(2),pool:process.env.CODEX_MULTI_AUTH_DIR}));
`,
  );
  const runtime = await startServer(config);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const worker = (action, payload) =>
    run(process.execPath, [path.join(project, 'src', 'worker.mjs'), action, '--root', root], {
      input: JSON.stringify(payload),
      timeoutMs: 10000,
    });
  const result = JSON.parse(
    (await worker('accounts', { command: 'add', interactive: false })).stdout,
  );
  assert.deepEqual(JSON.parse(result.stdout).args, [
    'login',
    '--device-auth',
    '--preserve-selection',
  ]);
  const browser = JSON.parse(
    (await worker('accounts', { command: 'add', loginMethod: 'browser', interactive: false }))
      .stdout,
  );
  assert.deepEqual(JSON.parse(browser.stdout).args, ['login', '--preserve-selection']);
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'data/multi-auth/test-account.json'))).scope,
    path.join(root, 'data/codex'),
  );
  assert.equal(await readFile(nativeAuth, 'utf8'), '{"native":"untouched"}');
  const changed = JSON.parse(
    (await worker('configure', { changes: { strategy: 'hybrid' } })).stdout,
  );
  assert.equal(changed.config.strategy, 'hybrid');
  assert.equal(
    (await (await fetch(`http://127.0.0.1:${config.ports.gateway}/echo`)).json()).strategy,
    'hybrid',
  );
  await assert.rejects(
    worker('accounts', { command: 'proxy', args: ['status', '--fail'], interactive: false }),
    /exited/,
  );
  const health = await (
    await fetch(`http://127.0.0.1:${config.ports.gateway}/__setup_health`)
  ).json();
  assert.equal(health.ready, true);
  assert.equal(health.maintenance, false);
  assert.equal(await readFile(nativeAuth, 'utf8'), '{"native":"untouched"}');
});
