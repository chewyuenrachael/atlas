/**
 * String + email normalization helpers shared by signal extractors and
 * candidate lookup.
 *
 * All "is this the same X?" comparisons in the resolver normalize first.
 * Centralising the rules here keeps signals consistent: a "name exact" match
 * on the resolver side uses the same transformation as the candidate lookup
 * trigram index would, modulo what Postgres applies natively.
 *
 * Spec ref: SPEC.md §4.2 (name_exact, name_fuzzy, email_*).
 */

/**
 * Canonicalise a name for comparison.
 *
 * Lowercases, trims, collapses internal whitespace, and strips diacritics
 * (NFD → drop combining marks). Returns an empty string for nullish/blank
 * inputs so callers can compare safely without special-casing.
 *
 * @example
 * ```ts
 * normalizeName('  Álvaro  García ') === 'alvaro garcia';
 * ```
 */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  // NFD splits combining marks off base letters so we can drop them.
  const stripped = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return stripped.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalise an email for comparison: lowercase and trim. We deliberately do
 * NOT strip dots from gmail-style local parts — different providers treat
 * them differently and the SPEC counts exact-match by the address as the
 * source observed it.
 *
 * @example
 * ```ts
 * normalizeEmail(' Alice@Example.COM ') === 'alice@example.com';
 * ```
 */
export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return '';
  return input.toLowerCase().trim();
}

/**
 * Extract the domain part of an email address. Returns the empty string if
 * the input has no `@` or is empty.
 *
 * @example
 * ```ts
 * emailDomain('alice@example.com') === 'example.com';
 * ```
 */
export function emailDomain(email: string | null | undefined): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return '';
  return normalized.slice(at + 1);
}

/**
 * Domains that are personal-mail providers. Sharing one of these is *not*
 * meaningful for employer-style "email_domain" inference. Kept short on
 * purpose — the resolver errs on the side of skipping rather than false
 * positives. TODO(spec): externalize to constants once the list grows.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.jp',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'fastmail.com',
  'zoho.com',
  'gmx.com',
  'gmx.de',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'mail.ru',
]);

/** True when the domain corresponds to a consumer/free-mail provider. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** Lowercase + trim a platform handle. */
export function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return '';
  return handle.toLowerCase().trim().replace(/^@/, '');
}
