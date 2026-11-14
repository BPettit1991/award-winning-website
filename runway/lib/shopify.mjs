import { readFile } from 'node:fs/promises';
import { sleep } from './util.mjs';

export const REQUIRED_SCOPES = ['read_products', 'write_products', 'read_files', 'write_files', 'read_publications', 'write_publications'];

const PRODUCT_FIELDS = `
  id handle title status tags
  media(first: 30) { nodes { id alt } }
  variants(first: 250) { nodes { id sku selectedOptions { name value } } }`;

/**
 * Minimal Shopify Admin GraphQL client.
 * Auth: a Dev Dashboard app's client ID + secret (client credentials grant, 24h tokens),
 * or a legacy admin-created custom app token passed as `token`.
 */
export function createShopify({ shop, clientId, clientSecret, token, apiVersion, fetch = globalThis.fetch }) {
  if (!shop) throw new Error('SHOPIFY_SHOP is not set (the myshopify.com subdomain, without ".myshopify.com")');
  const base = `https://${shop.replace(/\.myshopify\.com$/, '')}.myshopify.com`;
  let cached = token ? { token, expiresAt: Infinity } : null;

  async function getToken() {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    if (!clientId || !clientSecret) throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN)');
    const res = await fetch(`${base}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  }

  async function gql(query, variables = {}, attempt = 0) {
    const res = await fetch(`${base}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    const throttled = res.status === 429;
    const json = throttled ? {} : await res.json().catch(() => ({}));
    if ((throttled || json.errors?.some((e) => e.extensions?.code === 'THROTTLED')) && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      return gql(query, variables, attempt + 1);
    }
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data;
  }

  /** Throws when a mutation payload carries userErrors. */
  function check(payload, what) {
    if (payload?.userErrors?.length) {
      throw new Error(`${what}: ${payload.userErrors.map((e) => `${(e.field ?? []).join('.')} ${e.message}`.trim()).join('; ')}`);
    }
    return payload;
  }

  return {
    gql,

    async shopInfo() {
      const data = await gql(`{
        shop { name myshopifyDomain currencyCode primaryDomain { host } }
        productsCount { count }
        currentAppInstallation { accessScopes { handle } }
      }`);
      return { ...data.shop, productsCount: data.productsCount.count, scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle) };
    },

    async findProduct(handle) {
      const data = await gql(`query($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { ${PRODUCT_FIELDS} } }`, { handle });
      return data.productByIdentifier;
    },

    /** Creates or updates a product by handle. New products start as DRAFT; status is never changed on update. */
    async upsertProduct(spec, { create }) {
      const input = {
        title: spec.title,
        handle: spec.handle,
        descriptionHtml: spec.descriptionHtml,
        vendor: spec.vendor,
        productType: spec.productType,
        tags: [...spec.tags, `rw-spec-${spec.hash}`],
        ...(spec.seo ? { seo: spec.seo } : {}),
        ...(create ? { status: 'DRAFT' } : {}),
        productOptions: spec.options.map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((name) => ({ name })) })),
        variants: spec.variants.map((v) => ({
          optionValues: [
            ...(spec.multiColor ? [{ optionName: 'Color', name: v.color }] : []),
            { optionName: 'Size', name: v.size },
          ],
          price: v.price,
          sku: v.sku,
          taxable: true,
          // Print on demand: never "out of stock", Shopify does not count units.
          inventoryPolicy: 'CONTINUE',
          inventoryItem: {
            tracked: false,
            requiresShipping: true,
            ...(v.grams ? { measurement: { weight: { value: v.grams, unit: 'GRAMS' } } } : {}),
          },
        })),
      };
      const data = await gql(
        `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
          productSet(synchronous: true, input: $input, identifier: $identifier) {
            product { ${PRODUCT_FIELDS} }
            userErrors { field message code }
          }
        }`,
        { input, identifier: { handle: spec.handle } },
      );
      return check(data.productSet, `productSet ${spec.handle}`).product;
    },

    async addMedia(productId, media) {
      const data = await gql(
        `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) { product { id } userErrors { field message } }
        }`,
        { product: { id: productId }, media: media.map((m) => ({ originalSource: m.url, alt: m.alt, mediaContentType: 'IMAGE' })) },
      );
      check(data.productUpdate, 'productUpdate media');
    },

    async setStatus(productId, status) {
      const data = await gql(
        `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
        { product: { id: productId, status } },
      );
      check(data.productUpdate, 'productUpdate status');
    },

    /** Every product with what the tidy command needs. */
    async listProducts() {
      const all = [];
      for (let after = null; ; ) {
        const data = await gql(
          `query($after: String) {
            products(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id handle title productType tags media(first: 30) { nodes { id alt ... on MediaImage { image { url } } } } }
            }
          }`,
          { after },
        );
        all.push(...data.products.nodes);
        if (!data.products.pageInfo.hasNextPage) return all;
        after = data.products.pageInfo.endCursor;
      }
    },

    async setProductType(productId, productType) {
      const data = await gql(
        `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
        { product: { id: productId, productType } },
      );
      check(data.productUpdate, 'productUpdate productType');
    },

    async addTags(id, tags) {
      const data = await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags });
      check(data.tagsAdd, 'tagsAdd');
    },

    async setAltText(files) {
      const data = await gql(`mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { userErrors { field message } } }`, { files });
      check(data.fileUpdate, 'fileUpdate');
    },

    async onlineStorePublicationId() {
      const data = await gql(`{ publications(first: 50) { nodes { id name } } }`);
      const pub = data.publications.nodes.find((p) => p.name === 'Online Store');
      if (!pub) throw new Error(`No "Online Store" publication found (have: ${data.publications.nodes.map((p) => p.name).join(', ')})`);
      return pub.id;
    },

    async publish(id, publicationId) {
      const data = await gql(
        `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
        { id, input: [{ publicationId }] },
      );
      check(data.publishablePublish, 'publishablePublish');
    },

    /** Smart collection that auto-includes every product carrying `tag`. Returns its ID. */
    async ensureCollection({ handle, title, descriptionHtml, tag }) {
      const found = await gql(`query($handle: String!) { collectionByIdentifier(identifier: { handle: $handle }) { id } }`, { handle });
      if (found.collectionByIdentifier) return { id: found.collectionByIdentifier.id, created: false };
      const data = await gql(
        `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
        { input: { handle, title, descriptionHtml, ruleSet: { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: tag }] } } },
      );
      return { id: check(data.collectionCreate, `collectionCreate ${handle}`).collection.id, created: true };
    },

    /** Uploads a local PNG to Shopify Files (reusing it if already there) and returns its public CDN URL. */
    async uploadArt(path, filename) {
      const fileUrl = async () => {
        const data = await gql(
          `query($q: String!) { files(first: 1, query: $q) { nodes { ... on MediaImage { id fileStatus image { url } } } } }`,
          { q: `filename:${filename.replace(/\.png$/, '')}` },
        );
        return data.files.nodes[0];
      };
      let file = await fileUrl();
      if (!file) {
        const bytes = await readFile(path);
        const staged = await gql(
          `mutation($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
          }`,
          { input: [{ resource: 'IMAGE', filename, mimeType: 'image/png', httpMethod: 'POST', fileSize: String(bytes.length) }] },
        );
        const target = check(staged.stagedUploadsCreate, 'stagedUploadsCreate').stagedTargets[0];
        const form = new FormData();
        for (const p of target.parameters) form.append(p.name, p.value);
        form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
        const up = await fetch(target.url, { method: 'POST', body: form });
        if (!up.ok) throw new Error(`Art upload failed: ${up.status} ${await up.text()}`);
        const created = await gql(
          `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message } } }`,
          { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', filename }] },
        );
        check(created.fileCreate, 'fileCreate');
      }
      for (let i = 0; i < 30; i++) {
        if (file?.fileStatus === 'READY' && file.image?.url) return file.image.url;
        if (file?.fileStatus === 'FAILED') throw new Error(`Shopify could not process ${filename}`);
        await sleep(2000);
        file = await fileUrl();
      }
      throw new Error(`Timed out waiting for Shopify to process ${filename}`);
    },
  };
}
