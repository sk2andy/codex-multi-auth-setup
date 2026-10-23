import fs from 'node:fs/promises';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  atomicJson,
  readJson,
  validateConfig,
  managementEnvironment,
  publicConfig,
} from './config.mjs';
import { backupFiles, serverConfigFiles } from './backup.mjs';
import { run } from './process.mjs';
import { stageProxy, stageCli, runUpdate, inspectManagedPackage, acquireLock } from './updater.mjs';
import { installServices, serviceStatus } from './services.mjs';
import { inspectVersions } from './doctor.mjs';

export const accountCommands = {
  list: ['list'],
  stats: ['status'],
  add: ['login', '--device-auth', '--preserve-selection'],
  remove: ['login'],
  dashboard: ['login'],
  usage: ['usage'],
};

export function accountArguments(payload) {
  if (payload.command !== 'proxy' && !Object.hasOwn(accountCommands, payload.command))
    throw new Error('Unknown proxy command');
  if (
    payload.args !== undefined &&
    (!Array.isArray(payload.args) ||
      payload.args.some((value) => typeof value !== 'string' || value.includes('\0')))
  )
    throw new Error('Proxy arguments must be strings without NUL characters');
  if (payload.loginMethod !== undefined && !['device', 'browser'].includes(payload.loginMethod))
    throw new Error('Unknown login method');
  const base =
    payload.command === 'add' && payload.loginMethod === 'browser'
      ? ['login', '--preserve-selection']
      : accountCommands[payload.command];
  const args =
    payload.command === 'proxy' ? (payload.args ?? []) : [...base, ...(payload.args ?? [])];
  if (!args.length) throw new Error('Missing upstream proxy command');
  return args;
}

async function control(config, action, timeoutMs = 30_000) {
  const response = await fetch(`http://127.0.0.1:${config.ports.gateway}/__setup_control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.clientApiKey },
    body: JSON.stringify({ action, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  if (!response.ok) {
    let detail = '';
    if (action === 'probe') {
      const report = await response.json().catch(() => null);
      if (
        typeof report?.error === 'string' &&
        /^(Router probe returned \d{3}|Invalid router catalog|Router probe timed out|Model catalog probe requires a detectable native Codex version)$/.test(
          report.error,
        )
      )
        detail = `: ${report.error}`;
    }
    const error = new Error(
      `Runtime control ${action} returned ${response.status}${action === 'drain' ? '; requests may not have drained' : ''}${detail}`,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

async function maintenance(config, reason, operation) {
  const lock = path.join(config.root, 'maintenance.lock');
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Another update/account operation is running. Inspect doctor before removing a stale maintenance.lock.',
        { cause: error },
      );
    throw error;
  }
  let paused = false;
  let result;
  let operationError;
  try {
    await atomicJson(path.join(lock, 'owner.json'), {
      pid: process.pid,
      reason,
      createdAt: new Date().toISOString(),
    });
    if (config.initialized) {
      paused = true;
      try {
        await control(config, 'pause');
      } catch (error) {
        // Known rejections happen before stopping the child. A lost response is
        // uncertain: attempt reload before releasing the account-ownership lock.
        if ([400, 401, 403, 404, 405, 409].includes(error.httpStatus)) paused = false;
        throw error;
      }
    }
    const backup = await backupFiles(config.root, serverConfigFiles(config), reason);
    result = await operation(backup);
  } catch (error) {
    operationError = error;
  }
  if (paused) {
    try {
      await control(config, 'reload', 90_000);
    } catch (error) {
      const previousOwner = await readJson(path.join(lock, 'owner.json'), {});
      await atomicJson(path.join(lock, 'owner.json'), {
        ...previousOwner,
        pid: process.pid,
        reason,
        createdAt: previousOwner.createdAt ?? new Date().toISOString(),
        requiresRecovery: true,
        error: error.message,
      });
      const failure = new Error(
        `Runtime could not resume. Maintenance remains locked to protect accounts. Run doctor and repair the service before recovery: ${error.message}`,
        { cause: error },
      );
      if (operationError) failure.operationError = operationError;
      throw failure;
    }
  }
  await fs.rm(lock, { recursive: true, force: true });
  if (operationError) throw operationError;
  return result;
}

async function selectInitialPackage(root, kind, selected) {
  const destination = path.join(root, `current-${kind}`);
  const existing = await inspectManagedPackage(root, kind);
  if (existing) return existing;
  const temporary = `${destination}.setup-${process.pid}`;
  try {
    await fs.symlink(selected.packagePath, temporary);
    await fs.rename(temporary, destination);
    const directory = await fs.open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return selected;
}

async function initializeInternal(config, { resume = false } = {}) {
  validateConfig(config);
  await fs.mkdir(config.root, { recursive: true, mode: 0o700 });
  await fs.chmod(config.root, 0o700);
  const lock = path.join(config.root, 'maintenance.lock');
  if (!(await acquireLock(lock)))
    throw new Error('Another maintenance operation is running or requires recovery');
  try {
    const filename = path.join(config.root, 'config.json');
    const saved = await readJson(filename, null);
    if (resume) {
      if (!saved || saved.initialized !== false)
        throw new Error('Only an unfinished installation can be resumed');
      config = validateConfig(saved);
    } else if (saved)
      throw new Error(
        'Installation already exists. Use resume for unfinished setup, or configure instead.',
      );
    const backup = await backupFiles(
      config.root,
      serverConfigFiles(config),
      resume ? 'resume installation' : 'installation',
    );
    await atomicJson(filename, { ...config, initialized: false });
    for (const directory of ['data/multi-auth', 'data/codex', 'logs'])
      await fs.mkdir(path.join(config.root, directory), { recursive: true, mode: 0o700 });
    const proxy =
      (await inspectManagedPackage(config.root, 'proxy')) ??
      (await selectInitialPackage(
        config.root,
        'proxy',
        await stageProxy(config.root, { delayHours: config.updates.delayHours }),
      ));
    let cli;
    if (config.updates.cli) {
      cli =
        (await inspectManagedPackage(config.root, 'cli')) ??
        (await selectInitialPackage(config.root, 'cli', await stageCli(config.root)));
    }
    return {
      backup,
      proxyVersion: proxy.version,
      cliVersion: cli?.version ?? null,
      initialized: false,
    };
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

export async function initialize(config) {
  return initializeInternal(config);
}

function assertProcessStopped(pid, label) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    throw new Error(`${label} PID is missing or invalid; inspect doctor before recovery`);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw new Error(`Cannot establish that ${label.toLowerCase()} has stopped`, { cause: error });
  }
  throw new Error(`${label} is still running; recovery cannot interrupt it`);
}

function assertOwnerStopped(owner) {
  assertProcessStopped(owner?.pid, 'Maintenance owner');
  if (owner.childPid !== undefined) assertProcessStopped(owner.childPid, 'Upstream account child');
}

function recordAccountChild(root, childPid) {
  const filename = path.join(root, 'maintenance.lock', 'owner.json');
  const owner = JSON.parse(readFileSync(filename, 'utf8'));
  if (owner.pid !== process.pid)
    throw new Error('Maintenance ownership changed before account command started');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify({ ...owner, childPid }, null, 2)}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, filename);
    const directory = openSync(path.dirname(filename), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recoverableAccountOperation(owner) {
  return (
    typeof owner?.reason === 'string' &&
    (/^upstream (?:[a-z][a-z-]*|\(custom command\))$/.test(owner.reason) ||
      ['configuration change', 'background service installation'].includes(owner.reason))
  );
}

async function recover(config, payload) {
  if (payload.confirmed !== true)
    throw new Error('Recovery requires explicit confirmation after reviewing doctor');
  const lock = path.join(config.root, 'maintenance.lock');
  const owner = await readJson(path.join(lock, 'owner.json'), null);
  const transaction = await readJson(
    path.join(config.root, 'maintenance-state', 'transaction.json'),
    null,
  );
  if (transaction) {
    if (owner?.requiresRecovery)
      throw new Error(
        'Account/config recovery and update journal coexist; inspect doctor before changing either',
      );
    if (owner) assertOwnerStopped(owner);
    return runUpdate(config.root, { recoverOnly: true });
  }
  if (!recoverableAccountOperation(owner))
    throw new Error('No known account/config recovery lock found');
  assertOwnerStopped(owner);
  const recoveryLock = path.join(lock, 'recovery.lock');
  if (!(await acquireLock(recoveryLock))) throw new Error('Another recovery is running');
  try {
    const current = await readJson(path.join(lock, 'owner.json'));
    if (
      !recoverableAccountOperation(current) ||
      current.pid !== owner.pid ||
      current.createdAt !== owner.createdAt ||
      current.reason !== owner.reason
    )
      throw new Error('Maintenance owner changed during recovery');
    assertOwnerStopped(current);
    const backup = await backupFiles(
      config.root,
      serverConfigFiles(config),
      'recover account/config maintenance',
    );
    await control(config, 'drain');
    const status = await control(config, 'reload', 90_000);
    if (status.ready !== true)
      throw new Error('Runtime did not confirm readiness; recovery lock retained');
    await fs.rm(lock, { recursive: true });
    const directory = await fs.open(config.root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { outcome: 'recovered', backup, oauthRestored: false };
  } finally {
    await fs.rm(recoveryLock, { recursive: true, force: true });
  }
}

export async function dispatch(action, root, payload = {}) {
  if (action === 'initialize') return initialize(payload.config);
  const config = validateConfig(await readJson(path.join(root, 'config.json')));
  if (path.resolve(config.root) !== path.resolve(root))
    throw new Error('Installation root does not match configuration');
  if (action === 'read') return publicConfig(config);
  if (action === 'resume') return initializeInternal(config, { resume: true });
  if (action === 'recover') return recover(config, payload);
  if (action === 'usage-summary') {
    return maintenance(config, 'read-only usage and bank-reset details', async () => {
      const result = await run(
        config.node,
        [path.join(config.appDir, 'src/usage-reader.mjs'), root],
        {
          env: managementEnvironment(config),
          cwd: root,
          timeoutMs: 120000,
        },
      );
      return JSON.parse(result.stdout);
    });
  }
  if (action === 'accounts') {
    const args = accountArguments(payload);
    const commandName = /^[a-z][a-z-]*$/.test(args[0]) ? args[0] : '(custom command)';
    return maintenance(config, `upstream ${commandName}`, async (backup) => {
      process.stderr.write(
        `Backup: ${backup}\nUpstream: codex-multi-auth ${commandName} (${args.length - 1} additional arguments)\n`,
      );
      if (payload.command === 'remove')
        process.stderr.write(
          'Official account manager: choose the account, then Delete (D). Ctrl+C cancels.\n',
        );
      const result = await run(
        config.node,
        [path.join(root, 'current-proxy', 'scripts', 'codex-multi-auth.js'), ...args],
        {
          interactive: payload.interactive !== false,
          env: managementEnvironment(config),
          cwd: root,
          onSpawn: (pid) => recordAccountChild(root, pid),
        },
      );
      return {
        backup,
        code: result.code,
        ...(payload.interactive === false ? { stdout: result.stdout } : {}),
      };
    });
  }
  if (action === 'configure') {
    const allowed = ['strategy', 'updates', 'scheduler'];
    const changes = Object.fromEntries(
      Object.entries(payload.changes ?? {}).filter(([key]) => allowed.includes(key)),
    );
    const next = validateConfig({ ...config, ...changes });
    return maintenance(config, 'configuration change', async (backup) => {
      await atomicJson(path.join(root, 'config.json'), next);
      return { backup, config: publicConfig(next) };
    });
  }
  if (action === 'services') {
    if (config.systemService) await run('sudo', ['-v'], { interactive: true });
    return maintenance(config, 'background service installation', async () => {
      const result = await installServices(config, { role: 'server' });
      await backupFiles(root, [path.join(root, 'config.json')], 'mark initialized');
      await atomicJson(path.join(root, 'config.json'), { ...config, initialized: true });
      return result;
    });
  }
  if (action === 'updates')
    return runUpdate(root, {
      checkOnly: payload.checkOnly ?? false,
      force: payload.force ?? false,
    });
  if (action === 'codex') {
    const executable = path.join(root, 'current-cli', 'bin', 'codex');
    return run(executable, payload.args ?? [], { interactive: true });
  }
  if (action === 'link-cli') {
    const bin = path.join(os.homedir(), '.local', 'bin');
    const destinations = [
      'codex',
      ...(process.platform === 'darwin' ? ['codex-code-mode-host'] : []),
    ];
    const backup = await backupFiles(
      root,
      destinations.map((name) => path.join(bin, name)),
      'link managed Codex CLI',
    );
    await fs.mkdir(bin, { recursive: true });
    for (const name of destinations) {
      const destination = path.join(bin, name);
      const temporary = `${destination}.setup-${process.pid}`;
      await fs.symlink(path.join(root, 'current-cli', 'bin', name), temporary);
      await fs.rename(temporary, destination);
    }
    return { backup, path: bin };
  }
  if (action === 'doctor') {
    const checks = [
      {
        name: 'Installation',
        ok: config.initialized === true,
        detail: config.initialized === true ? 'Initialized' : 'Setup unfinished; use resume',
      },
    ];
    try {
      const status = await control(config, 'status');
      checks.push({ name: 'Runtime', ok: status.ready === true, detail: status });
    } catch (error) {
      checks.push({ name: 'Runtime', ok: false, detail: error.message });
    }
    try {
      const probe = await control(config, 'probe');
      checks.push({
        name: 'Model catalog',
        ok: probe.ok === true && probe.modelCount > 0,
        detail: probe,
      });
    } catch (error) {
      checks.push({ name: 'Model catalog', ok: false, detail: error.message });
    }
    const services = await serviceStatus(config);
    checks.push({ name: 'Background service', ok: services.active, detail: services.service });
    try {
      const info = await run(path.join(root, 'current-cli/bin/codex'), ['--version']);
      checks.push({ name: 'Managed Codex CLI', ok: true, detail: info.stdout.trim() });
    } catch {
      checks.push({ name: 'Managed Codex CLI', ok: !config.updates.cli, detail: 'Not installed' });
    }
    checks.push(...(await inspectVersions(config)));
    const updateStatus = await readJson(path.join(root, 'maintenance-state', 'status.json'), null);
    const maintenanceState = await readJson(
      path.join(root, 'maintenance.lock', 'owner.json'),
      null,
    );
    const updateTransaction = await readJson(
      path.join(root, 'maintenance-state', 'transaction.json'),
      null,
    );
    return {
      checks,
      updates: updateStatus,
      maintenance: maintenanceState,
      updateRecoveryRequired: Boolean(updateTransaction),
      config: publicConfig(config),
    };
  }
  throw new Error(`Unknown worker action: ${action}`);
}

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    options: { root: { type: 'string' }, payload: { type: 'string' } },
    allowPositionals: true,
  });
  if (!values.root || !path.isAbsolute(values.root)) throw new Error('--root must be absolute');
  let input = '';
  if (values.payload) input = Buffer.from(values.payload, 'base64url').toString('utf8');
  else
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Worker input too large');
    }
  const result = await dispatch(positionals[0], values.root, input ? JSON.parse(input) : {});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
