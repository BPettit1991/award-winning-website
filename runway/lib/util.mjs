import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const sha8 = (input) => createHash('sha256').update(input).digest('hex').slice(0, 8);

/** Numeric tail of a Shopify GID, e.g. gid://shopify/Product/123 -> "123". */
export const gidNumber = (gid) => String(gid).split('/').pop().split('?')[0];

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export const todayIn = (timeZone, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Parses `--flag`, `--key value` and positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positionals.push(a);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return { flags, positionals };
}
