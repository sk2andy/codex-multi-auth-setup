import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, shellCommand, shellQuote } from './process.mjs';
import { validHost } from './config.mjs';

export function sshArguments(ssh, { interactive = false, batch = true } = {}) {
  if (!validHost(ssh.host)) throw new Error('Invalid SSH destination');
  if (ssh.port !== undefined && (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535))
    throw new Error('Invalid SSH port');
  for (const option of ['identityFile', 'hostKeyAlias']) {
    if (
      ssh[option] !== undefined &&
      ssh[option] !== null &&
      (typeof ssh[option] !== 'string' || /[\r\n\0]/.test(ssh[option]))
    )
      throw new Error('Invalid SSH option');
  }
  const args = [
    interactive ? '-tt' : '-T',
    '-o',
    `BatchMode=${batch ? 'yes' : 'no'}`,
    '-o',
    `StrictHostKeyChecking=${batch ? 'yes' : 'ask'}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
  ];
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  if (ssh.hostKeyAlias) args.push('-o', `HostKeyAlias=${ssh.hostKeyAlias}`);
  return [...args, '--', ssh.host];
}

export class Target {
  constructor(config, execute = run) {
    this.config = config;
    this.execute = execute;
  }
  async selectedSsh() {
    if (!this.config.ssh.fallbackHost || this.config.ssh.fallbackHost === this.config.ssh.host)
      return this.config.ssh;
    if (!this.routeSelection) {
      this.routeSelection = (async () => {
        for (const host of [this.config.ssh.host, this.config.ssh.fallbackHost]) {
          const ssh = { ...this.config.ssh, host };
          try {
            const probe = await this.execute('ssh', [...sshArguments(ssh), shellCommand('true')], {
              check: false,
              interactive: false,
              timeoutMs: 15000,
              maxOutput: 65536,
            });
            if (probe.code === 0) return ssh;
          } catch {
            /* Only this read-only connectivity probe may try another route. */
          }
        }
        throw new Error('Neither primary nor fallback SSH destination is reachable');
      })();
    }
    return this.routeSelection;
  }
  async verifyFallbackIdentity(ssh) {
    if (ssh.host === this.config.ssh.host) return;
    // Initial onboarding chooses its destination before an installation exists.
    // Public client configurations must prove the persisted installation identity.
    const freshInstall =
      this.config.clientApiKey && this.config.initialized === undefined && !this.config.clientRoot;
    if (freshInstall || (!this.config.installationId && !this.config.clientRoot)) return;
    if (!this.config.installationId || !this.config.root || !this.config.node)
      throw new Error('Fallback management requires a known installation identity');
    const identity = JSON.stringify([ssh.host, this.config.root, this.config.installationId]);
    if (this.verifiedIdentity === identity) return;
    const source =
      'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({installationId:c.installationId}));';
    const result = await this.execute(
      'ssh',
      [
        ...sshArguments(ssh),
        shellCommand(this.config.node, ['-e', source, path.join(this.config.root, 'config.json')]),
      ],
      {
        interactive: false,
        timeoutMs: 15000,
        maxOutput: 65536,
      },
    );
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error('Could not verify fallback installation identity');
    }
    if (report.installationId !== this.config.installationId)
      throw new Error('Fallback points to a different installation; no action was sent');
    this.verifiedIdentity = identity;
  }
  async run(executable, args = [], options = {}) {
    if (this.config.mode === 'local') return this.execute(executable, args, options);
    const { cwd, env, ...transport } = options;
    const ssh = options.batch === false ? this.config.ssh : await this.selectedSsh();
    if (options.batch !== false) await this.verifyFallbackIdentity(ssh);
    // Never retry a real command: a lost SSH response can still mean it completed.
    return this.execute(
      'ssh',
      [...sshArguments(ssh, options), shellCommand(executable, args, { cwd, env })],
      transport,
    );
  }
  async trust() {
    if (this.config.mode === 'ssh') await this.run('true', [], { interactive: true, batch: false });
  }
  async inspect() {
    if (this.config.mode === 'local')
      return {
        platform: process.platform,
        arch: process.arch,
        home: os.homedir(),
        node: process.execPath,
        username: os.userInfo().username,
        uid: process.getuid?.(),
      };
    const source =
      'uname -s\nuname -m\nprintf "%s\\n" "$HOME"\nid -un\nid -u\ncommand -v node || true';
    const { stdout } = await this.run('sh', ['-c', source]);
    const [system, machine, home, username, uid, node] = stdout.trim().split('\n');
    const platform = { Linux: 'linux', Darwin: 'darwin' }[system];
    const arch = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[machine];
    if (!platform || !arch || !home?.startsWith('/'))
      throw new Error('Supported targets: macOS/Linux, x64/ARM64');
    return { platform, arch, home, node: node || null, username, uid: Number(uid) };
  }
  async write(filename, contents, mode = 0o600) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\r\n\0]/.test(filename))
      throw new Error('Target filename must be an absolute path without control characters');
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error('Invalid target file mode');
    await this.run('mkdir', ['-p', '--', path.dirname(filename)]);
    // No data or secrets become shell arguments; input travels on encrypted stdin.
    // Rename replaces an existing symlink itself, never its potentially unrelated target.
    const temporary = `${filename}.setup-${crypto.randomUUID()}.tmp`;
    const script = `set -eu\numask 077\nset -C\n[ ! -d ${shellQuote(filename)} ]\ntrap ${shellQuote(`rm -f -- ${shellQuote(temporary)}`)} EXIT HUP INT TERM\ncat > ${shellQuote(temporary)}\nchmod ${mode.toString(8)} ${shellQuote(temporary)}\nmv -f -- ${shellQuote(temporary)} ${shellQuote(filename)}`;
    await this.run('sh', ['-c', script], { input: contents });
  }
  async read(filename, fallback) {
    const result = await this.run('cat', [filename], { check: false });
    if (result.code === 0) return result.stdout;
    if (fallback !== undefined) return fallback;
    throw new Error(`Cannot read ${filename} on target`);
  }
  async exists(filename) {
    return (await this.run('test', ['-e', filename], { check: false })).code === 0;
  }
  async worker(action, payload = {}, { interactive = false } = {}) {
    // Pools retain their own manager version. Resolve login transport here so an
    // older worker cannot ignore loginMethod and silently force device auth.
    if (action === 'accounts' && payload.command === 'add' && payload.loginMethod) {
      if (!['browser', 'device'].includes(payload.loginMethod))
        throw new Error('Unknown login method');
      payload = {
        ...payload,
        command: 'proxy',
        args: [
          'login',
          ...(payload.loginMethod === 'device' ? ['--device-auth'] : []),
          '--preserve-selection',
          ...(payload.args ?? []),
        ],
      };
    }
    const args = [
      path.join(this.config.appDir, 'src', 'worker.mjs'),
      action,
      '--root',
      this.config.root,
    ];
    if (interactive)
      args.push('--payload', Buffer.from(JSON.stringify(payload)).toString('base64url'));
    return this.run(this.config.node, args, {
      interactive,
      input: interactive ? undefined : JSON.stringify(payload),
      timeoutMs: interactive ? undefined : 20 * 60_000,
      env: {
        PATH: `${path.dirname(this.config.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });
  }
}

export async function ensureNode(target, info, root) {
  if (info.node) {
    const result = await target.run(info.node, ['--version'], { check: false });
    const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.trim());
    if (match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 19)))
      return info.node;
  }
  if (!['linux', 'darwin'].includes(info.platform))
    throw new Error('Install Node >=22.19 on this target first');
  const metadata = await fetch('https://nodejs.org/dist/index.json', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!metadata.ok) throw new Error('Could not discover Node LTS release');
  const releases = await metadata.json();
  const release = releases.find((r) => /^v24\.\d+\.\d+$/.test(r.version) && r.lts);
  if (!release) throw new Error('No Node 24 LTS release found');
  const filename = `node-${release.version}-${info.platform}-${info.arch}.tar.gz`;
  const base = `https://nodejs.org/dist/${release.version}`;
  const sums = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
  if (!sums.ok) throw new Error('Node checksum download failed');
  const digest = (await sums.text())
    .split('\n')
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Missing Node checksum');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-setup-node-'));
  try {
    const local = path.join(temporary, filename);
    await run(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--max-time',
        '300',
        '--max-filesize',
        '200000000',
        '-o',
        local,
        `${base}/${filename}`,
      ],
      { timeoutMs: 310_000 },
    );
    const bytes = await fs.readFile(local);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('Node checksum mismatch');
    const directory = path.join(root, 'node', release.version);
    const archive = path.join(root, `.node-${crypto.randomUUID()}.tar.gz`);
    await target.write(archive, bytes);
    try {
      await target.run('mkdir', ['-p', directory]);
      await target.run('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
      const executable = path.join(directory, 'bin', 'node');
      const result = await target.run(executable, ['--version']);
      if (result.stdout.trim() !== release.version)
        throw new Error('Installed Node reports unexpected version');
      return executable;
    } finally {
      await target.run('rm', ['-f', archive]);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
