import http from 'node:http';
import { inspectVersions } from './doctor.mjs';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = 'codex-multi-auth-setup';

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function authorized(req, key) {
  const supplied = req.headers['x-api-key'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) throw new Error('Control request too large');
  }
  return JSON.parse(data);
}

async function probe(config) {
  const checks = await inspectVersions(config);
  const daemon = checks.find((check) => check.name === 'Native Codex daemon')?.detail;
  const version = daemon?.runningVersion || daemon?.selectedVersion;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Model catalog probe requires a detectable native Codex version');
  const { router: port } = config.ports;
  const key = config.clientApiKey;
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/models?client_version=${encodeURIComponent(version)}`,
        headers: { 'x-api-key': key },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 2 * 1024 * 1024) req.destroy(new Error('Router catalog too large'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(`Router probe returned ${res.statusCode}`));
          try {
            const catalog = JSON.parse(data);
            const models = (catalog.data || catalog.models || [])
              .map((model) => model.id || model.slug)
              .filter(Boolean);
            resolve({ ok: true, modelCount: models.length, models });
          } catch {
            reject(new Error('Invalid router catalog'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Router probe timed out')));
    req.on('error', reject);
    const deadline = setTimeout(() => req.destroy(new Error('Router probe timed out')), 30000);
    req.once('close', () => clearTimeout(deadline));
  });
}

async function routerReady(port, key) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/__setup_router_ready__',
        headers: { 'x-api-key': key },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode === 404 ? resolve() : reject(new Error('Router readiness check failed')),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Router readiness timed out')));
    req.on('error', reject);
  });
}

export async function startServer(config) {
  if (
    !path.isAbsolute(config.root) ||
    typeof config.clientApiKey !== 'string' ||
    config.clientApiKey.length < 16
  ) {
    throw new Error('An absolute root and a private client API key are required');
  }
  for (const name of ['router', 'gateway']) {
    if (
      !Number.isInteger(config.ports[name]) ||
      config.ports[name] < 1 ||
      config.ports[name] > 65535
    )
      throw new Error(`Invalid ${name} port`);
  }
  if (config.ports.router === config.ports.gateway)
    throw new Error('Router and gateway ports must differ');
  const root = config.root;
  const maintenance = () => existsSync(path.join(root, 'maintenance.lock'));
  await mkdir(path.join(root, 'data', 'codex'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'data', 'multi-auth'), { recursive: true, mode: 0o700 });
  let child;
  let ready = false;
  let closing = false;
  let reloading = false;
  let paused = false;
  let activeRequests = 0;
  let restartTimer;
  let closePromise;
  const sockets = new Set();
  const upstreamRequests = new Set();
  const status = () => ({
    activeRequests,
    ready,
    maintenance: maintenance(),
    pid: child?.pid ?? null,
  });

  async function stopChild() {
    ready = false;
    const previous = child;
    child = undefined;
    if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => previous.kill('SIGKILL'), 5000);
      previous.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      previous.kill('SIGTERM');
    });
  }

  async function launchChild() {
    ready = false;
    const statePath = path.join(root, 'router-state.json');
    const statusPath = path.join(root, 'router-status.json');
    const logPath = path.join(root, 'router.log');
    const state = {
      version: 1,
      nativeOpenai: true,
      host: '127.0.0.1',
      port: config.ports.router,
      clientApiKey: config.clientApiKey,
      statusPath,
      logPath,
    };
    await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
    await rm(statusPath, { force: true });
    const log = await open(path.join(root, 'runtime-child.log'), 'a', 0o600);
    let current;
    try {
      if (closing || paused) throw new Error('Router startup cancelled');
      current = spawn(
        config.node || process.execPath,
        [
          path.join(root, 'current-proxy', 'scripts', 'codex-app-router.js'),
          '--state',
          statePath,
          '--status',
          statusPath,
          '--log',
          logPath,
        ],
        {
          env: {
            ...process.env,
            CODEX_HOME: path.join(root, 'data', 'codex'),
            CODEX_MULTI_AUTH_DIR: path.join(root, 'data', 'multi-auth'),
            CODEX_AUTH_SCHEDULING_STRATEGY: config.strategy,
            CODEX_MULTI_AUTH_APP_BIND: '0',
            CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: '0',
            CODEX_MULTI_AUTH_SYNC_CODEX_CLI: '0',
            CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE: '0',
          },
          stdio: ['ignore', log.fd, log.fd],
        },
      );
    } finally {
      await log.close();
    }
    child = current;
    let failed;
    current.once('error', (error) => {
      failed = error;
    });
    current.once('close', () => {
      if (child !== current) return;
      child = undefined;
      ready = false;
      if (!closing && !reloading && !paused) scheduleRestart();
    });
    const deadline = Date.now() + 20000;
    while (!closing && child === current && !failed && Date.now() < deadline) {
      try {
        // Check the child-owned status as well as HTTP to reject an unrelated port owner.
        const report = JSON.parse(await readFile(statusPath, 'utf8'));
        if (report.pid === current.pid && report.state === 'running') {
          await routerReady(config.ports.router, config.clientApiKey);
          if (child === current) {
            ready = true;
            return;
          }
        }
      } catch {
        /* Child may still be starting. */
      }
      await sleep(100);
    }
    await stopChild();
    throw new Error(failed ? 'Router process failed to start' : 'Router did not become ready');
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (closing || reloading || paused || child) return;
      launchChild().catch(() => {
        if (!closing && !reloading && !paused && !child) scheduleRestart();
      });
    }, 1000);
  }

  async function drain(timeoutMs = 30000) {
    const deadline = Date.now() + Math.min(120000, Math.max(0, Number(timeoutMs) || 0));
    while (activeRequests && Date.now() < deadline && !closing) await sleep(25);
    return activeRequests === 0;
  }

  const server = http.createServer(async (req, res) => {
    let hostname;
    try {
      hostname = new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase();
    } catch {
      /* Invalid Host is rejected below. */
    }
    if (
      req.headers.origin !== undefined ||
      !['localhost', '127.0.0.1', '[::1]'].includes(hostname)
    ) {
      return json(res, 403, { error: 'Only native loopback clients are accepted' });
    }
    const pathname = req.url?.split('?')[0];
    if (pathname === '/__setup_health' && req.method === 'GET') {
      return json(res, ready ? 200 : 503, {
        service: marker,
        ready,
        maintenance: maintenance(),
        installationId: config.installationId,
      });
    }
    if (pathname === '/__setup_control') {
      if (!authorized(req, config.clientApiKey)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      try {
        const request = await body(req);
        if (request.action === 'status') return json(res, 200, status());
        if (request.action === 'drain') {
          if (!maintenance()) return json(res, 409, { error: 'Maintenance lock required' });
          return json(res, (await drain(request.timeoutMs ?? 30000)) ? 200 : 409, status());
        }
        if (request.action === 'probe') {
          return json(res, 200, await probe(config));
        }
        if (request.action === 'pause') {
          if (!maintenance() || reloading)
            return json(res, 409, {
              error: 'Maintenance lock required; another operation may be running',
            });
          reloading = true;
          try {
            if (!(await drain(request.timeoutMs ?? 30000)))
              return json(res, 409, { error: 'Active requests did not drain' });
            paused = true;
            clearTimeout(restartTimer);
            await stopChild();
            return json(res, 200, status());
          } finally {
            reloading = false;
          }
        }
        if (request.action !== 'reload') return json(res, 400, { error: 'Unknown action' });
        if (!maintenance() || activeRequests || reloading)
          return json(res, 409, { error: 'Idle maintenance required' });
        reloading = true;
        clearTimeout(restartTimer);
        try {
          await stopChild();
          // Strategy updates are applied to the next child without exposing credentials.
          try {
            const updated = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
            if (['sequential', 'hybrid'].includes(updated.strategy))
              config.strategy = updated.strategy;
          } catch {
            /* Initial setup may not yet have persisted its configuration. */
          }
          paused = false;
          await launchChild();
          return json(res, 200, status());
        } finally {
          reloading = false;
        }
      } catch (error) {
        const safeMessage =
          /^(Router probe returned \d{3}|Invalid router catalog|Router probe timed out|Model catalog probe requires a detectable native Codex version)$/.test(
            error.message,
          )
            ? error.message
            : 'Control operation failed';
        return json(res, 500, { error: safeMessage });
      }
    }
    if (maintenance() || !ready || closing)
      return json(res, 503, { error: 'Service temporarily unavailable' });
    activeRequests++;
    let settled = false;
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: config.ports.router,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${config.ports.router}`,
          'x-api-key': config.clientApiKey,
        },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      },
    );
    upstreamRequests.add(upstream);
    const finish = () => {
      if (settled) return;
      settled = true;
      activeRequests--;
      upstreamRequests.delete(upstream);
      upstream.destroy();
    };
    res.once('close', finish);
    res.once('finish', finish);
    req.once('aborted', () => {
      upstream.destroy();
      res.destroy();
    });
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'Router unavailable' });
      else res.destroy();
    });
    req.pipe(upstream);
  });
  server.requestTimeout = 0;
  server.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      ready = false;
      clearTimeout(restartTimer);
      const stopped = new Promise((resolve) => server.close(resolve));
      const deadline = Date.now() + 5000;
      while (activeRequests && Date.now() < deadline) await sleep(25);
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await stopChild();
      await stopped;
    })();
    return closePromise;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.ports.gateway, '127.0.0.1', resolve);
    });
    await launchChild();
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--root');
  let runtime;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      stopping = true;
      if (runtime) runtime.close().then(() => process.exit(0));
    });
  try {
    if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: runtime.mjs --root ROOT');
    const config = JSON.parse(
      await readFile(path.join(process.argv[index + 1], 'config.json'), 'utf8'),
    );
    runtime = await startServer(config);
    if (stopping) await runtime.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
