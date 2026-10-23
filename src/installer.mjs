import { formatUsage } from './usage.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  p,
  confirm,
  select,
  askSsh,
  askStrategy,
  askUpdates,
  askLocation,
  busy,
  Cancelled,
} from './prompts.mjs';
import { Target, ensureNode } from './target.mjs';
import {
  atomicJson,
  readJson,
  publicConfig,
  setDesktopEndpoint,
  defaultClientRoot,
} from './config.mjs';
import { backupFiles } from './backup.mjs';
import { run } from './process.mjs';
import { installServices } from './services.mjs';
import { installTailscale } from './tailscale.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonResult = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));

export async function loadClient(root = defaultClientRoot()) {
  const config = await readJson(path.join(root, 'client.json'), null);
  if (!config) throw new Error('Noch keine Installation. Starte: codex-ma-setup install');
  return config;
}

export async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  const preferred = [64412, 64413, 64414, 64415];
  const ports = [];
  for (let port of preferred) {
    while (ports.includes(port) || !(await portAvailable(port))) port++;
    if (port > 65535) throw new Error('Kein freier lokaler Port gefunden.');
    ports.push(port);
  }
  const [client, router, gateway, tunnel] = ports;
  return { client, router, gateway, tunnel };
}

async function targetPorts(target, node, requested) {
  const ports = { ...requested };
  for (const name of ['router', 'gateway']) {
    const source = `const net=require('node:net');const s=net.createServer();s.on('error',()=>process.exit(2));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close());`;
    let attempts = 0;
    while (
      (await target.run(node, ['-e', source, String(ports[name])], { check: false })).code !== 0
    ) {
      if (++attempts > 100) throw new Error('Keine freien Ports auf dem Ziel gefunden.');
      do {
        ports[name]++;
      } while (Object.entries(ports).some(([key, value]) => key !== name && value === ports[name]));
    }
  }
  return ports;
}

export async function installManager(target, root, node) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ma-pack-'));
  try {
    const result = await run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: projectRoot },
    );
    const filename = JSON.parse(result.stdout)[0].filename;
    const archive = path.join(root, `.manager-${crypto.randomUUID()}.tgz`);
    await target.write(archive, await fs.readFile(path.join(temporary, filename)));
    const directory = path.join(root, 'manager');
    try {
      await target.run('mkdir', ['-p', directory]);
      await target.run(
        'npm',
        [
          'install',
          '--prefix',
          directory,
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          archive,
        ],
        {
          env: { PATH: `${path.dirname(node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` },
          timeoutMs: 600_000,
        },
      );
      return path.join(directory, 'node_modules', 'codex-multi-auth-setup');
    } finally {
      await target.run('rm', ['-f', archive]);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function clientServiceConfig(client) {
  return {
    ...client,
    root: client.clientRoot,
    appDir: client.clientAppDir,
    node: client.clientNode,
    systemService: process.platform === 'linux' && Boolean(client.clientSystemService),
    serviceUser: os.userInfo().username,
    serviceGroup: undefined,
    scheduler: process.platform === 'darwin' ? 'launchd' : 'systemd',
    updates: { ...client.updates, enabled: false },
  };
}

async function startClientServices(client) {
  const config = clientServiceConfig(client);
  if (config.systemService) await run('sudo', ['-v'], { interactive: true });
  p.log.step('Lokalen Verbindungsdienst installieren/starten');
  return installServices(config, { role: 'client' });
}

export async function writeDesktop(client) {
  const filename = path.join(client.codexHome, 'config.toml');
  let previous = '';
  try {
    previous = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = setDesktopEndpoint(previous, `http://127.0.0.1:${client.ports.client}`);
  const backup = await backupFiles(
    client.clientRoot,
    [filename, path.join(client.codexHome, 'auth.json')],
    'desktop endpoint',
  );
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.setup-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filename);
  return backup;
}

export async function waitForClient(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${client.ports.client}/__setup_health`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await response.json();
      if (
        response.ok &&
        body.ready &&
        body.service === 'codex-multi-auth-setup' &&
        (!client.installationId || body.installationId === client.installationId)
      )
        return body;
    } catch {
      /* Connection can be unavailable while the service starts. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    'Verbindung noch nicht bereit. Konfiguration und Backups sind gespeichert. Prüfe „doctor“, SSH-Portfreigabe und Dienstprotokolle.',
  );
}

async function configureTailscale(target, info, clientRoot, serverRoot, mode) {
  const choice = await select(
    'Tailscale optional installieren?',
    [
      { value: 'skip', label: 'Überspringen / bereits eingerichtet' },
      { value: 'client', label: 'Auf diesem Computer' },
      ...(mode === 'ssh'
        ? [
            { value: 'server', label: 'Auf dem SSH-Ziel' },
            { value: 'both', label: 'Auf beiden Geräten' },
          ]
        : []),
    ],
    'skip',
  );
  const destinations = [];
  if (choice === 'client' || choice === 'both')
    destinations.push({
      target: new Target({ mode: 'local' }),
      info: { platform: process.platform },
      root: clientRoot,
    });
  if (choice === 'server' || choice === 'both')
    destinations.push({ target, info, root: serverRoot });
  for (const destination of destinations) {
    const installed = await installTailscale(
      destination.target,
      destination.info,
      destination.root,
    );
    p.log.success(
      `Tailscale ${installed.installed ? 'installiert' : 'vorhanden'}${installed.backup ? `; Backup: ${installed.backup}` : ''}.`,
    );
    p.note(
      destination.info.platform === 'darwin'
        ? 'Tailscale-App öffnen, anmelden und Verbindung einschalten. Danach hier fortfahren.'
        : 'Am Ziel „sudo tailscale up“ starten und dem Anmeldelink folgen.\nDanach hier fortfahren. Vorhandene Tailscale-Einstellungen bleiben unberührt.',
      'Anmeldung',
    );
    if (!(await confirm('Tailscale-Anmeldung erledigt? Fortfahren?', true))) throw new Cancelled();
  }
}

export async function install(clientRoot = defaultClientRoot(), options = {}) {
  p.intro('Codex Multi Auth · Einrichtung');
  const existingClient = await readJson(path.join(clientRoot, 'client.json'), null);
  if (existingClient?.pending) return resume(clientRoot);
  if (existingClient) {
    p.log.info('Installation vorhanden. Der Änderungsdialog wird geöffnet.');
    return configure(clientRoot);
  }
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      'Nutze macOS, Linux oder WSL2. Native Windows-Dienste sind nicht implementiert.',
    );
  const localHome =
    options.codexHome ??
    (process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex'));
  const backup = await backupFiles(
    clientRoot,
    [
      path.join(clientRoot, 'client.json'),
      path.join(localHome, 'config.toml'),
      path.join(localHome, 'auth.json'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    'installation preflight',
  );
  p.log.info(`Konfiguration gesichert: ${backup}`);
  const mode = options.pool
    ? 'local'
    : await select(
        'Wo soll der Account-Proxy laufen?',
        [
          { value: 'local', label: 'Lokal auf diesem Computer' },
          { value: 'ssh', label: 'Auf NAS / Server per SSH' },
        ],
        'local',
      );
  const ssh = mode === 'ssh' ? await askSsh() : null;
  const target = new Target({ mode, ssh });
  if (mode === 'ssh') {
    p.note(
      'SSH-Schlüssel/Agent erforderlich, damit der Hintergrunddienst ohne Passwort verbinden kann.\nNeue Server-Fingerprints bitte anhand deiner Serverdaten bestätigen.',
      'SSH-Zugang',
    );
    await target.trust();
  }
  const info = await busy('Zielsystem prüfen', () => target.inspect());
  const root = options.serverRoot ?? (await askLocation(info.home));
  if (await target.exists(path.join(root, 'config.json')))
    throw new Error(
      'Dieser Server ist bereits eingerichtet. Nutze „connect“, um einen weiteren Computer zu verbinden.',
    );
  if (await target.exists(root)) {
    const contents = await target.run('ls', ['-A', root]);
    const owned = await target.exists(path.join(root, '.codex-ma-setup-owner'));
    if (contents.stdout.trim() && !owned)
      throw new Error(
        'Bitte einen eigenen leeren Installationsordner wählen. Bestehende manuelle Installationen werden nicht überschrieben.',
      );
  }
  await target.write(path.join(root, '.codex-ma-setup-owner'), 'codex-multi-auth-setup\n');
  await configureTailscale(target, info, clientRoot, root, mode);
  if (ssh?.fallbackHost)
    await new Target({ mode, ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
  const strategy = await askStrategy();
  const updates = await askUpdates();
  let scheduler = info.platform === 'darwin' ? 'launchd' : 'systemd';
  if (updates.enabled && info.platform === 'linux')
    scheduler = await select(
      'Update-Zeitplan verwalten mit',
      [
        { value: 'systemd', label: 'systemd-Timer', hint: 'Empfohlen' },
        { value: 'cron', label: 'Cron', hint: 'Eigener Eintrag; andere Jobs bleiben erhalten' },
      ],
      'systemd',
    );
  const systemService =
    info.platform === 'linux' &&
    (await confirm(
      'Systemdienst einrichten, der auch ohne Anmeldung läuft? (sudo)',
      mode === 'ssh',
    ));
  const clientSystemService =
    process.platform === 'linux' &&
    (mode === 'local'
      ? systemService
      : await confirm(
          'Auch den lokalen Verbindungsdienst als Systemdienst starten? (sudo)',
          false,
        ));
  if (info.platform === 'linux' && !systemService)
    p.note(
      'Ein systemd-Benutzerdienst benötigt einen laufenden User-Manager.\nFür Betrieb nach Logout: „sudo loginctl enable-linger <Benutzer>“.',
      'Linux-Benutzerdienst',
    );
  const desktop = options.pool
    ? true
    : await confirm('Codex Desktop auf diesem Computer mit dem Proxy verbinden?', true);
  let ports = await choosePorts();
  p.note(
    `Ziel: ${mode === 'ssh' ? ssh.host : 'dieser Computer'}\nOrdner: ${root}\nAccounts: ${strategy === 'sequential' ? 'Sequenziell' : 'Hybrid'}\nAutomatische Updates: ${updates.enabled ? `alle ${updates.intervalHours} h` : 'aus'}\nProxy-Wartezeit: ${updates.delayHours} h\nDesktop: ${desktop ? `127.0.0.1:${ports.client}` : 'unverändert'}`,
    'Installationsplan',
  );
  if (!(await confirm('Jetzt installieren?', true)))
    return p.cancel('Keine Installation ausgeführt. Backup bleibt erhalten.');
  const node = await busy('Node-Laufzeit prüfen / bei Bedarf installieren', () =>
    ensureNode(target, info, root),
  );
  ports = await targetPorts(target, node, ports);
  const appDir = path.join(root, 'manager', 'node_modules', 'codex-multi-auth-setup');
  const config = {
    schemaVersion: 1,
    installationId: crypto.randomUUID(),
    root,
    node,
    appDir,
    mode,
    ssh,
    strategy,
    updates,
    scheduler,
    ports,
    systemService,
    serviceUser: info.username,
    codexHome: options.pool ? path.join(root, 'cli-home') : path.join(info.home, '.codex'),
    clientApiKey: crypto.randomBytes(32).toString('hex'),
  };
  target.config = config;
  const clientAppDir =
    mode === 'local'
      ? appDir
      : path.join(clientRoot, 'manager', 'node_modules', 'codex-multi-auth-setup');
  const client = {
    ...publicConfig(config),
    clientRoot,
    clientNode: process.execPath,
    clientAppDir,
    serverCodexHome: config.codexHome,
    codexHome: localHome,
    desktop,
    clientSystemService,
    pending: true,
  };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  await busy('Setup-Manager auf dem Ziel installieren', () => installManager(target, root, node));
  if (mode === 'ssh')
    await busy('Lokalen Verbindungsdienst installieren', () =>
      installManager(new Target({ mode: 'local' }), clientRoot, process.execPath),
    );
  const initialized = await busy('Proxy und optionale CLI prüfen und installieren', async () =>
    jsonResult(await target.worker('initialize', { config })),
  );
  p.log.success(
    `Proxy ${initialized.proxyVersion}${initialized.cliVersion ? ` · Codex CLI ${initialized.cliVersion}` : ''}. Backup: ${initialized.backup}`,
  );
  return finishOnboarding(client, target);
}

export async function chooseLogin(args = []) {
  const device = args.includes('--device-auth');
  const browser = args.includes('--browser-auth');
  if (device && browser) throw new Error('Nur --device-auth ODER --browser-auth angeben.');
  let loginMethod = device ? 'device' : browser ? 'browser' : undefined;
  if (!loginMethod) {
    if (!process.stdin.isTTY)
      throw new Error(
        'Anmeldemethode wählen: --device-auth oder --browser-auth (oder interaktiv im Terminal starten).',
      );
    loginMethod = await select('Wie möchtest du den Account anmelden?', [
      {
        value: 'browser',
        label: 'Standard-Flow im Browser',
        hint: 'OAuth mit lokaler Callback-Weiterleitung',
      },
      {
        value: 'device',
        label: 'Device-Code',
        hint: 'Link öffnen und Gerätecode eingeben; auch für SSH',
      },
    ]);
  }
  p.note(
    loginMethod === 'device'
      ? 'Link öffnen und Gerätecode eingeben. Bei jedem Account den gewünschten Account wählen.'
      : 'Standard-Browser-Anmeldung mit Callback auf dem Proxy-Rechner. Bei SSH muss der Callback vom Browser erreichbar sein; alternativ Device-Code wählen.',
    loginMethod === 'device' ? 'Device-Code-Anmeldung' : 'Standard-Browser-Anmeldung',
  );
  return {
    loginMethod,
    args: args.filter((arg) => !['--device-auth', '--browser-auth'].includes(arg)),
  };
}

async function finishOnboarding(client, target) {
  let add = await confirm('Jetzt einen Account anmelden?', true);
  while (add) {
    const login = await chooseLogin();
    await target.worker('accounts', { command: 'add', ...login }, { interactive: true });
    add = await confirm('Weiteren Account hinzufügen?', false);
  }
  if (
    client.updates.cli &&
    (await confirm(
      'Verwaltete CLI als ~/.local/bin/codex auf dem Ziel verlinken? Bestehender Eintrag wird gesichert.',
      false,
    ))
  ) {
    const linked = jsonResult(await target.worker('link-cli'));
    p.log.info(
      `CLI bereit unter ${linked.path}. Dieser Ordner muss im PATH stehen. Backup: ${linked.backup}`,
    );
  }
  await target.worker('services', {}, { interactive: true });
  await startClientServices(client);
  await busy('Verbindung zum Proxy testen', () => waitForClient(client));
  if (client.desktop) p.log.info(`Desktop-Konfiguration gesichert: ${await writeDesktop(client)}`);
  await backupFiles(
    client.clientRoot,
    [path.join(client.clientRoot, 'client.json')],
    'complete onboarding',
  );
  await atomicJson(path.join(client.clientRoot, 'client.json'), { ...client, pending: false });
  p.outro(
    client.desktop
      ? 'Fertig. Codex Desktop jetzt vollständig beenden und neu öffnen. Danach eine kurze Anfrage testen.'
      : 'Fertig. Desktop-Konfiguration unverändert; später über configure verbinden.',
  );
  p.note(
    'Accounts: codex-ma-setup accounts add | list | remove\nStatistik: codex-ma-setup stats\nÄnderungen: codex-ma-setup configure\nDiagnose: codex-ma-setup doctor\nAlle Proxy-Befehle: codex-ma-setup proxy -- --help',
    'Später verwalten',
  );
  return client;
}

export async function resume(clientRoot = defaultClientRoot()) {
  p.intro('Unterbrochene Einrichtung fortsetzen');
  const client = await loadClient(clientRoot);
  if (!client.pending) throw new Error('Einrichtung bereits abgeschlossen. Nutze configure.');
  const target = new Target(client);
  if (client.clientOnly) {
    await startClientServices(client);
    await waitForClient(client);
    if (client.desktop) await writeDesktop(client);
    await backupFiles(
      clientRoot,
      [path.join(clientRoot, 'client.json')],
      'complete client connection',
    );
    await atomicJson(path.join(clientRoot, 'client.json'), { ...client, pending: false });
    p.outro(
      'Verbindung fertig. Codex Desktop bei geänderter Konfiguration vollständig neu starten.',
    );
    return;
  }
  if (!(await target.exists(path.join(client.appDir, 'src/worker.mjs'))))
    await installManager(target, client.root, client.node);
  if (
    client.mode === 'ssh' &&
    !(await new Target({ mode: 'local' }).exists(
      path.join(client.clientAppDir, 'src/forwarder.mjs'),
    ))
  ) {
    await installManager(new Target({ mode: 'local' }), clientRoot, client.clientNode);
  }
  if (await target.exists(path.join(client.root, 'config.json'))) {
    const state = jsonResult(await target.worker('read'));
    if (state.installationId !== client.installationId)
      throw new Error('Server-Identität stimmt nicht mit der begonnenen Installation überein.');
    if (!state.initialized)
      await busy('Pakete prüfen und Einrichtung fortsetzen', () => target.worker('resume'));
  } else {
    const config = {
      ...client,
      codexHome: client.serverCodexHome,
      clientApiKey: crypto.randomBytes(32).toString('hex'),
    };
    await busy('Pakete installieren', () => target.worker('initialize', { config }));
  }
  return finishOnboarding(client, target);
}

export async function recover(clientRoot = defaultClientRoot()) {
  const client = await loadClient(clientRoot);
  p.note(
    'Behebt eine unterbrochene Wartung über deren Journal.\nAktuelle Account-Tokens werden dabei nicht durch Backups ersetzt.\nEine noch laufende Wartung wird nicht übernommen.',
    'Wiederherstellung',
  );
  if (!(await confirm('Wiederherstellung jetzt versuchen?', true))) throw new Cancelled();
  const result = jsonResult(await new Target(client).worker('recover', { confirmed: true }));
  p.note(JSON.stringify(result, null, 2), 'Ergebnis');
}

export async function connect(clientRoot = defaultClientRoot()) {
  p.intro('Vorhandenen Proxy verbinden');
  if (await readJson(path.join(clientRoot, 'client.json'), null))
    throw new Error('Client vorhanden. Nutze configure oder einen anderen --client-root.');
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  await backupFiles(
    clientRoot,
    [
      path.join(codexHome, 'config.toml'),
      path.join(codexHome, 'auth.json'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    'connect existing server',
  );
  const ssh = await askSsh();
  const target = new Target({ mode: 'ssh', ssh });
  await target.trust();
  const info = await target.inspect();
  const root = await askLocation(info.home);
  // Read only installation metadata; the server secret never enters client.json.
  const metadata = JSON.parse(await target.read(path.join(root, 'config.json')));
  target.config = { ...publicConfig(metadata), mode: 'ssh', ssh };
  const existing = jsonResult(await target.worker('read'));
  if (ssh.fallbackHost)
    await new Target({ mode: 'ssh', ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
  const available = await choosePorts();
  const clientAppDir = await busy('Lokalen Manager installieren', () =>
    installManager(new Target({ mode: 'local' }), clientRoot, process.execPath),
  );
  const clientSystemService =
    process.platform === 'linux' &&
    (await confirm('Lokalen Verbindungsdienst als Systemdienst starten? (sudo)', false));
  const client = {
    ...existing,
    mode: 'ssh',
    ssh,
    clientRoot,
    clientNode: process.execPath,
    clientAppDir,
    codexHome,
    pending: true,
    clientOnly: true,
    ports: { ...existing.ports, client: available.client, tunnel: available.tunnel },
    clientSystemService,
    desktop: await confirm('Codex Desktop verbinden?', true),
  };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  await startClientServices(client);
  await busy('Verbindung prüfen', () => waitForClient(client));
  if (client.desktop) await writeDesktop(client);
  await backupFiles(
    clientRoot,
    [path.join(clientRoot, 'client.json')],
    'complete client connection',
  );
  await atomicJson(path.join(clientRoot, 'client.json'), { ...client, pending: false });
  p.outro('Verbunden. Codex Desktop vollständig beenden und neu öffnen.');
}

export async function configure(clientRoot = defaultClientRoot(), requested) {
  p.intro('Codex Multi Auth · Änderungen');
  let client = await loadClient(clientRoot);
  const choice =
    requested ??
    (await select('Was möchtest du ändern?', [
      ...(client.mode === 'ssh'
        ? [{ value: 'host', label: 'Hostname / IP / SSH-Schlüssel / Fallback' }]
        : []),
      { value: 'strategy', label: 'Account-Verteilung' },
      { value: 'updates', label: 'Update-Automatik / Wartezeit / CLI' },
      { value: 'desktop', label: 'Desktop-Verbindung einrichten / reparieren' },
      { value: 'tailscale', label: 'Tailscale nachträglich installieren' },
    ]));
  await backupFiles(
    clientRoot,
    [
      path.join(clientRoot, 'client.json'),
      path.join(client.codexHome, 'config.toml'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    `configure ${choice}`,
  );
  if (choice === 'host') {
    const ssh = await askSsh(client.ssh);
    const target = new Target({ ...client, ssh });
    await target.trust();
    const remote = jsonResult(await target.worker('read'));
    if (
      remote.root !== client.root ||
      remote.ports.gateway !== client.ports.gateway ||
      remote.installationId !== client.installationId
    )
      throw new Error(
        'Die neue Adresse zeigt nicht auf die erwartete Installation. Nutze connect für einen anderen Server.',
      );
    if (ssh.fallbackHost)
      await new Target({ ...client, ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
    client = { ...client, ssh };
    await atomicJson(path.join(clientRoot, 'client.json'), client);
    await startClientServices(client);
    await waitForClient(client);
    p.outro(
      'Adresse geändert. Desktop-Neustart normalerweise nicht nötig; lokale Adresse bleibt gleich.',
    );
    return;
  }
  const target = new Target(client);
  if (choice === 'desktop') {
    await writeDesktop(client);
    p.outro('Konfiguration gesichert und angepasst. Codex Desktop vollständig neu starten.');
    return;
  }
  if (choice === 'tailscale') {
    await configureTailscale(target, await target.inspect(), clientRoot, client.root, client.mode);
    p.outro('Tailscale vorbereitet. Fallback-Adresse kannst du über configure ändern.');
    return;
  }
  const changes =
    choice === 'strategy'
      ? { strategy: await askStrategy(client.strategy) }
      : { updates: await askUpdates(client.updates) };
  if (choice === 'updates' && (await target.inspect()).platform === 'linux')
    changes.scheduler = await select(
      'Update-Zeitplan',
      [
        { value: 'systemd', label: 'systemd-Timer' },
        { value: 'cron', label: 'Cron' },
      ],
      client.scheduler ?? 'systemd',
    );
  const result = jsonResult(await target.worker('configure', { changes }));
  if (changes.updates?.cli && !client.updates.cli) {
    p.log.info('CLI wird beim nächsten Update installiert. Mit „updates run“ sofort ausführen.');
  }
  if (choice === 'updates') await target.worker('services', {}, { interactive: true });
  client = { ...client, ...changes };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  p.outro(`Änderung aktiv. Backup: ${result.backup}. Kein Desktop-Neustart nötig.`);
}

export async function accountAction(clientRoot, command, args = []) {
  const client = await loadClient(clientRoot);
  if (command === 'usage') {
    if (args.some((arg) => arg !== '--json'))
      throw new Error('usage: only --json is supported; this command never redeems resets');
    const report = jsonResult(await new Target(client).worker('usage-summary'));
    process.stdout.write(
      args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : formatUsage(report),
    );
    return;
  }
  const login = command === 'add' ? await chooseLogin(args) : {};
  if (command === 'add') args = login.args;
  if (command === 'remove')
    p.note(
      'Der offizielle Proxy unterstützt keinen direkten „remove“-Unterbefehl.\nEs öffnet sich sein Account-Manager: Account auswählen, dann Löschen (D).',
      'codex-multi-auth login',
    );
  if (['add', 'remove', 'dashboard'].includes(command))
    p.note(
      'Der Proxy pausiert für die Dauer der Account-Verwaltung.\nLaufende Anfragen dürfen vorher fertig werden.',
      'Account-Dateien schützen',
    );
  const reference = `codex-multi-auth ${command === 'add' ? `login ${login.loginMethod === 'device' ? '--device-auth ' : ''}--preserve-selection` : command === 'remove' ? 'login' : command === 'stats' ? 'status' : command === 'proxy' ? '(Proxy-Befehl)' : command}`;
  const structured =
    args.includes('--json') &&
    (['stats', 'list', 'usage'].includes(command) ||
      (command === 'proxy' &&
        [
          'list',
          'status',
          'usage',
          'limits',
          'report',
          'models',
          'forecast',
          'history',
          'resets',
          'doctor',
        ].includes(args[0])));
  if (structured) {
    process.stderr.write(`Weiterleitung an ${reference}\n`);
    const result = jsonResult(
      await new Target(client).worker('accounts', { command, args, interactive: false }),
    );
    process.stdout.write(result.stdout);
    return;
  }
  p.log.info(`Weiterleitung an ${reference}.`);
  await new Target(client).worker('accounts', { command, args, ...login }, { interactive: true });
}

export async function updatesAction(clientRoot, action) {
  if (['configure', 'enable', 'disable'].includes(action)) {
    if (action === 'configure') return configure(clientRoot, 'updates');
    const client = await loadClient(clientRoot);
    const target = new Target(client);
    await backupFiles(clientRoot, [path.join(clientRoot, 'client.json')], `updates ${action}`);
    const updates = { ...client.updates, enabled: action === 'enable' };
    await target.worker('configure', { changes: { updates } });
    await target.worker('services', {}, { interactive: true });
    await atomicJson(path.join(clientRoot, 'client.json'), { ...client, updates });
    p.outro(`Automatische Updates ${updates.enabled ? 'aktiviert' : 'deaktiviert'}.`);
    return;
  }
  const client = await loadClient(clientRoot);
  if (action === 'status') {
    p.note(JSON.stringify(client.updates, null, 2), 'Update-Regeln');
    return doctor(clientRoot);
  }
  if (!['check', 'run'].includes(action))
    throw new Error('updates: enable | disable | configure | check | run | status');
  const result = await busy(
    action === 'check' ? 'Releases prüfen' : 'Updates prüfen und anwenden',
    async () =>
      jsonResult(
        await new Target(client).worker('updates', {
          checkOnly: action === 'check',
          force: action === 'run',
        }),
      ),
  );
  p.note(JSON.stringify(result, null, 2), 'Update-Ergebnis');
}

export async function doctor(clientRoot) {
  const client = await loadClient(clientRoot);
  const result = jsonResult(await new Target(client).worker('doctor'));
  for (const check of result.checks)
    p.log[check.ok ? 'success' : 'warn'](
      `${check.name}: ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`,
    );
  try {
    await waitForClient(client, 5000);
    p.log.success('Lokaler Desktop-Endpunkt erreichbar.');
  } catch (error) {
    p.log.warn(error.message);
  }
  p.note(
    'Nach Änderung der Desktop-Konfiguration: Codex vollständig beenden und neu öffnen.\nBei „model not advertised“ kann auch ein alter Desktop-Hintergrunddienst die Ursache sein.\nMit der zu deiner Desktop-App gehörenden CLI „app-server daemon version“ prüfen.\nEinen fremden oder laufenden Hintergrunddienst ersetzt dieses Setup nicht automatisch.',
    'Desktop / mobile Sitzungen',
  );
  return result;
}

export async function menu(clientRoot) {
  const existing = await readJson(path.join(clientRoot, 'client.json'), null);
  const choice = await select(
    'Codex Multi Auth',
    existing
      ? [
          ...(existing.pending
            ? [{ value: 'resume', label: 'Begonnene Einrichtung fortsetzen' }]
            : []),
          { value: 'stats', label: 'Account-Status' },
          { value: 'add', label: 'Account hinzufügen' },
          { value: 'remove', label: 'Account entfernen' },
          { value: 'configure', label: 'Installation ändern' },
          { value: 'doctor', label: 'Diagnose' },
          { value: 'updates', label: 'Updates prüfen' },
          { value: 'recover', label: 'Unterbrochene Wartung wiederherstellen' },
        ]
      : [
          { value: 'install', label: 'Neu installieren' },
          { value: 'connect', label: 'Vorhandenen SSH-Server verbinden' },
        ],
  );
  if (['stats', 'add', 'remove'].includes(choice)) return accountAction(clientRoot, choice);
  if (choice === 'updates') return updatesAction(clientRoot, 'check');
  return { install, connect, resume, recover, configure, doctor }[choice](clientRoot);
}
