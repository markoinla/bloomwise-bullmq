/**
 * Transform Shopify GraphQL Product to Database Records
 */

import type { ShopifyProductInsert, ShopifyVariantInsert } from '../../db/schema';

interface ShopifyGraphQLProduct {
  id: string;
  title: string;
  descriptionHtml?: string;
  handle: string;
  status: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
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
        title: string;
        sku?: string;
        barcode?: string;
        price: string;
        compareAtPrice?: string;
        inventoryQuantity?: number;
        inventoryPolicy?: string;
        inventoryManagement?: string;
        fulfillmentService?: string;
        requiresShipping?: boolean;
        taxable?: boolean;
        weight?: number;
        weightUnit?: string;
        position?: number;
        image?: {
          url: string;
          altText?: string;
        };
        selectedOptions?: Array<{
          name: string;
          value: string;
        }>;
      };
    }>;
  };
  options?: Array<{
    name: string;
    values: string[];
  }>;
  seo?: {
    title?: string;
    description?: string;
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
 */
export function transformProductToDbRecords(
  product: ShopifyGraphQLProduct,
  organizationId: string
): {
  productRecords: ShopifyProductInsert[];
  variantRecords: ShopifyVariantInsert[];
} {
  const productRecords: ShopifyProductInsert[] = [];
  const variantRecords: ShopifyVariantInsert[] = [];

  const shopifyProductId = extractShopifyId(product.id);
  const now = new Date();

  // Get all images
  const allImages = product.images?.edges.map((edge) => ({
    url: edge.node.url,
    altText: edge.node.altText || null,
  })) || [];

  // Get product options
  const options = product.options || [];
  const option1 = options[0]?.name || null;
  const option2 = options[1]?.name || null;
  const option3 = options[2]?.name || null;

  // Process each variant
  const variants = product.variants?.edges || [];

  for (const variantEdge of variants) {
    const variant = variantEdge.node;
    const shopifyVariantId = extractShopifyId(variant.id);

    // Get variant option values
    const selectedOptions = variant.selectedOptions || [];
    const option1Value = selectedOptions.find(opt => opt.name === option1)?.value || null;
    const option2Value = selectedOptions.find(opt => opt.name === option2)?.value || null;
    const option3Value = selectedOptions.find(opt => opt.name === option3)?.value || null;

    // Create product record (one per variant in shopify_products table)
    const productRecord: ShopifyProductInsert = {
      organizationId,
      shopifyProductId,
      shopifyVariantId,

      // Product info
      title: product.title,
      bodyHtml: product.descriptionHtml || null,
      vendor: product.vendor || null,
      productType: product.productType || null,
      handle: product.handle,

      // Variant info
      variantTitle: variant.title,
      variantPrice: variant.price,
      variantCompareAtPrice: variant.compareAtPrice || null,
      variantSku: variant.sku || null,
      variantBarcode: variant.barcode || null,
      variantGrams: variant.weight ? Math.round(variant.weight) : null,
      variantInventoryQuantity: variant.inventoryQuantity || 0,
      variantInventoryPolicy: variant.inventoryPolicy || null,
      variantFulfillmentService: variant.fulfillmentService || null,
      variantInventoryManagement: variant.inventoryManagement || null,
      variantRequiresShipping: variant.requiresShipping ?? true,
      variantTaxable: variant.taxable ?? true,
      variantPosition: variant.position || null,

      // Options
      option1,
      option1Value,
      option2,
      option2Value,
      option3,
      option3Value,

      // Status
      status: product.status.toLowerCase(),
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      publishedScope: null,

      // SEO
      seoTitle: product.seo?.title || null,
      seoDescription: product.seo?.description || null,

      // Images
      featuredImage: product.featuredImage?.url || null,
      variantImage: variant.image?.url || null,
      allImages,

      // Tags
      tags: product.tags?.join(', ') || null,
      collections: null,

      // Shopify timestamps
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),

      // Raw data
      rawProductData: product,
      rawVariantData: variant,

      // Sync metadata
      apiVersion: '2024-10',
      syncedAt: now,

      // Active by default
      isActive: true,
    };

    productRecords.push(productRecord);

    // Create variant record for shopify_variants table
    const variantRecord: ShopifyVariantInsert = {
      organizationId,
      shopifyProductId,
      shopifyVariantId,

      // Variant info
      title: product.title,
      variantTitle: variant.title,
      sku: variant.sku || null,
      barcode: variant.barcode || null,
      grams: variant.weight ? Math.round(variant.weight) : null,
      weight: variant.weight?.toString() || null,
      weightUnit: variant.weightUnit || null,

      // Pricing
      price: variant.price,
      compareAtPrice: variant.compareAtPrice || null,

      // Inventory
      inventoryQuantity: variant.inventoryQuantity || 0,
      inventoryPolicy: variant.inventoryPolicy || null,
      inventoryManagement: variant.inventoryManagement || null,
      fulfillmentService: variant.fulfillmentService || null,
      requiresShipping: variant.requiresShipping ?? true,
      taxable: variant.taxable ?? true,
      taxCode: null,

      // Options
      option1Name: option1,
      option1Value,
      option2Name: option2,
      option2Value,
      option3Name: option3,
      option3Value,

      // Display
      position: variant.position || null,
      imageId: null,
      imageSrc: variant.image?.url || null,

      // Status
      isActive: product.status.toLowerCase() === 'active',
      availableForSale: true,

      // Shopify timestamps
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),

      // Raw data
      rawData: variant,

      // Sync metadata
      syncedAt: now,
    };

    variantRecords.push(variantRecord);
  }

  return { productRecords, variantRecords };
}
