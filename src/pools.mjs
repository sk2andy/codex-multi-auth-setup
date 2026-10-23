import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson } from './config.mjs';
import { backupFiles } from './backup.mjs';
import {
  install,
  loadClient,
  waitForClient,
  writeDesktop,
  accountAction,
  doctor,
  configure,
  resume,
} from './installer.mjs';
import { select, text, confirm, p } from './prompts.mjs';
import { run } from './process.mjs';

export function poolPaths(base, name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name))
    throw new Error(
      'Pool name must be 1–40 lowercase letters, digits or hyphens, starting with a letter',
    );
  const root = path.join(base, 'pools', name);
  return {
    clientRoot: path.join(root, 'client'),
    serverRoot: path.join(root, 'server'),
    codexHome: path.join(root, 'codex'),
  };
}

const registryFile = (base) => path.join(base, 'pools.json');
async function registry(base) {
  return readJson(registryFile(base), { schemaVersion: 1, defaultPool: null });
}

export async function selectedPoolName(base, name, command) {
  return (
    name ?? (!['install', 'connect'].includes(command) ? (await registry(base)).defaultPool : null)
  );
}

async function locations(base, name) {
  const paths = poolPaths(base, name);
  return (await registry(base)).adoptedPool === name ? { ...paths, clientRoot: base } : paths;
}

export async function selectedPoolRoot(base, name, command) {
  // Legacy installs remain untouched. With a default, management commands select
  // that pool; installation always requires an explicit pool to avoid surprises.
  const selected = await selectedPoolName(base, name, command);
  return selected ? (await locations(base, selected)).clientRoot : base;
}

export async function seedPoolHome(destination, source) {
  if (!path.isAbsolute(source)) throw new Error('Seed source must be absolute');
  if (!(await fs.stat(source)).isDirectory()) throw new Error('Seed source must be a directory');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.mkdir(destination, { mode: 0o700 }); // Never merge or overwrite an existing home.
  // Explicit snapshot, not a symlink: no concurrent token writes across pools.
  // Live SQLite databases are deliberately excluded.
  for (const name of [
    'config.toml',
    'auth.json',
    'history.jsonl',
    'sessions',
    'skills',
    'plugins',
  ]) {
    const from = path.join(source, name);
    try {
      await fs.cp(from, path.join(destination, name), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        filter: async (entry) => {
          const stat = await fs.lstat(entry);
          if (stat.isSymbolicLink())
            throw new Error('Seed contains a symlink; copy a reviewed snapshot instead');
          return stat.isFile() || stat.isDirectory();
        },
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // Imported credentials must remain private regardless of source permissions.
  for (const name of ['auth.json', 'config.toml', 'history.jsonl'])
    await fs.chmod(path.join(destination, name), 0o600).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
}

export function poolCliArguments(client, args = [], poolName) {
  if (poolName !== undefined) poolPaths('/unused', poolName);
  // A base URL override alone still selects the built-in OpenAI provider,
  // which requires a local login. The pool proxy owns authentication instead.
  const provider = poolName ? `codex_pool_${poolName.replaceAll('-', '_')}` : 'codex_managed_pool';
  return [
    '-c',
    `model_provider="${provider}"`,
    '-c',
    `model_providers.${provider}.name=${JSON.stringify(poolName ? `Codex pool: ${poolName}` : 'Managed Codex pool')}`,
    '-c',
    `model_providers.${provider}.base_url="http://127.0.0.1:${client.ports.client}/v1"`,
    '-c',
    `model_providers.${provider}.wire_api="responses"`,
    '-c',
    `model_providers.${provider}.requires_openai_auth=false`,
    ...args,
  ];
}

export async function poolAction(base, args) {
  const [action, name, ...rest] = args;
  if (!action || ['menu', 'dashboard'].includes(action)) return poolMenu(base);
  if (action === 'list') {
    for (const pool of await availablePools(base))
      process.stdout.write(
        `${pool.name}${pool.default ? ' (default)' : ''}${pool.ready ? '' : ' (unfinished)'}\n`,
      );
    return;
  }
  if (action === 'clear-default') {
    // Does not guess the old endpoint. Restore the reported backup explicitly.
    await backupFiles(base, [registryFile(base)], 'clear default pool');
    await atomicJson(registryFile(base), { ...(await registry(base)), defaultPool: null });
    process.stdout.write(
      'Default selection cleared. Desktop endpoint is unchanged; restore its backup to disconnect.\n',
    );
    return;
  }
  const paths = await locations(base, name);
  if (action === 'adopt') {
    if (rest.length) throw new Error('pools adopt NAME');
    const state = await registry(base);
    if (state.adoptedPool && state.adoptedPool !== name)
      throw new Error('Existing installation already belongs to another pool');
    const client = await loadClient(base);
    if (
      !state.adoptedPool &&
      (await fs.stat(path.join(base, 'pools', name)).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }))
    )
      throw new Error('A named pool already exists at this path');
    await backupFiles(base, [registryFile(base)], 'name existing installation');
    await atomicJson(registryFile(base), { ...state, adoptedPool: name });
    process.stdout.write(
      `Existing installation assigned to pool ${name}. Credentials, services and home unchanged.\n`,
    );
    return { clientRoot: base, pending: client.pending };
  }
  if (action === 'create') {
    if (rest.length && (rest[0] !== '--seed-from' || rest.length !== 2))
      throw new Error('pools create NAME [--seed-from /absolute/codex-home]');
    if ((await registry(base)).adoptedPool === name)
      throw new Error('Pool already represents the existing installation');
    if (!process.stdin.isTTY) throw new Error('Pool setup requires a terminal');
    if (rest[0]) await seedPoolHome(paths.codexHome, rest[1]);
    return install(paths.clientRoot, { ...paths, pool: true });
  }
  const client = await loadClient(paths.clientRoot);
  if (client.pending) throw new Error(`Pool unfinished: use --pool ${name} resume`);
  if (action === 'home') {
    if (!rest.length) {
      process.stdout.write(`${client.codexHome}\n`);
      return;
    }
    if (rest.length !== 1) throw new Error('pools home NAME [isolated | /absolute/path]');
    const destination = rest[0] === 'isolated' ? paths.codexHome : rest[0];
    if (!path.isAbsolute(destination) || /[\r\n\0]/.test(destination))
      throw new Error('Codex home must be an absolute path without control characters');
    const resolved = path.resolve(destination);
    for (const pool of await availablePools(base)) {
      if (pool.name === name) continue;
      const other = await loadClient(pool.clientRoot);
      if (other.codexHome && path.resolve(other.codexHome) === resolved)
        throw new Error('Codex home already belongs to another pool');
    }
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const filename = path.join(paths.clientRoot, 'client.json');
    const backup = await backupFiles(paths.clientRoot, [filename], 'change pool CLI home');
    await atomicJson(filename, { ...client, codexHome: resolved });
    process.stdout.write(
      `Pool ${name} Codex home: ${resolved}\nPrevious home left unchanged: ${client.codexHome}\nSettings/history are not copied. Proxy accounts unchanged. Backup: ${backup}\n`,
    );
    return;
  }
  if (action === 'default') {
    if (rest.length) throw new Error('pools default NAME');
    await waitForClient(client);
    const desktopHome = process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex');
    if (desktopHome === client.codexHome && (await registry(base)).adoptedPool !== name)
      throw new Error('Desktop home must be separate from pool home');
    const backup = await writeDesktop({ ...client, codexHome: desktopHome });
    await backupFiles(base, [registryFile(base)], 'select default pool');
    await atomicJson(registryFile(base), { ...(await registry(base)), defaultPool: name });
    process.stdout.write(
      `Default pool: ${name}. Desktop backup: ${backup}. Restart the desktop app. Login/history unchanged.\n`,
    );
    return;
  }
  if (action === 'run') {
    await waitForClient(client);
    // Run locally even when the selected pool's proxy lives over SSH.
    // The client home contains this pool's endpoint, config, tools and history.
    // Keep launch diagnostics off stdout so exec/JSON output stays machine-readable.
    process.stderr.write(
      `Codex pool: ${name} | Proxy: http://127.0.0.1:${client.ports.client}/v1\n` +
        'Check /status inside Codex for the active provider and endpoint.\n',
    );
    return run('codex', poolCliArguments(client, rest[0] === '--' ? rest.slice(1) : rest, name), {
      interactive: true,
      env: { CODEX_HOME: client.codexHome },
    });
  }
  throw new Error('pools: create | adopt | list | home | default | clear-default | run');
}

export async function availablePools(base) {
  const state = await registry(base);
  const entries = await fs
    .readdir(path.join(base, 'pools'), { withFileTypes: true })
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const pools = [];
  const names = new Set(entries.filter((item) => item.isDirectory()).map((item) => item.name));
  if (state.adoptedPool) names.add(state.adoptedPool);
  for (const name of names) {
    const paths = await locations(base, name);
    const client = await readJson(path.join(paths.clientRoot, 'client.json'), null);
    pools.push({
      name,
      ...paths,
      ready: Boolean(client && !client.pending),
      default: state.defaultPool === name,
    });
  }
  return pools.sort((a, b) => a.name.localeCompare(b.name));
}

export async function poolMenu(base) {
  if (!process.stdin.isTTY) throw new Error('Pool dashboard requires a terminal');
  while (true) {
    const pools = await availablePools(base);
    const legacy = await readJson(path.join(base, 'client.json'), null);
    const choice = await select('Pools verwalten', [
      { value: ':create', label: 'Pool anlegen' },
      ...pools.map((pool) => ({
        value: pool.name,
        label: `${pool.name}${pool.default ? ' (Standard)' : ''}${pool.ready ? '' : ' (unfertig)'}`,
      })),
      ...(legacy && !(await registry(base)).adoptedPool
        ? [{ value: ':legacy', label: 'Bestehende Installation / bisherige Konten' }]
        : []),
      { value: ':exit', label: 'Beenden' },
    ]);
    if (choice === ':exit') return;
    if (choice === ':create') {
      const name = await text('Pool-Name (z. B. work oder personal)', '', (value) => {
        try {
          poolPaths(base, value);
        } catch (error) {
          return error.message;
        }
      });
      const seed = await confirm(
        'Konfiguration und History aus einem gestoppten Codex-Home kopieren?',
        false,
      );
      const source = seed
        ? await text('Absoluter Pfad des Snapshots', '', (value) =>
            path.isAbsolute(value) ? undefined : 'Absoluten Pfad angeben',
          )
        : null;
      await poolAction(base, ['create', name, ...(source ? ['--seed-from', source] : [])]);
      continue;
    }
    const selected = pools.find((pool) => pool.name === choice);
    const root = selected?.clientRoot ?? base;
    const ready = selected ? selected.ready : !legacy.pending;
    const action = await select(`Pool: ${selected?.name ?? 'bestehende Installation'}`, [
      ...(!ready ? [{ value: 'resume', label: 'Einrichtung fortsetzen' }] : []),
      ...(!selected
        ? [{ value: ':adopt', label: 'Bestehende Installation als benannten Pool übernehmen' }]
        : []),
      { value: 'add', label: 'Account diesem Pool hinzufügen (Anmeldung)' },
      { value: 'list', label: 'Zugeordnete Accounts anzeigen' },
      { value: 'dashboard', label: 'Interaktives Account-Dashboard dieses Pools' },
      { value: 'remove', label: 'Account aus diesem Pool entfernen' },
      ...(ready
        ? [
            { value: 'stats', label: 'Account-Status' },
            { value: 'usage', label: 'Usage / Bank Resets mit Ablaufzeiten (nur lesen)' },
            { value: 'configure', label: 'Routing / Updates konfigurieren' },
            { value: 'doctor', label: 'Diagnose' },
            ...(selected
              ? [
                  { value: ':default', label: 'Als Desktop-Standard wählen' },
                  { value: ':run', label: 'Separate Codex-CLI starten' },
                  { value: ':home', label: 'Codex-Home anzeigen / ändern' },
                ]
              : []),
          ]
        : []),
      { value: ':back', label: 'Zurück' },
    ]);
    if (action === ':back') continue;
    p.note(
      'Accounts sind dem ausgewählten Pool zugeordnet. Ein Login in einem anderen Pool verschiebt oder entfernt keine bestehende Zuordnung. App-Login und Cloud-History bleiben getrennt.',
      'Pool-Grenze',
    );
    if (action === ':adopt') {
      const name = await text('Pool-Name', '', (value) => {
        try {
          poolPaths(base, value);
        } catch (error) {
          return error.message;
        }
      });
      await poolAction(base, ['adopt', name]);
    } else if (action === ':home') {
      const client = await loadClient(root);
      p.note(client.codexHome, 'Aktuelles Codex-Home');
      const choice = await select('Codex-Home wählen (altes Verzeichnis bleibt unverändert)', [
        { value: 'isolated', label: 'Eigenes Verzeichnis im Pool (empfohlen)' },
        { value: 'custom', label: 'Eigenen absoluten Pfad angeben' },
        { value: 'keep', label: 'Unverändert lassen' },
      ]);
      if (choice !== 'keep') {
        const destination =
          choice === 'custom'
            ? await text('Absoluter Codex-Home-Pfad', '', (value) =>
                path.isAbsolute(value) ? undefined : 'Absoluten Pfad angeben',
              )
            : 'isolated';
        await poolAction(base, ['home', selected.name, destination]);
      }
    } else if (action === ':default') await poolAction(base, ['default', selected.name]);
    else if (action === ':run') await poolAction(base, ['run', selected.name]);
    else if (action === 'configure') await configure(root);
    else if (action === 'doctor') await doctor(root);
    else if (action === 'resume') await resume(root);
    else await accountAction(root, action);
  }
}
