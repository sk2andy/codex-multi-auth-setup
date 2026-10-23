import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parse } from 'smol-toml';
import { run, shellCommand, shellQuote } from '../src/process.mjs';
import { setDesktopEndpoint, validHost, validateConfig, atomicJson } from '../src/config.mjs';
import { Target, sshArguments } from '../src/target.mjs';
import { backupFiles } from '../src/backup.mjs';
import { accountArguments, dispatch } from '../src/worker.mjs';
import { chooseLogin } from '../src/installer.mjs';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Shell transport roundtrips hostile arguments without executing them', async (t) => {
  const directory = await temporary(t);
  const marker = path.join(directory, 'injected');
  const args = [
    `'; touch ${marker}; #`,
    '$(printf bad)',
    '`printf bad`',
    'a\nb',
    'quotes " and \'',
    '100%',
  ];
  const program =
    'process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.TEST_SAFE,cwd:process.cwd()}))';
  const command = shellCommand(process.execPath, ['-e', program, ...args], {
    cwd: directory,
    env: { TEST_SAFE: args[0] },
  });
  const result = JSON.parse((await run('/bin/sh', ['-c', command])).stdout);
  assert.deepEqual(result.args, args);
  assert.equal(result.value, args[0]);
  assert.equal(await fs.realpath(result.cwd), await fs.realpath(directory));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.throws(() => shellQuote('bad\0value'), /NUL/);
  assert.throws(() => shellCommand('true', [], { env: { 'EVIL;false': 'x' } }), /environment name/);
});

test('Malicious SSH destinations/options cannot become command-line options or shell fragments', () => {
  for (const host of [
    '-oProxyCommand=bad',
    'host;touch /tmp/bad',
    'host$(id)',
    'user@host\nProxyCommand=bad',
    'host name',
    'a@@b',
  ]) {
    assert.equal(validHost(host), false, host);
    assert.throws(() => sshArguments({ host }), /destination/);
  }
  const args = sshArguments({
    host: 'user@nas.local',
    port: 2222,
    identityFile: '/home/user/key with spaces',
    hostKeyAlias: 'nas.local',
  });
  assert.deepEqual(args.slice(-2), ['--', 'user@nas.local']);
  assert.equal(args[args.indexOf('-i') + 1], '/home/user/key with spaces');
  assert.throws(() => sshArguments({ host: 'nas', port: '-o' }), /port/);
  assert.throws(() => sshArguments({ host: 'nas', hostKeyAlias: 'x\nProxyCommand=bad' }), /option/);
});

test('Remote environment reaches target, never contaminates SSH process environment', async (t) => {
  const directory = await temporary(t);
  let observed;
  const target = new Target(
    { mode: 'ssh', ssh: { host: 'example' } },
    async (exe, args, options) => {
      observed = { exe, args, options };
      return run('/bin/sh', ['-c', args.at(-1)], options);
    },
  );
  const value = "literal'; $(false) #";
  const response = await target.run(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.MY_TARGET_VALUE)'],
    { cwd: directory, env: { MY_TARGET_VALUE: value }, timeoutMs: 3000 },
  );
  assert.equal(response.stdout, value);
  assert.equal(observed.exe, 'ssh');
  assert.equal(observed.options.env, undefined);
  assert.equal(observed.options.cwd, undefined);
  assert.equal(observed.options.timeoutMs, 3000);
});

test('Desktop TOML edit preserves comments, tables, arrays and datetime semantics', () => {
  const before =
    '# Header\nopenai_base_url = "http://old" # Keep this\nmodel = "example"\ncreated = 2026-01-02T03:04:05Z\n[profiles.work]\nopenai_base_url = "http://profile"\nvalues = [1, 2, 3]\n';
  const url = 'http://127.0.0.1:64412';
  const after = setDesktopEndpoint(before, url);
  assert.deepEqual({ ...parse(after) }, { ...parse(before), openai_base_url: url });
  assert.ok(after.includes('# Keep this'));
  assert.equal(
    after.slice(after.indexOf('[profiles.work]')),
    before.slice(before.indexOf('[profiles.work]')),
  );
  assert.throws(() => setDesktopEndpoint(before, 'https://external.example'), /loopback/);
});

test('Endpoint-looking text inside TOML multiline string is never silently rewritten', () => {
  const before =
    'description = """\nopenai_base_url = \'untouched text\'\n"""\n[tools]\nenabled = true\n';
  assert.throws(() => setDesktopEndpoint(before, 'http://127.0.0.1:64412'), /safely edit/);
  const ordinary = 'description = """\n[example]\n"""\nmodel = "x"\n';
  assert.deepEqual(
    { ...parse(setDesktopEndpoint(ordinary, 'http://127.0.0.1:64412')) },
    { ...parse(ordinary), openai_base_url: 'http://127.0.0.1:64412' },
  );
});

test('Backups preserve symlinks without traversing outside requested tree, hashes and source modes', async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, 'configs');
  const outside = path.join(directory, 'outside-secret');
  await fs.mkdir(source);
  await fs.writeFile(outside, 'unrelated');
  await fs.writeFile(path.join(source, 'config.json'), '{"secret":"private"}', { mode: 0o640 });
  await fs.symlink(outside, path.join(source, 'linked'));
  await fs.symlink('missing', path.join(source, 'dangling'));
  const backup = await backupFiles(
    path.join(directory, 'installation'),
    [source, path.join(directory, 'missing')],
    'test',
  );
  const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  const snapshot = path.join(backup, manifest.sources[0].snapshot);
  assert.equal(await fs.readlink(path.join(snapshot, 'linked')), outside);
  assert.equal(await fs.readlink(path.join(snapshot, 'dangling')), 'missing');
  assert.equal(manifest.sources[1].existed, false);
  const regular = manifest.files.find((file) => file.path.endsWith('/config.json'));
  assert.match(regular.sha256, /^[a-f0-9]{64}$/);
  assert.equal(regular.mode, 0o640);
  assert.equal((await fs.stat(path.join(snapshot, 'config.json'))).mode & 0o777, 0o600);
  assert.equal(manifest.files.filter((file) => file.sha256).length, 1);
});

test('Backup rejects unsupported file types and recursive snapshot roots', async (t) => {
  const directory = await temporary(t);
  const fifo = path.join(directory, 'configuration-pipe');
  await run('mkfifo', [fifo]);
  await assert.rejects(
    backupFiles(path.join(directory, 'root'), [fifo], 'invalid'),
    /Unsupported configuration file type/,
  );
  await assert.rejects(
    backupFiles(directory, [directory], 'recursive'),
    /own snapshot destination/,
  );
});

test('Target writes replace symlinks atomically without modifying unrelated target', async (t) => {
  const directory = await temporary(t);
  const original = path.join(directory, 'unrelated');
  const destination = path.join(directory, "config with ' quotes.json");
  await fs.writeFile(original, 'keep');
  await fs.symlink(original, destination);
  const target = new Target({ mode: 'local' });
  await target.write(destination, 'new private config');
  assert.equal(await fs.readFile(original, 'utf8'), 'keep');
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'new private config');
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.endsWith('.tmp')),
    false,
  );
  await assert.rejects(target.write(directory, 'bad'), /exited/);
  await assert.rejects(target.write(destination, 'bad', '600; false'), /mode/);
});

test('Account helpers delegate official upstream commands, including removal manager', () => {
  assert.deepEqual(accountArguments({ command: 'list' }), ['list']);
  assert.deepEqual(accountArguments({ command: 'stats' }), ['status']);
  assert.deepEqual(accountArguments({ command: 'add' }), [
    'login',
    '--device-auth',
    '--preserve-selection',
  ]);
  assert.deepEqual(accountArguments({ command: 'add', loginMethod: 'browser' }), [
    'login',
    '--preserve-selection',
  ]);
  assert.deepEqual(accountArguments({ command: 'add', loginMethod: 'device' }), [
    'login',
    '--device-auth',
    '--preserve-selection',
  ]);
  assert.throws(() => accountArguments({ command: 'add', loginMethod: 'invalid' }), /login method/);
  assert.deepEqual(accountArguments({ command: 'remove' }), ['login']);
  assert.deepEqual(accountArguments({ command: 'proxy', args: ['usage', '--help'] }), [
    'usage',
    '--help',
  ]);
  assert.throws(() => accountArguments({ command: 'typo', args: ['login'] }), /Unknown/);
  assert.throws(() => accountArguments({ command: 'proxy', args: 'login' }), /strings/);
  assert.throws(() => accountArguments({ command: 'proxy', args: [] }), /Missing/);
});

test('Account failure resumes runtime; failed resume retains explicit recovery lock', async (t) => {
  const root = await temporary(t);
  const calls = [];
  let failReload = false;
  let dropPauseResponse = false;
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const { action } = JSON.parse(input);
    calls.push(action);
    if (action === 'pause' && dropPauseResponse) return response.destroy();
    if (action === 'reload' && failReload) response.writeHead(500).end('{}');
    else response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const gateway = server.address().port;
  const other = [60101, 60102, 60103, 60104].filter((port) => port !== gateway).slice(0, 3);
  const config = validateConfig({
    schemaVersion: 1,
    root,
    node: process.execPath,
    appDir: root,
    mode: 'local',
    strategy: 'sequential',
    ports: { gateway, router: other[0], client: other[1], tunnel: other[2] },
    updates: { delayHours: 48, intervalHours: 1 },
    initialized: true,
    clientApiKey: 'fixture-key-at-least-16',
  });
  assert.throws(
    () => validateConfig({ ...config, ports: { a: 60101, b: 60102, c: 60103, d: 60104 } }),
    /Four different/,
  );
  assert.throws(() => validateConfig({ ...config, clientApiKey: 'weak' }), /gateway key/);
  await atomicJson(path.join(root, 'config.json'), config);
  const scripts = path.join(root, 'current-proxy', 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(path.join(scripts, 'codex-multi-auth.js'), 'process.exit(17);');
  await assert.rejects(
    dispatch('accounts', root, { command: 'list', interactive: false }),
    /exited with 17/,
  );
  assert.deepEqual(calls, ['pause', 'reload']);
  await assert.rejects(fs.stat(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  dropPauseResponse = true;
  await assert.rejects(
    dispatch('accounts', root, { command: 'list', interactive: false }),
    /fetch failed/,
  );
  assert.deepEqual(calls.slice(-2), ['pause', 'reload']);
  await assert.rejects(fs.stat(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  dropPauseResponse = false;
  failReload = true;
  await assert.rejects(
    dispatch('accounts', root, { command: 'list', interactive: false }),
    /Maintenance remains locked/,
  );
  const owner = JSON.parse(
    await fs.readFile(path.join(root, 'maintenance.lock', 'owner.json'), 'utf8'),
  );
  assert.equal(owner.requiresRecovery, true);
  await assert.rejects(
    dispatch('accounts', root, { command: 'list', interactive: false }),
    /Another update/,
  );
});

test('Output-limited child cannot hang indefinitely by ignoring SIGTERM', async () => {
  const started = Date.now();
  await assert.rejects(
    run(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});process.stdout.write("x".repeat(1000));setInterval(()=>{},1000)',
      ],
      { maxOutput: 10, timeoutMs: 10000 },
    ),
    /time\/output limit/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('login choice accepts either explicit method, strips wrapper flags and rejects conflicting choices', async () => {
  assert.deepEqual(await chooseLogin(['--browser-auth', '--help']), {
    loginMethod: 'browser',
    args: ['--help'],
  });
  assert.deepEqual(await chooseLogin(['--device-auth']), { loginMethod: 'device', args: [] });
  await assert.rejects(chooseLogin(['--browser-auth', '--device-auth']), /ODER/);
  if (!process.stdin.isTTY) await assert.rejects(chooseLogin(), /Anmeldemethode wählen/);
});

test('login method is resolved before transport to legacy per-pool workers', async () => {
  const target = new Target({
    mode: 'local',
    node: process.execPath,
    root: '/tmp/pool',
    appDir: '/tmp/manager',
  });
  const calls = [];
  target.run = async (_node, args, options) => {
    calls.push({ args, options });
    return {};
  };
  for (const interactive of [true, false]) {
    for (const loginMethod of ['browser', 'device']) {
      await target.worker('accounts', { command: 'add', loginMethod, args: [] }, { interactive });
      const call = calls.at(-1);
      const payload = JSON.parse(
        interactive ? Buffer.from(call.args.at(-1), 'base64url').toString() : call.options.input,
      );
      assert.equal(payload.command, 'proxy');
      assert.deepEqual(payload.args, [
        'login',
        ...(loginMethod === 'device' ? ['--device-auth'] : []),
        '--preserve-selection',
      ]);
    }
  }
});
