import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  poolAction,
  poolPaths,
  seedPoolHome,
  selectedPoolRoot,
  availablePools,
  poolCliArguments,
} from '../src/pools.mjs';
import { atomicJson, managementEnvironment } from '../src/config.mjs';

test('pool CLI uses proxy-owned authentication without importing a local login', () => {
  const args = ['exec', 'A prompt with spaces', '--model', 'gpt-6.1-sol'];
  const personal = poolCliArguments({ ports: { client: 64415 } }, args);
  const work = poolCliArguments({ ports: { client: 64412 } }, args);
  assert.ok(personal.includes('model_provider="codex_managed_pool"'));
  assert.ok(personal.includes('model_providers.codex_managed_pool.requires_openai_auth=false'));
  assert.ok(
    personal.includes('model_providers.codex_managed_pool.base_url="http://127.0.0.1:64415/v1"'),
  );
  assert.ok(
    work.includes('model_providers.codex_managed_pool.base_url="http://127.0.0.1:64412/v1"'),
  );
  assert.deepEqual(personal.slice(-args.length), args);
});

test('pool identity is visible in the provider without changing its auth or endpoint', () => {
  for (const name of ['work', 'personal']) {
    const args = poolCliArguments({ ports: { client: 65000 } }, ['resume', '--last'], name);
    assert.ok(args.includes(`model_providers.codex_pool_${name}.name="Codex pool: ${name}"`));
    assert.ok(
      args.includes(`model_providers.codex_pool_${name}.base_url="http://127.0.0.1:65000/v1"`),
    );
    assert.deepEqual(args.slice(-2), ['resume', '--last']);
  }
  assert.throws(() => poolCliArguments({ ports: { client: 65000 } }, [], 'bad\\"name'));
});

test('pool paths reject traversal and isolate account stores', () => {
  for (const name of ['../work', '', '-work', 'Work', 'work/x'])
    assert.throws(() => poolPaths('/tmp/base', name));
  const work = poolPaths('/tmp/base', 'work');
  const personal = poolPaths('/tmp/base', 'personal');
  assert.notEqual(work.codexHome, personal.codexHome);
  const env = (pool) =>
    managementEnvironment({ root: pool.serverRoot, node: process.execPath, strategy: 'hybrid' });
  assert.notEqual(env(work).CODEX_MULTI_AUTH_DIR, env(personal).CODEX_MULTI_AUTH_DIR);
});

test('default selection preserves legacy installs and explicit pool takes precedence', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pools-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.equal(await selectedPoolRoot(base, undefined, 'stats'), base);
  await atomicJson(path.join(base, 'pools.json'), { schemaVersion: 1, defaultPool: 'personal' });
  assert.equal(
    await selectedPoolRoot(base, undefined, 'stats'),
    poolPaths(base, 'personal').clientRoot,
  );
  assert.equal(await selectedPoolRoot(base, 'work', 'stats'), poolPaths(base, 'work').clientRoot);
  assert.equal(await selectedPoolRoot(base, undefined, 'install'), base);
});

test('seed snapshots auth/config/history without sharing mutable files or live databases', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-seed-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const dest = path.join(base, 'dest');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'auth.json'), '{"token":"fixture"}', { mode: 0o644 });
  await fs.writeFile(path.join(source, 'config.toml'), '# config');
  await fs.writeFile(path.join(source, 'state.sqlite'), 'live database');
  await seedPoolHome(dest, source);
  assert.equal((await fs.stat(path.join(dest, 'auth.json'))).mode & 0o777, 0o600);
  await fs.writeFile(path.join(dest, 'auth.json'), 'changed');
  assert.match(await fs.readFile(path.join(source, 'auth.json'), 'utf8'), /fixture/);
  await assert.rejects(fs.stat(path.join(dest, 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(seedPoolHome(dest, source), { code: 'EEXIST' });
  await fs.symlink('/tmp', path.join(source, 'skills'));
  await assert.rejects(seedPoolHome(path.join(base, 'unsafe'), source), /symlink/);
});

test('dashboard discovers ready and interrupted pools without exposing account credentials', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-menu-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await atomicJson(path.join(poolPaths(base, 'work').clientRoot, 'client.json'), {
    pending: false,
    clientApiKey: 'private-fixture',
  });
  await atomicJson(path.join(poolPaths(base, 'personal').clientRoot, 'client.json'), {
    pending: true,
  });
  await atomicJson(path.join(base, 'pools.json'), { schemaVersion: 1, defaultPool: 'work' });
  const pools = await availablePools(base);
  assert.deepEqual(
    pools.map(({ name, ready, default: standard }) => ({ name, ready, standard })),
    [
      { name: 'personal', ready: false, standard: false },
      { name: 'work', ready: true, standard: true },
    ],
  );
  assert.ok(!JSON.stringify(pools).includes('private-fixture'));
});

test('adopting an existing installation preserves credentials, services and default across updates', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-adopt-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const client = {
    pending: false,
    codexHome: path.join(base, 'home'),
    root: path.join(base, 'server'),
  };
  await atomicJson(path.join(base, 'client.json'), client);
  await fs.mkdir(path.join(base, 'server'), { recursive: true });
  const secret = path.join(base, 'server', 'accounts.json');
  await fs.writeFile(secret, 'private fixture');
  await poolAction(base, ['adopt', 'work']);
  assert.equal(await selectedPoolRoot(base, 'work', 'stats'), base);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(base, 'client.json'), 'utf8')), client);
  assert.equal(await fs.readFile(secret, 'utf8'), 'private fixture');
  assert.deepEqual(
    (await availablePools(base)).map((p) => [p.name, p.ready, p.clientRoot]),
    [['work', true, base]],
  );
  await assert.rejects(poolAction(base, ['adopt', 'personal']), /already belongs/);
  await assert.rejects(poolAction(base, ['create', 'work']), /already represents/);
  await poolAction(base, ['clear-default']);
  assert.equal(await selectedPoolRoot(base, 'work', 'stats'), base);
});

test('changing an adopted pool home preserves proxy settings and the old home', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-home-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const old = path.join(base, 'desktop');
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, 'auth.json'), 'untouched');
  const client = { codexHome: old, serverCodexHome: old, ports: { client: 64412 } };
  await atomicJson(path.join(base, 'client.json'), client);
  await atomicJson(path.join(base, 'pools.json'), { adoptedPool: 'work', defaultPool: 'work' });
  await poolAction(base, ['home', 'work', 'isolated']);
  const updated = JSON.parse(await fs.readFile(path.join(base, 'client.json')));
  assert.equal(updated.codexHome, poolPaths(base, 'work').codexHome);
  assert.equal(updated.serverCodexHome, old);
  assert.deepEqual(updated.ports, client.ports);
  assert.equal(await fs.readFile(path.join(old, 'auth.json'), 'utf8'), 'untouched');
  await assert.rejects(poolAction(base, ['home', 'work', '../relative']));
});
