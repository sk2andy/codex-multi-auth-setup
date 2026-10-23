const text = (value) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 240) : null;
const timestamp = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000 ? value : null;
const percent = (value) => (Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
const window = (value) =>
  value
    ? {
        usedPercent: percent(value.usedPercent),
        resetsAt: timestamp(value.resetsAt),
        windowMinutes: Number.isFinite(value.windowDurationMins) ? value.windowDurationMins : null,
      }
    : null;
const quota = (value) => ({
  name: text(value?.limitName),
  primary: window(value?.primary),
  secondary: window(value?.secondary),
});

// Allowlisted display data only: opaque credit IDs, account IDs and tokens never
// leave the reader. This module has no redemption or selection operation.
export function summarizeUsage(reply, accountNumber, now = Date.now()) {
  const summary = reply.rateLimitResetCredits;
  const count =
    Number.isSafeInteger(summary?.availableCount) && summary.availableCount >= 0
      ? summary.availableCount
      : null;
  const details = Array.isArray(summary?.credits)
    ? summary.credits.map((row) => ({
        title: text(row.title),
        status: ['available', 'redeeming', 'redeemed', 'unknown'].includes(row.status)
          ? row.status
          : 'unknown',
        grantedAt: timestamp(row.grantedAt),
        expiresAt: timestamp(row.expiresAt),
        expiryKnown: row.expiresAt === null || timestamp(row.expiresAt) !== null,
        resetType: text(row.resetType),
      }))
    : null;
  const expirations = (details ?? [])
    .filter(
      (row) => row.status === 'available' && row.expiresAt !== null && row.expiresAt * 1000 > now,
    )
    .map((row) => row.expiresAt);
  return {
    accountNumber,
    planType: text(reply.rateLimits?.planType),
    ordinaryUsageAllowed:
      typeof reply.ordinaryUsageAllowed === 'boolean' ? reply.ordinaryUsageAllowed : null,
    quota: quota(reply.rateLimits),
    buckets: Object.fromEntries(
      Object.entries(reply.rateLimitsByLimitId ?? {}).map(([key, value]) => [
        text(key),
        quota(value),
      ]),
    ),
    purchasedCredits: reply.rateLimits?.credits
      ? {
          hasCredits: reply.rateLimits.credits.hasCredits === true,
          unlimited: reply.rateLimits.credits.unlimited === true,
          balance: text(reply.rateLimits.credits.balance),
        }
      : null,
    bankResets: {
      availableCount: count,
      details,
      detailsComplete:
        details !== null &&
        count !== null &&
        details.filter((row) => row.status === 'available').length === count,
      earliestKnownExpiry: expirations.length ? Math.min(...expirations) : null,
    },
  };
}

export function formatUsage(
  report,
  { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {},
) {
  const date = (seconds) =>
    new Intl.DateTimeFormat('de-DE', { timeZone, dateStyle: 'medium', timeStyle: 'long' }).format(
      new Date(seconds * 1000),
    );
  const lines = [`Usage · ${timeZone} · nur lesend`];
  for (const account of report.accounts) {
    lines.push(
      `Account ${account.accountNumber}${account.planType ? ` (${account.planType})` : ''}`,
    );
    if (account.error) {
      lines.push('  Usage nicht verfügbar; Anzahl und Ablaufzeiten unbekannt.');
      continue;
    }
    for (const [name, w] of [
      ['Primär', account.quota.primary],
      ['Sekundär', account.quota.secondary],
    ])
      if (w)
        lines.push(
          `  ${name}: ${w.usedPercent === null ? 'unbekannt' : `${100 - w.usedPercent} % übrig`}; Reset ${w.resetsAt === null ? 'unbekannt' : date(w.resetsAt)}`,
        );
    lines.push(`  Bank Resets: ${account.bankResets.availableCount ?? 'unbekannt'} verfügbar`);
    if (account.bankResets.details === null)
      lines.push('  Ablaufdetails nicht verfügbar (nicht mit 0 gleichsetzen).');
    else {
      for (const [index, row] of account.bankResets.details.entries())
        lines.push(
          `  Bank Reset ${index + 1}: ${row.status}; ${row.expiryKnown ? (row.expiresAt === null ? 'ohne Ablaufdatum' : `gültig bis ${date(row.expiresAt)}`) : 'Ablauf unbekannt'}${row.title ? ` · ${row.title}` : ''}`,
        );
      if (!account.bankResets.detailsComplete)
        lines.push('  Detail-Liste unvollständig; Gesamtzahl separat beachten.');
    }
    const purchased = account.purchasedCredits;
    lines.push(
      `  Guthaben-Credits (separat): ${!purchased ? 'unbekannt' : purchased.unlimited ? 'unbegrenzt' : (purchased.balance ?? (purchased.hasCredits ? 'vorhanden' : 'keine'))}`,
    );
  }
  return lines.join('\n') + '\n';
}
