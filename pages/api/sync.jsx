import { createClient } from "@sanity/client";
import { createStorefrontApiClient } from '@shopify/storefront-api-client';

// Document type for all incoming synced Shopify products
const SHOPIFY_PRODUCT_DOCUMENT_TYPE = "product";
const SHOPIFY_COLLECTION_DOCUMENT_TYPE = 'collection';

// Enter your Sanity studio details here.
const sanityClient = createClient({
  apiVersion: "2021-10-21",
  dataset: process.env.SANITY_DATASET,
  projectId: process.env.SANITY_PROJECT_ID,
  token: process.env.SANITY_ADMIN_AUTH_TOKEN,
  useCdn: false,
});

const shopifyClient = createStorefrontApiClient({
  apiVersion: '2024-07',
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  publicAccessToken: process.env.SHOPIFY_PUBLIC_ACCESS_TOKEN,
});

/**
 * Sanity Connect sends POST requests and expects both:
 * - a 200 status code
 * - a response header with `content-type: application/json`
 *
 * Remember that this may be run in batches when manually syncing.
 */
export default async function handler(req, res) {
  const { body, method } = req;

  /**
   if (method === 'GET') {
    try {
      const products = await sanityClient.fetch(`*[_type == $type]`, {
        type: SHOPIFY_PRODUCT_DOCUMENT_TYPE,
      });
      const collections = await sanityClient.fetch(`*[_type == $type]`, {
        type: SHOPIFY_COLLECTION_DOCUMENT_TYPE,
      });
      return res.status(200).json({ products, collections });
    } catch (err) {
      console.error('Fetch failed: ', err.message);
      return res.status(500).json({ error: 'Failed to fetch data', details: err.message });
    }
  }
  */

  if (method !== "POST") {
    return res.status(405).json({ error: 'Method not allowed', data: { status: 405 } });
  }

  try {
    const transaction = sanityClient.transaction();

    if (["create", "update", "sync"].includes(body.action)) {
      const [productData, collectionData] = await Promise.all([
        fetchData(body.products, buildProductDocument),
        fetchData(body.collections, buildCollectionDocument)
      ]);

      await Promise.all([
        createOrUpdateDocuments(transaction, productData),
        createOrUpdateDocuments(transaction, collectionData)
      ]);
    } else if (body.action === "delete") {
      const productDocumentIds = body.productIds.map(id => getDocumentID(extractID(id)));
      const collectionDocumentIds = body.collectionIds.map(id => getDocumentID(extractID(id)));

      await Promise.all([
        deleteDocuments(transaction, productDocumentIds),
        deleteDocuments(transaction, collectionDocumentIds)
      ]);
    } else {
      return res.status(400).json({ error: 'Invalid action', data: { status: 400 } });
    }

    await transaction.commit();
    res.status(200).json({ message: "OK" });
  } catch (err) {
    console.error("Transaction failed: ", err.message);
    res.status(500).json({ error: 'Transaction failed', details: err.message });
  }
}

/**
 * Fetch all necessary data from Shopify before starting the transaction.
 */
async function fetchData(items, buildDocumentFunction) {
  const data = [];
  for (const item of items) {
    const document = await buildDocumentFunction(item);
    data.push(document);
  }
  return data;
}

/**
 * Creates (or updates if already existing) Sanity documents of type `product`.
 * Patches existing drafts too, if present.
 */
async function createOrUpdateDocuments(transaction, data) {
  const draftDocumentIds = data.map(data => `drafts.${getDocumentID(extractID(data.id))}`);
  const existingDrafts = await sanityClient.fetch(`*[_id in $ids]._id`, {
    ids: draftDocumentIds,
  });

  for (const document of data) {
    const draftId = `drafts.${document._id}`;

    transaction
      .createIfNotExists(document)
      .patch(document._id, (patch) => patch.set(document));

    if (existingDrafts.includes(draftId)) {
      transaction.patch(draftId, (patch) =>
        patch.set({
          ...document,
          _id: draftId,
        })
      );
    }
  }
}

/**
 * Delete corresponding Sanity documents of type `product`.
 * Published and draft documents will be deleted.
 */
async function deleteDocuments(transaction, ids) {
  ids.forEach(id => {
    transaction.delete(id).delete(`drafts.${id}`);
  });
}

/**
 * Build Sanity document from product payload
 */
async function buildProductDocument(data) {
  const {
    id,
    priceRange,
    productType,
    handle,
    status,
    tags,
    title,
    featuredImage,
    images,
    variants,
    options,
    descriptionHtml,
    vendor,
  } = data;

  const namespaces = ["custom_namespaces_1", "custom_namespaces_2", "custom_namespaces_3"];
  const keys = ["custom_keys_1", "custom_keys_2", "custom_keys_3"];

  function createQueryMetafields(key, namespace) {
    return `
      query data($id: ID!) {
        product(id: $id) {
          metafield(key: "${key}", namespace: "${namespace}") {
            value
            key
          }
        }
      }
    `;
  }

  const createQuerySeo = `
    query data($id: ID!) {
      product(id: $id) {
        seo {
          description
          title
        }
      }
    }
  `;

  const metafieldsQueries = keys.map((key, index) => {
    const namespace = namespaces[index % namespaces.length];
    return createQueryMetafields(key, namespace);
  });

  async function fetchMetafields() {
    const responses = await Promise.all(
      metafieldsQueries.map(query =>
        shopifyClient.request(query, { variables: { id } })
      )
    );

    const metafieldsMap = {};
    responses.forEach(response => {
      const metafield = response.data.product.metafield;
      if (metafield) {
        metafieldsMap[metafield.key] = metafield.value;
      }
    });

    return metafieldsMap;
  }

  const [metafieldsMap, seoData] = await Promise.all([
    fetchMetafields(),
    shopifyClient.request(createQuerySeo, { variables: { id } })
  ]);

  const seo = seoData.data.product.seo;

  const productId = extractID(id);

  return {
    _id: getDocumentID(productId),
    _type: SHOPIFY_PRODUCT_DOCUMENT_TYPE,
    store: {
      id: productId,
      gid: id,
      priceRange,
      productType,
      slug: {
        current: handle
      },
      status,
      tags: tags?.join(', '),
      title,
      previewImageUrl: featuredImage?.src,
      images: images?.map((image, index) => ({
        _key: String(index),
        position: String(index + 1),
        src: image.src,
        variant_ids: image.variant_ids
      })),
      variants: variants?.map((variant, index) => {
        const variantId = extractID(variant.id);
        return {
          _key: String(index),
          compareAtPrice: Number(variant.compareAtPrice || 0),
          id: variantId,
          gid:variant.id,
          inStock: !!variant.inventoryManagement
            ? variant.inventoryPolicy === "continue" ||
              variant.inventoryQuantity > 0
            : true,
          barcode: variant.barcode,
          product: variant.product,
          position: variant.position,
          inventoryManagement: variant.inventoryManagement,
          inventoryPolicy: variant.inventoryPolicy,
          selectedOptions: variant.selectedOptions,
          price_currency: variant.price_currency,
          price: Number(variant.price || 0),
          sku: variant.sku,
          title: variant.title,
        };
      }),
      options: options?.map((option, index) => ({
        _key: String(index),
        name: option.name,
        values: option.values,
      })),
      descriptionHtml,
      vendor
    },
    metafields: metafieldsMap,
    seo
  };
}

/**
 * Build Sanity document from collection payload
 */
async function buildCollectionDocument(data) {
  const { id } = data;

  const collectiontId = extractID(id);

  return {
    _id: getDocumentID(collectiontId),
    _type: SHOPIFY_COLLECTION_DOCUMENT_TYPE,
    store: data
  };
}

/**
 * Extract ID from Shopify GID string (all values after the last slash)
 * e.g. gid://shopify/Product/12345 => 12345
 */
function extractID(gid) {
  return gid?.match(/[^\/]+$/i)[0];
}

/**
 * Map Shopify product ID number to a corresponding Sanity document ID string
 * e.g. 12345 => product-12345
 */
function getDocumentID(id) {
  return `${id}`;
}
