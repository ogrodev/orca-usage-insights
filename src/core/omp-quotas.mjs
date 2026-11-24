import { ompProviderName } from './provider-names.mjs';
import { ompAccount } from './records.mjs';

export function summarizeQuotas(results) {
  const accounts = [];
  const labels = new Map();
  const errors = [];
  const seen = new Set();
  for (const { profile, data, error } of results) {
    if (error) {
      errors.push({ profile, message: String(error) });
      continue;
    }
    for (const report of Array.isArray(data?.reports) ? data.reports : []) {
      const provider = nonEmpty(report?.provider);
      if (!provider) continue;
      const meta = isObject(report.metadata) ? report.metadata : {};
      const credentialId = Number.isSafeInteger(meta.credentialId) ? meta.credentialId : null;
      const name = nonEmpty(meta.email) ?? nonEmpty(meta.orgName) ?? nonEmpty(meta.accountId);
      const label = `${ompProviderName(provider)} · ${name ?? `${profile} #${credentialId ?? '?'}`}`;
      if (credentialId !== null) labels.set(ompAccount(profile, provider, credentialId), label);
      const identity = name ? `${provider}|${nonEmpty(meta.accountId) ?? ''}|${name}` : `${provider}|${profile}|${credentialId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      accounts.push({
        provider,
        providerName: ompProviderName(provider),
        label,
        name: name ?? null,
        profile,
        plan: nonEmpty(meta.planType) ?? nonEmpty(meta.subscriptionPlan) ?? null,
        resetsBanked: count(report.resetCredits?.availableCount),
        limits: (Array.isArray(report.limits) ? report.limits : []).filter((limit) => isObject(limit?.amount)).map((limit) => ({
          label: nonEmpty(limit.label) ?? nonEmpty(limit.window?.label) ?? 'Limit',
          usedFraction: fraction(limit.amount.usedFraction),
          resetsAt: Number.isFinite(limit.window?.resetsAt) ? limit.window.resetsAt : null,
          unit: nonEmpty(limit.amount.unit) ?? 'percent',
          status: nonEmpty(limit.status) ?? 'ok',
        })),
        notes: (Array.isArray(report.notes) ? report.notes : []).filter((note) => typeof note === 'string'),
      });
    }
  }
  return { accounts, labels, errors };
}

function fraction(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
