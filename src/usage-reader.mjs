import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeUsage } from './usage.mjs';

// Runs as a bounded child under managementEnvironment while the selected pool
// is paused by the worker. Only the read RPC is reachable, never consume/redeem.
export async function readPoolUsage(root) {
  const module = (name) =>
    import(pathToFileURL(path.join(root, 'current-proxy', 'dist', 'lib', name)));
  const [
    { AccountManager },
    { loadAccounts },
    { runWithGlobalStoragePath },
    { ensureFreshAccessToken },
    { nativeRateLimitsRpc, resolveNativeUsageCommand },
    { codexCliAccountIdFor },
  ] = await Promise.all([
    module('accounts.js'),
    module('storage.js'),
    module('storage/path-state.js'),
    module('runtime/rotation-token-refresh.js'),
    module('runtime/native-rate-limits.js'),
    module('auth/token-utils.js'),
  ]);
  const desktop =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const command =
    process.platform === 'darwin' &&
    (await fs.access(desktop).then(
      () => true,
      () => false,
    ))
      ? [desktop]
      : resolveNativeUsageCommand();
  return runWithGlobalStoragePath(async () => {
    const storage = await loadAccounts();
    const manager = new AccountManager(undefined, storage);
    const accounts = [];
    try {
      for (const account of manager.getAccountsSnapshot()) {
        try {
          if (account.enabled === false) throw Error('Disabled');
          const fresh = await ensureFreshAccessToken({
            accountManager: manager,
            account,
            family: 'codex',
            model: null,
            now: Date.now(),
            tokenRefreshSkewMs: 60000,
            tokenInvalidationCooldownMs: 300000,
          });
          if (!fresh.ok) throw Error('Authentication unavailable');
          const auth = {
            accessToken: fresh.accessToken,
            accountId: fresh.account.accountId,
            expiresAt: fresh.account.expires ?? 0,
            codexCliMirror: fresh.account.codexCliMirror,
          };
          const reply = await nativeRateLimitsRpc(
            auth,
            'account/rateLimits/read',
            { excludeResetCreditDetails: false },
            { command, tempRoot: path.join(root, 'data', 'multi-auth', 'tmp') },
          );
          const sent = codexCliAccountIdFor(auth, auth.accessToken) ?? auth.accountId;
          if (reply.accountId !== sent) throw Error('Usage account identity mismatch');
          accounts.push(summarizeUsage(reply, account.index + 1));
        } catch {
          accounts.push({ accountNumber: account.index + 1, error: 'usage_unavailable' });
        }
      }
    } finally {
      await manager.flushPendingSave();
    }
    return { checkedAt: new Date().toISOString(), readOnly: true, accounts };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  readPoolUsage(process.argv[2])
    .then((report) => process.stdout.write(JSON.stringify(report) + '\n'))
    .catch(() => {
      process.stderr.write(
        'Native usage reader unavailable for this proxy version. No reset was requested.\n',
      );
      process.exitCode = 1;
    });
}
