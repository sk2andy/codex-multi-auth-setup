import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, formatUsage } from '../src/usage.mjs';

test('bank resets retain exact expirations independently of purchased credits and hide opaque identifiers', () => {
  const now = Date.UTC(2030, 0, 1);
  const expires = Math.floor(now / 1000) + 3600;
  const report = summarizeUsage(
    {
      accountId: 'private-workspace',
      accessToken: 'private-token',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 20, resetsAt: expires },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [
          {
            id: 'private-credit-id',
            status: 'available',
            expiresAt: expires,
            grantedAt: expires - 3600,
            title: 'Bank reset',
          },
          {
            id: 'second-private-id',
            status: 'available',
            expiresAt: null,
            grantedAt: expires - 3600,
          },
        ],
      },
    },
    1,
    now,
  );
  assert.equal(report.bankResets.availableCount, 2);
  assert.equal(report.bankResets.earliestKnownExpiry, expires);
  assert.equal(report.bankResets.details[1].expiresAt, null);
  assert.equal(report.bankResets.detailsComplete, true);
  assert.ok(!JSON.stringify(report).includes('private-'));
  const display = formatUsage({ accounts: [report] }, { timeZone: 'UTC' });
  assert.match(display, /Bank Resets: 2 verfügbar/);
  assert.match(display, /01:00:00/);
  assert.match(display, /ohne Ablaufdatum/);
  assert.match(display, /Guthaben-Credits \(separat\): 0/);
});

test('unknown, zero and truncated bank-reset details remain distinct', () => {
  const summarize = (rateLimitResetCredits) =>
    summarizeUsage({ rateLimits: {}, rateLimitResetCredits }, 1);
  assert.equal(summarize(null).bankResets.availableCount, null);
  assert.equal(summarize({ availableCount: 0, credits: [] }).bankResets.detailsComplete, true);
  assert.equal(summarize({ availableCount: 3, credits: null }).bankResets.details, null);
  const partial = summarize({
    availableCount: 3,
    credits: [{ status: 'available', expiresAt: 100 }],
  });
  assert.equal(partial.bankResets.detailsComplete, false);
  assert.equal(partial.bankResets.earliestKnownExpiry, null);
  assert.match(formatUsage({ accounts: [partial] }, { timeZone: 'UTC' }), /unvollständig/);
});

test('malformed expiry never becomes an unexpiring credit and terminal controls are stripped', () => {
  const report = summarizeUsage(
    {
      rateLimits: { planType: 'pro\nunsafe' },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ status: 'available', expiresAt: 'invalid', title: 'line\nnext\x1b[31m' }],
      },
    },
    1,
  );
  assert.equal(report.bankResets.details[0].expiryKnown, false);
  assert.match(formatUsage({ accounts: [report] }), /Ablauf unbekannt/);
  assert.ok(!JSON.stringify(report).includes('\\u001b'));
});

test('native usage reader requests details using only the read RPC and rejects mismatched account identity', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readPoolUsage } = await import('../src/usage-reader.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-readonly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lib = path.join(root, 'current-proxy', 'dist', 'lib');
  await fs.mkdir(path.join(lib, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(lib, 'storage'), { recursive: true });
  await fs.mkdir(path.join(lib, 'auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const files = {
    'accounts.js': `export class AccountManager {getAccountsSnapshot(){return [{index:0,accountId:'a'},{index:1,accountId:'b'}]} async flushPendingSave(){}}`,
    'storage.js': `export async function loadAccounts(){return {accounts:[]}}`,
    'storage/path-state.js': `export async function runWithGlobalStoragePath(fn){return fn()}`,
    'runtime/rotation-token-refresh.js': `export async function ensureFreshAccessToken({account}){return {ok:true,accessToken:'private-token',account:{...account,expires:Date.now()+3600000}}}`,
    'auth/token-utils.js': `export function codexCliAccountIdFor(auth){return auth.accountId}`,
    'runtime/native-rate-limits.js': `export function resolveNativeUsageCommand(){return ['unused']} export async function nativeRateLimitsRpc(auth,method,params){if(method!=='account/rateLimits/read'||params.excludeResetCreditDetails!==false)throw Error('Forbidden mutation or missing details'); return {accountId:auth.accountId==='a'?'a':'wrong',rateLimits:{},rateLimitResetCredits:{availableCount:1,credits:[{id:'private-credit-id',status:'available',expiresAt:1900000000}]}}}`,
  };
  for (const [name, source] of Object.entries(files))
    await fs.writeFile(path.join(lib, name), source);
  const report = await readPoolUsage(root);
  assert.equal(report.readOnly, true);
  assert.equal(report.accounts[0].bankResets.availableCount, 1);
  assert.equal(report.accounts[0].bankResets.details[0].expiresAt, 1900000000);
  assert.equal(report.accounts[1].error, 'usage_unavailable');
  assert.ok(!JSON.stringify(report).includes('private-'));
});
