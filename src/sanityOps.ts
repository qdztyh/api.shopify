import {IdentifiedSanityDocumentStub, SanityClient, Transaction} from '@sanity/client'
import groq from 'groq'

import {ShopifyDocumentCollection, ShopifyDocumentProduct, ShopifyDocumentProductVariant} from './storageTypes'
import {SHOPIFY_PRODUCT_VARIANT_DOCUMENT_TYPE} from './constants'

export async function hasDraft(
  client: SanityClient,
  document: IdentifiedSanityDocumentStub
): Promise<boolean> {
  const draftId = `drafts.${document._id}`
  const draft = await client.getDocument(draftId)

  return draft !== undefined
}

export async function hasDrafts(
  client: SanityClient,
  documents: IdentifiedSanityDocumentStub[]
): Promise<Record<string, boolean>> {
  const draftIds = documents.map((document) => `drafts.${document._id}`)
  const drafts = await client.fetch<string[]>(groq`*[_id in $draftIds]._id`, {draftIds})

  return documents.reduce<Record<string, boolean>>((acc, current) => {
    acc[current._id] = drafts.includes(`drafts.${current._id}`)
    return acc
  }, {})
}


const deleteProductVariants = async (
  client: SanityClient,
  transaction: Transaction,
  productDocument: ShopifyDocumentProduct,
  productVariantsDocuments: ShopifyDocumentProductVariant[]
): Promise<void> => {
  const productVariantIds = productVariantsDocuments.map(({_id}) => _id)
  const deletedProductVariantIds = await client.fetch<string[]>(
    groq`*[
      _type == "${SHOPIFY_PRODUCT_VARIANT_DOCUMENT_TYPE}"
      && store.productId == $productId
      && !(_id in $productVariantIds)
    ]._id`,
    {
      productId: productDocument.store.id,
      productVariantIds,
    }
  )

  deletedProductVariantIds.forEach((deletedProductVariantId) => {
    transaction.patch(deletedProductVariantId, (patch) => patch.set({'store.isDeleted': true}))
  })
}

export async function deleteProductDocuments(client: SanityClient, id: number) {
  // Fetch all product variant documents with matching Shopify Product ID
  const productVariants: string[] = await client.fetch(
    `*[
      _type == "${SHOPIFY_PRODUCT_VARIANT_DOCUMENT_TYPE}"
      && store.productId == $id
    ]._id`,
    {id}
  )

  const documentId = buildProductDocumentId(id)
  const draftDocumentId = `drafts.${documentId}`

  // Check for draft
  const draft = await client.getDocument(draftDocumentId)

  const transaction = client.transaction()
  // Mark product as deleted
  transaction.patch(documentId, (patch) => patch.set({'store.isDeleted': true}))
  if (draft) {
    transaction.patch(draftDocumentId, (patch) => patch.set({'store.isDeleted': true}))
  }

  // Mark all product variants as deleted
  productVariants.forEach((productVariantDocumentId) =>
    transaction.patch(productVariantDocumentId, (patch) => patch.set({'store.isDeleted': true}))
  )

  await transaction.commit()
}


export const createProductDocument = (
  client: SanityClient,
  transaction: Transaction,
  document: ShopifyDocumentProduct,
  draftExists: boolean
) => {
  const publishedId = document._id

  // Create new product if none found
  transaction.createIfNotExists(document).patch(publishedId, (patch) => {
    return patch.set({store: document.store})
  })

  // Patch existing draft (if present)
  if (draftExists) {
    const draftId = `drafts.${document._id}`
    transaction.patch(draftId, (patch) => {
      return patch.set({store: document.store})
    })
  }
}

export const createProductVariantDocument = (
  client: SanityClient,
  transaction: Transaction,
  document: ShopifyDocumentProductVariant,
  draftExists: boolean
) => {
  const publishedId = document._id

  // Create document if it doesn't exist, otherwise patch with existing content
  transaction.createIfNotExists(document).patch(publishedId, (patch) => patch.set(document))

  if (draftExists) {
    const draftId = `drafts.${document._id}`
    const documentDraft = Object.assign({}, document, {
      _id: draftId,
    })

    transaction.patch(draftId, (patch) => patch.set(documentDraft))
  }
}

export async function commitProductDocuments(
  client: SanityClient,
  productDocument: ShopifyDocumentProduct,
  productVariantsDocuments: ShopifyDocumentProductVariant[]
) {
  const transaction = client.transaction()

  const drafts = await hasDrafts(client, [productDocument, ...productVariantsDocuments])

  // Create product and merge options
  createProductDocument(client, transaction, productDocument, drafts[productDocument._id])

  // Mark the non existing product variants as deleted
  await deleteProductVariants(client, transaction, productDocument, productVariantsDocuments)

  // Create / update product variants
  for (const productVariantsDocument of productVariantsDocuments) {
    createProductVariantDocument(
      client,
      transaction,
      productVariantsDocument,
      drafts[productVariantsDocument._id]
    )
  }

  await transaction.commit()
}

export const createCollectionDocument = async (
  client: SanityClient,
  transaction: Transaction,
  collectionDocument: ShopifyDocumentCollection,
  draftExists: boolean
  // eslint-disable-next-line require-await
) => {
  transaction
    .createIfNotExists(collectionDocument)
    .patch(collectionDocument._id, (patch) => patch.set(collectionDocument))

  const draftId = `drafts.${collectionDocument._id}`
  if (draftExists) {
    const documentDraft = Object.assign({}, collectionDocument, {
      _id: draftId,
    })

    transaction.patch(draftId, (patch) => patch.set(documentDraft))
  }
}

export async function commitCollectionDocument(
  client: SanityClient,
  collectionDocument: ShopifyDocumentCollection
) {
  const transaction = client.transaction()

  const drafts = await hasDrafts(client, [collectionDocument])

  // Create product and merge options
  await createCollectionDocument(
    client,
    transaction,
    collectionDocument,
    drafts[collectionDocument._id]
  )

  await transaction.commit()
}

export async function deleteCollectionDocuments(client: SanityClient, id: number) {
  const documentId = buildCollectionDocumentId(id)
  const draftDocumentId = `drafts.${documentId}`

  // Check for draft
  const draft = await client.getDocument(draftDocumentId)

  const transaction = client.transaction()
  // Mark product as deleted
  transaction.patch(documentId, (patch) => patch.set({'store.isDeleted': true}))
  if (draft) {
    transaction.patch(draftDocumentId, (patch) => patch.set({'store.isDeleted': true}))
  }

  await transaction.commit()
}

export function buildProductDocumentId(id: number): ShopifyDocumentProduct['_id'] {
  return `shopifyProduct-${id}`
}

export function buildProductVariantDocumentId(id: number): ShopifyDocumentProductVariant['_id'] {
  return `shopifyProductVariant-${id}`
}

export function buildCollectionDocumentId(id: number): ShopifyDocumentCollection['_id'] {
  return `shopifyCollection-${id}`
}
