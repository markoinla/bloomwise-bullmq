/**
 * Transform Shopify GraphQL Product to Database Records
 * Matches the pattern from examples/sync/products-sync-graphql.ts
 */

import type { ShopifyProductInsert, ShopifyVariantInsert } from '../../db/schema';

interface ShopifyGraphQLProduct {
  id: string;
  legacyResourceId?: string;
  title: string;
  descriptionHtml?: string;
  handle: string;
  status: string;
  vendor?: string;
  productType?: string;
  tags?: string[] | string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  featuredImage?: {
    url: string;
    altText?: string;
  };
  images?: {
    edges: Array<{
      node: {
        url: string;
        altText?: string;
      };
    }>;
  };
  variants?: {
    edges: Array<{
      node: {
        id: string;
        legacyResourceId?: string;
        title: string;
        sku?: string;
        barcode?: string;
        price: string | { amount: string };
        compareAtPrice?: string | { amount: string };
        inventoryQuantity?: number | { available: number };
        inventoryPolicy?: string;
        inventoryManagement?: string;
        fulfillmentService?: string;
        requiresShipping?: boolean;
        taxable?: boolean;
        weight?: number | { value: number; unit: string };
        weightUnit?: string;
        position?: number;
        image?: {
          url: string;
        };
        selectedOptions?: Array<{
          name: string;
          value: string;
        }>;
        createdAt?: string;
        updatedAt?: string;
      };
    }>;
  };
}

/**
 * Extract numeric ID from Shopify GID format
 * e.g., "gid://shopify/Product/123456" -> "123456"
 */
function extractShopifyId(gid: string): string {
  const parts = gid.split('/');
  return parts[parts.length - 1];
}

/**
 * Transform a Shopify GraphQL product into database insert records
 * Returns ONE product record and multiple variant records
 */
export function transformProductToDbRecords(
  product: ShopifyGraphQLProduct,
  organizationId: string
): {
  productRecord: ShopifyProductInsert;
  variantRecords: ShopifyVariantInsert[];
} {
  // Extract product ID (use legacyResourceId if available, otherwise parse from GID)
  const shopifyProductId = product.legacyResourceId?.toString() || extractShopifyId(product.id);

  // Extract images
  const images = product.images?.edges?.map(edge => edge.node) || [];
  const featuredImage = images.length > 0 ? images[0]?.url : null;
  const allImages = images.map(img => img.url).filter(Boolean);

  // Create ONE product record (product-level data only)
  const productRecord: ShopifyProductInsert = {
    organizationId,
    shopifyProductId,
    shopifyVariantId: null, // Product record doesn't reference a specific variant

    // Product information
    title: product.title || "",
    bodyHtml: product.descriptionHtml || null,
    vendor: product.vendor || null,
    productType: product.productType || null,
    handle: product.handle || "",

    // Variant fields - leave null for product record
    variantTitle: null,
    variantPrice: null,
    variantCompareAtPrice: null,
    variantSku: null,
    variantBarcode: null,
    variantGrams: null,
    variantInventoryQuantity: null,
    variantInventoryPolicy: null,
    variantFulfillmentService: null,
    variantInventoryManagement: null,
    variantRequiresShipping: true,
    variantTaxable: true,
    variantPosition: null,

    // Options - leave null
    option1: null,
    option1Value: null,
    option2: null,
    option2Value: null,
    option3: null,
    option3Value: null,

    // Status and availability
    status: product.status || "draft",
    publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
    publishedScope: "web",

    // SEO - not in GraphQL response, leave null
    seoTitle: null,
    seoDescription: null,

    // Images
    featuredImage,
    variantImage: null,
    allImages,

    // Tags
    tags: product.tags ? (Array.isArray(product.tags) ? product.tags.join(", ") : product.tags) : null,
    collections: null,

    // Shopify timestamps
    shopifyCreatedAt: new Date(product.createdAt),
    shopifyUpdatedAt: new Date(product.updatedAt),

    // Raw data
    rawProductData: product,
    rawVariantData: null,

    // Sync metadata
    apiVersion: '2024-10',
    syncedAt: new Date(),

    // Active by default
    isActive: true,
  };

  // Create variant records for ALL variants
  const variantRecords: ShopifyVariantInsert[] = [];
  const variantsArray = product.variants?.edges?.map(edge => edge.node) || [];

  variantsArray.forEach((variant) => {
    const variantId = variant.legacyResourceId?.toString() || extractShopifyId(variant.id);

    // Extract price (handle both string and object format)
    const price = typeof variant.price === 'object' ? variant.price.amount : variant.price;
    const compareAtPrice = variant.compareAtPrice
      ? (typeof variant.compareAtPrice === 'object' ? variant.compareAtPrice.amount : variant.compareAtPrice)
      : null;

    // Extract inventory quantity
    const inventoryQuantity = typeof variant.inventoryQuantity === 'object'
      ? variant.inventoryQuantity.available
      : (variant.inventoryQuantity || 0);

    // Extract weight
    const weight = typeof variant.weight === 'object' ? variant.weight.value : variant.weight;
    const weightUnit = typeof variant.weight === 'object' ? variant.weight.unit : (variant.weightUnit || 'kg');

    const variantRecord: ShopifyVariantInsert = {
      organizationId,
      shopifyProductId,
      shopifyVariantId: variantId,

      // Variant information
      title: variant.title || "",
      variantTitle: variant.title || "",
      sku: variant.sku || null,
      barcode: variant.barcode || null,
      grams: weight ? Math.round(weight) : 0,
      weight: weight?.toString() || null,
      weightUnit,

      // Pricing
      price: price || "0.00",
      compareAtPrice,

      // Inventory
      inventoryQuantity,
      inventoryPolicy: variant.inventoryPolicy || "deny",
      inventoryManagement: variant.inventoryManagement || null,
      fulfillmentService: variant.fulfillmentService || "manual",
      requiresShipping: variant.requiresShipping ?? true,
      taxable: variant.taxable ?? true,
      taxCode: null,

      // Options
      option1Name: null,
      option1Value: variant.selectedOptions?.[0]?.value || null,
      option2Name: null,
      option2Value: variant.selectedOptions?.[1]?.value || null,
      option3Name: null,
      option3Value: variant.selectedOptions?.[2]?.value || null,

      // Display
      position: variant.position || 1,
      imageId: null,
      imageSrc: variant.image?.url || null,

      // Status
      isActive: product.status?.toLowerCase() === 'active',
      availableForSale: true,

      // Shopify timestamps
      shopifyCreatedAt: variant.createdAt ? new Date(variant.createdAt) : new Date(product.createdAt),
      shopifyUpdatedAt: variant.updatedAt ? new Date(variant.updatedAt) : new Date(product.updatedAt),

      // Raw data
      rawData: variant,

      // Sync metadata
      syncedAt: new Date(),
    };

    variantRecords.push(variantRecord);
  });

  return { productRecord, variantRecords };
}
