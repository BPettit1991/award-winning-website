#!/usr/bin/env node
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDrops, validateDrops } from '../lib/manifest.mjs';
import { createShopify } from '../lib/shopify.mjs';
import { createPrintful } from '../lib/printful.mjs';
import { syncDrop, releaseDrop, isDue, doctor, auditCatalogue, planTidy, applyTidy } from '../lib/pipeline.mjs';
import { parseArgs, slugify } from '../lib/util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `runway <command> [drop] [options]

  new <name>            Scaffold drops/<name>/ from the template
  validate [drop]       Check manifests and art files (offline)
  plan [drop]           Show exactly what sync would create (offline)
  sync [drop]           Create draft products, link them in Printful, add mockups
  release [drop]        Publish drops whose release date has arrived (--now ignores the date)
  doctor                Check both connections and that every product is fulfillable
  audit [--file f.json] Storefront hygiene check on the public product feed (no credentials)
  tidy [--apply]        Fix type, tags and image alt text on hand-made products (lists changes unless --apply)

  --relink              Re-send print files to Printful even for variants already linked
`;

function clients(config) {
  const env = process.env;
  return {
    shopify: createShopify({
      shop: env.SHOPIFY_SHOP || config.shop,
      clientId: env.SHOPIFY_CLIENT_ID,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
      token: env.SHOPIFY_ADMIN_TOKEN,
      apiVersion: config.apiVersion,
    }),
    printful: createPrintful({ token: env.PRINTFUL_TOKEN, storeId: env.PRINTFUL_STORE_ID || config.printfulStoreId }),
  };
}

async function validated(config, only) {
  const drops = await loadDrops(ROOT, only);
  const { errors, warnings, specs } = await validateDrops(drops, config);
  for (const w of warnings) console.log(`warn  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  if (errors.length) {
    console.log(`\n${errors.length} error(s). Nothing was sent to Shopify or Printful.`);
    process.exit(1);
  }
  return { drops, specs, warnings };
}

const forDrop = (specs, drop) => specs.filter((s) => s.drop.slug === drop.slug);

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const [command, target] = positionals;
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  const config = await loadConfig(ROOT);

  switch (command) {
    case 'new': {
      if (!target) throw new Error('Usage: runway new <name>');
      const slug = slugify(target);
      const dest = join(ROOT, 'drops', slug);
      if (existsSync(dest)) throw new Error(`drops/${slug} already exists`);
      await cp(join(ROOT, 'drops', '_template'), dest, { recursive: true });
      const manifest = JSON.parse(await readFile(join(dest, 'drop.json'), 'utf8'));
      manifest.collection.title = target;
      await writeFile(join(dest, 'drop.json'), JSON.stringify(manifest, null, 2) + '\n');
      await mkdir(join(dest, 'art'), { recursive: true });
      console.log(`Created drops/${slug}/. Put PNGs in drops/${slug}/art/ and edit drops/${slug}/drop.json.`);
      break;
    }

    case 'validate': {
      const { drops, specs, warnings } = await validated(config, target);
      console.log(`${drops.length} drop(s), ${specs.length} design(s) valid${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
      break;
    }

    case 'plan': {
      const { drops, specs } = await validated(config, target);
      for (const drop of drops) {
        const due = drop.manifest.release
          ? `releases ${drop.manifest.release}${isDue(drop, config) ? ' (due now)' : ''}`
          : 'no release date, manual release';
        console.log(`\n${drop.slug}: collection "${drop.manifest.collection.title}", ${due}`);
        for (const { spec } of forDrop(specs, drop)) {
          const v = spec.variants;
          console.log(`  ${spec.title}`);
          console.log(`    /products/${spec.handle}  ${spec.blank} in ${spec.colors.join(', ')}, ${spec.placement} print, ${v.length} variants (${v[0].size} to ${v.at(-1).size}) at $${v[0].price}`);
          console.log(`    Printful variants ${v[0].printfulVariantId}..${v.at(-1).printfulVariantId}, art: ${spec.art}`);
        }
      }
      break;
    }

    case 'sync': {
      const { drops, specs } = await validated(config, target);
      const ctx = { ...clients(config), config, log: console.log, relink: Boolean(flags.relink) };
      let failed = 0;
      let waiting = 0;
      for (const drop of drops) {
        for (const r of await syncDrop(drop, forDrop(specs, drop), ctx)) {
          if (r.error) {
            failed++;
            console.log(`  FAIL ${r.handle}: ${r.error}`);
            continue;
          }
          if (!r.printfulReady) waiting++;
          console.log(`  ${r.handle} [${r.status}]: Shopify ${r.shopify}; Printful ${r.printful}; mockups ${r.mockups}`);
        }
      }
      if (waiting) {
        console.log(`\n${waiting} design(s) not fully linked in Printful yet. Run sync again later (the scheduled run does this), or press "Refresh data" on the store in Printful to hurry the import.`);
      }
      if (failed) process.exit(1);
      break;
    }

    case 'release': {
      const { drops, specs } = await validated(config, target);
      const due = drops.filter((d) => (flags.now && target ? true : isDue(d, config)));
      if (!due.length) {
        console.log('No drops are due for release.');
        break;
      }
      const ctx = { ...clients(config), config };
      let blocked = 0;
      for (const drop of due) {
        console.log(`${drop.slug}:`);
        for (const r of await releaseDrop(drop, forDrop(specs, drop), ctx)) {
          if (r.blocked) blocked++;
          console.log(`  ${r.handle}: ${r.released ? 'RELEASED, now live' : r.live ? 'already live' : `held back, ${r.blocked}`}`);
        }
      }
      if (blocked) process.exit(2);
      break;
    }

    case 'doctor': {
      const { ok, lines } = await doctor({ ...clients(config), config });
      console.log(lines.join('\n'));
      if (!ok) process.exit(1);
      break;
    }

    case 'tidy': {
      const { shopify } = clients(config);
      const plan = planTidy(await shopify.listProducts(), config);
      for (const c of plan) {
        const parts = [c.productType && `type -> ${c.productType}`, c.addTags.length && `add tags ${c.addTags.join(', ')}`, c.alts.length && `alt text on ${c.alts.length} images`];
        console.log(`  ${c.handle}: ${parts.filter(Boolean).join('; ')}`);
      }
      if (!plan.length) console.log('Nothing to tidy.');
      else if (flags.apply) {
        await applyTidy(plan, shopify);
        console.log(`\nApplied to ${plan.length} product(s).`);
      } else console.log(`\n${plan.length} product(s) would change. Re-run with --apply to make the changes.`);
      break;
    }

    case 'audit': {
      let products;
      let collections = [];
      if (flags.file) {
        products = JSON.parse(await readFile(flags.file, 'utf8')).products;
      } else {
        const get = async (path) => {
          const res = await fetch(`${config.storefront}${path}`);
          if (!res.ok) throw new Error(`${path}: ${res.status}`);
          return res.json();
        };
        products = (await get('/products.json?limit=250')).products;
        collections = (await get('/collections.json?limit=250')).collections;
      }
      const findings = auditCatalogue(products, collections);
      console.log(`${products.length} products checked.`);
      console.log(findings.length ? findings.map((f) => `- ${f}`).join('\n') : 'No issues found.');
      break;
    }

    default:
      console.log(HELP);
      if (command && command !== 'help') process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
