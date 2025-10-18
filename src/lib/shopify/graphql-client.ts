/**
 * Shopify GraphQL client utilities
 *
 * High-level functions to execute GraphQL queries and replace REST API calls
 */

import { createShopifyClient } from "./client";
import { rateLimitedFetch, shopifyRateLimiter } from "../utils/rate-limiter";
import {
  PRODUCTS_QUERY,
  PRODUCT_QUERY,
  ORDERS_QUERY,
  ORDER_QUERY,
  BULK_OPERATION_QUERY,
  BULK_OPERATION_STATUS_QUERY,
  type ShopifyProduct,
  type ShopifyOrder,
  type ProductsQueryVariables,
  type OrdersQueryVariables,
} from "./graphql-queries";

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
  }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor?: string;
    endCursor?: string;
  };
  totalCount?: number;
}

/**
 * Execute a GraphQL query using the Shopify client
 */
export async function executeGraphQLQuery<T>(
  organizationId: string,
  query: string,
  variables?: Record<string, any>,
  retryCount: number = 0
): Promise<GraphQLResponse<T>> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_BASE = 1000; // Start with 1 second

  const client = await createShopifyClient(organizationId);

  if (!client) {
    const error = new Error("No Shopify client available - integration may be missing or inactive");
    console.error(`❌ [GRAPHQL] Failed to create Shopify client for organization ${organizationId}`);
    console.error(`❌ [GRAPHQL] This usually means:
      1. No Shopify integration found for this organization
      2. Integration exists but is not active
      3. Access token is missing or invalid`);
    throw error;
  }

  try {
    // Use rate limiting to stay within API limits
    await shopifyRateLimiter.waitIfNeeded();

    // SDK v12 expects { variables } as second parameter to request method
    const response = await client.graphql.request(query, {
      variables: variables || {}
    });

    // SDK v12 returns { data, extensions, headers } directly
    return response as unknown as GraphQLResponse<T>;
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if this is a rate limit error (throttled) or other retryable error
    const isRateLimitError = errorMessage.toLowerCase().includes('throttled') ||
                            errorMessage.includes('429') ||
                            errorMessage.toLowerCase().includes('rate limit');

    const isRetryableError = isRateLimitError ||
                             errorMessage.toLowerCase().includes('timeout') ||
                             errorMessage.toLowerCase().includes('network');

    if (isRetryableError && retryCount < MAX_RETRIES) {
      // Exponential backoff with longer delays for rate limiting
      // For rate limit errors: 2s, 5s, 10s
      // For other errors: 1s, 2s, 4s
      let retryDelay: number;
      if (isRateLimitError) {
        // Longer delays for rate limit errors
        retryDelay = retryCount === 0 ? 2000 : retryCount === 1 ? 5000 : 10000;
        console.log(`[GRAPHQL] ⚠️  Shopify rate limit (throttled). Waiting ${retryDelay}ms before retry (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      } else {
        // Standard exponential backoff for other errors
        retryDelay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
        console.log(`[GRAPHQL] Retryable error detected. Retrying in ${retryDelay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));

      // Retry the request
      return executeGraphQLQuery<T>(organizationId, query, variables, retryCount + 1);
    }

    console.error(`❌ [GRAPHQL] Query failed after ${retryCount} retries for organization ${organizationId}`);
    console.error(`❌ [GRAPHQL] Error: ${errorMessage}`);
    console.error(`❌ [GRAPHQL] Query excerpt: ${query.substring(0, 200)}...`);

    // Log to Sentry for production monitoring
    import('@sentry/nextjs').then(Sentry => {
      Sentry.captureException(error, {
        tags: {
          component: 'shopify-graphql',
          organizationId,
          retryCount,
        },
        extra: {
          errorMessage,
          queryExcerpt: query.substring(0, 500),
          variables,
        }
      });
    }).catch(() => {
      // Sentry import failed, continue without logging
    });

    throw error;
  }
}

/**
 * Fetch products using GraphQL (replaces REST /products.json)
 */
export async function fetchProductsGraphQL(
  organizationId: string,
  options: {
    limit?: number;
    cursor?: string;
    query?: string;
    sortKey?: ProductsQueryVariables['sortKey'];
    reverse?: boolean;
  } = {}
): Promise<PaginatedResponse<ShopifyProduct>> {
  const variables: ProductsQueryVariables = {
    first: Math.min(options.limit || 250, 250), // GraphQL max is 250
    ...(options.cursor && { after: options.cursor }), // Only include if exists
    ...(options.query && { query: options.query }), // Only include if exists
    sortKey: options.sortKey || 'UPDATED_AT',
    reverse: options.reverse !== false, // Default to newest first (true)
  };

  const response = await executeGraphQLQuery<{
    products: {
      edges: Array<{ node: ShopifyProduct; cursor: string }>;
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string;
        endCursor: string;
      };
    };
  }>(organizationId, PRODUCTS_QUERY, variables);

  if (response.errors) {
    throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
  }

  if (!response.data?.products) {
    throw new Error("No products data in GraphQL response");
  }

  const products = response.data.products.edges.map(edge => edge.node);

  return {
    data: products,
    pageInfo: response.data.products.pageInfo,
    totalCount: undefined, // GraphQL doesn't provide total count by default
  };
}

/**
 * Fetch single product using GraphQL (replaces REST /products/{id}.json)
 */
export async function fetchProductGraphQL(
  organizationId: string,
  productId: string
): Promise<ShopifyProduct | null> {
  // Convert numeric ID to GraphQL ID format if needed
  const gqlId = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;

  const response = await executeGraphQLQuery<{
    product: ShopifyProduct;
  }>(organizationId, PRODUCT_QUERY, { id: gqlId });

  if (response.errors) {
    throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
  }

  return response.data?.product || null;
}

/**
 * Fetch orders using GraphQL (replaces REST /orders.json)
 */
export async function fetchOrdersGraphQL(
  organizationId: string,
  options: {
    limit?: number;
    cursor?: string;
    query?: string;
    sortKey?: OrdersQueryVariables['sortKey'];
    reverse?: boolean;
  } = {}
): Promise<PaginatedResponse<ShopifyOrder>> {
  const variables: OrdersQueryVariables = {
    first: Math.min(options.limit || 250, 250), // GraphQL max is 250
    ...(options.cursor && { after: options.cursor }), // Only include if exists
    ...(options.query && { query: options.query }), // Only include if exists
    sortKey: options.sortKey || 'UPDATED_AT',
    reverse: options.reverse !== false, // Default to newest first (true)
  };

  const response = await executeGraphQLQuery<{
    orders: {
      edges: Array<{ node: ShopifyOrder; cursor: string }>;
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string;
        endCursor: string;
      };
    };
  }>(organizationId, ORDERS_QUERY, variables);

  if (response.errors) {
    throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
  }

  if (!response.data?.orders) {
    throw new Error("No orders data in GraphQL response");
  }

  const orders = response.data.orders.edges.map(edge => edge.node);

  return {
    data: orders,
    pageInfo: response.data.orders.pageInfo,
    totalCount: undefined, // GraphQL doesn't provide total count by default
  };
}

/**
 * Fetch single order using GraphQL (replaces REST /orders/{id}.json)
 */
export async function fetchOrderGraphQL(
  organizationId: string,
  orderId: string
): Promise<ShopifyOrder | null> {
  // Convert numeric ID to GraphQL ID format if needed
  const gqlId = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`;

  const response = await executeGraphQLQuery<{
    order: ShopifyOrder;
  }>(organizationId, ORDER_QUERY, { id: gqlId });

  if (response.errors) {
    throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
  }

  return response.data?.order || null;
}

/**
 * Convert GraphQL product data to match existing REST API format
 * This helps with gradual migration by maintaining compatibility
 */
export function convertGraphQLProductToREST(product: ShopifyProduct): any {
  return {
    id: parseInt(product.legacyResourceId),
    title: product.title,
    body_html: product.description,
    vendor: product.vendor,
    product_type: product.productType,
    created_at: product.createdAt,
    handle: product.handle,
    updated_at: product.updatedAt,
    published_at: product.publishedAt,
    template_suffix: null,
    published_scope: "web",
    tags: product.tags.join(', '),
    status: product.status.toLowerCase(),
    admin_graphql_api_id: product.id,

    variants: product.variants.edges.map(({ node: variant }) => ({
      id: parseInt(variant.legacyResourceId),
      product_id: parseInt(product.legacyResourceId),
      title: variant.title,
      price: variant.price,
      sku: variant.sku,
      position: variant.position,
      inventory_policy: "deny",
      compare_at_price: variant.compareAtPrice,
      fulfillment_service: "manual",
      inventory_management: "shopify",
      option1: variant.selectedOptions[0]?.value,
      option2: variant.selectedOptions[1]?.value,
      option3: variant.selectedOptions[2]?.value,
      created_at: variant.createdAt,
      updated_at: variant.updatedAt,
      taxable: true,
      barcode: variant.barcode,
      grams: variant.weight ? Math.round(variant.weight * 1000) : 0, // Convert kg to grams
      inventory_quantity: variant.inventoryQuantity,
      weight: variant.weight,
      weight_unit: variant.weightUnit || "kg",
      inventory_item_id: variant.inventoryItem?.id,
      old_inventory_quantity: variant.inventoryQuantity,
      requires_shipping: variant.inventoryItem?.requiresShipping,
      admin_graphql_api_id: variant.id,
    })),

    options: product.options.map(option => ({
      id: parseInt(option.id),
      product_id: parseInt(product.legacyResourceId),
      name: option.name,
      position: option.position,
      values: option.values,
    })),

    images: product.images.edges.map(({ node: image }, index) => ({
      id: parseInt(image.id),
      product_id: parseInt(product.legacyResourceId),
      position: index + 1,
      created_at: product.createdAt,
      updated_at: product.updatedAt,
      alt: image.altText,
      width: image.width,
      height: image.height,
      src: image.url,
      variant_ids: [],
      admin_graphql_api_id: image.id,
    })),

    image: product.images.edges[0] ? {
      id: parseInt(product.images.edges[0].node.id),
      product_id: parseInt(product.legacyResourceId),
      position: 1,
      created_at: product.createdAt,
      updated_at: product.updatedAt,
      alt: product.images.edges[0].node.altText,
      width: product.images.edges[0].node.width,
      height: product.images.edges[0].node.height,
      src: product.images.edges[0].node.url,
      variant_ids: [],
      admin_graphql_api_id: product.images.edges[0].node.id,
    } : null,
  };
}

/**
 * Convert GraphQL order data to match existing REST API format
 */
export function convertGraphQLOrderToREST(order: ShopifyOrder): any {
  return {
    id: parseInt(order.legacyResourceId),
    admin_graphql_api_id: order.id,
    app_id: null,
    browser_ip: null,
    buyer_accepts_marketing: false,
    cancel_reason: order.cancelReason,
    cancelled_at: order.cancelledAt,
    cart_token: null,
    checkout_id: null,
    checkout_token: null,
    client_details: null,
    closed_at: order.closed ? order.updatedAt : null,
    confirmed: order.confirmed,
    contact_email: order.email,
    created_at: order.createdAt,
    currency: order.totalPriceSet.shopMoney.currencyCode,
    current_subtotal_price: order.subtotalPriceSet.shopMoney.amount,
    current_subtotal_price_set: order.subtotalPriceSet,
    current_total_discounts: order.totalDiscountsSet.shopMoney.amount,
    current_total_discounts_set: order.totalDiscountsSet,
    current_total_price: order.totalPriceSet.shopMoney.amount,
    current_total_price_set: order.totalPriceSet,
    current_total_tax: order.totalTaxSet.shopMoney.amount,
    current_total_tax_set: order.totalTaxSet,
    customer_locale: null,
    device_id: null,
    discount_codes: [],
    email: order.email,
    estimated_taxes: false,
    financial_status: order.displayFinancialStatus.toLowerCase(),
    fulfillment_status: order.displayFulfillmentStatus === 'UNFULFILLED' ? null : order.displayFulfillmentStatus.toLowerCase(),
    gateway: null,
    landing_site: null,
    landing_site_ref: null,
    location_id: null,
    name: order.name,
    note: order.note,
    note_attributes: [],
    number: parseInt(order.name.replace(/^#/, '')) || 0,
    order_number: parseInt(order.name.replace(/^#/, '')) || 0,
    order_status_url: null,
    original_total_duties_set: null,
    payment_gateway_names: [],
    phone: order.phone,
    presentment_currency: order.totalPriceSet.shopMoney.currencyCode,
    processed_at: order.processedAt,
    processing_method: "direct",
    reference: null,
    referring_site: null,
    source_identifier: null,
    source_name: "web",
    source_url: null,
    subtotal_price: order.subtotalPriceSet.shopMoney.amount,
    subtotal_price_set: order.subtotalPriceSet,
    tags: order.tags.join(', '),
    tax_lines: [],
    taxes_included: false,
    test: false,
    token: null,
    total_discounts: order.totalDiscountsSet.shopMoney.amount,
    total_discounts_set: order.totalDiscountsSet,
    total_line_items_price: order.subtotalPriceSet.shopMoney.amount,
    total_line_items_price_set: order.subtotalPriceSet,
    total_outstanding: "0.00",
    total_price: order.totalPriceSet.shopMoney.amount,
    total_price_set: order.totalPriceSet,
    total_price_usd: order.totalPriceSet.shopMoney.amount,
    total_shipping_price_set: {
      shop_money: {
        amount: order.shippingLines[0]?.originalPriceSet.shopMoney.amount || "0.00",
        currency_code: order.totalPriceSet.shopMoney.currencyCode,
      },
      presentment_money: {
        amount: order.shippingLines[0]?.originalPriceSet.shopMoney.amount || "0.00",
        currency_code: order.totalPriceSet.shopMoney.currencyCode,
      },
    },
    total_tax: order.totalTaxSet.shopMoney.amount,
    total_tax_set: order.totalTaxSet,
    total_tip_received: "0.00",
    total_weight: 0,
    updated_at: order.updatedAt,
    user_id: null,

    // Customer
    customer: order.customer ? {
      id: parseInt(order.customer.legacyResourceId),
      email: order.customer.email,
      accepts_marketing: false,
      created_at: order.customer.createdAt,
      updated_at: order.customer.updatedAt,
      first_name: order.customer.firstName,
      last_name: order.customer.lastName,
      orders_count: 1,
      state: "disabled",
      total_spent: "0.00",
      last_order_id: null,
      note: null,
      verified_email: true,
      multipass_identifier: null,
      tax_exempt: false,
      phone: order.customer.phone,
      tags: "",
      last_order_name: null,
      currency: order.totalPriceSet.shopMoney.currencyCode,
      addresses: [],
      admin_graphql_api_id: order.customer.id,
      default_address: order.shippingAddress,
    } : null,

    // Addresses
    billing_address: order.billingAddress,
    shipping_address: order.shippingAddress,

    // Line items
    line_items: order.lineItems.edges.map(({ node: item }, index) => ({
      id: parseInt(item.id),
      admin_graphql_api_id: item.id,
      fulfillable_quantity: item.quantity,
      fulfillment_service: "manual",
      fulfillment_status: null,
      gift_card: false,
      grams: 0,
      name: item.title,
      origin_location: null,
      price: item.originalUnitPriceSet.shopMoney.amount,
      price_set: item.originalUnitPriceSet,
      product_exists: true,
      product_id: item.variant?.product.legacyResourceId ? parseInt(item.variant.product.legacyResourceId) : null,
      properties: item.customAttributes.map(attr => ({
        name: attr.key,
        value: attr.value,
      })),
      quantity: item.quantity,
      requires_shipping: true,
      sku: item.variant?.sku,
      taxable: true,
      title: item.title,
      total_discount: "0.00",
      total_discount_set: {
        shop_money: { amount: "0.00", currency_code: order.totalPriceSet.shopMoney.currencyCode },
        presentment_money: { amount: "0.00", currency_code: order.totalPriceSet.shopMoney.currencyCode },
      },
      variant_id: item.variant?.legacyResourceId ? parseInt(item.variant.legacyResourceId) : null,
      variant_inventory_management: "shopify",
      variant_title: item.variant?.title,
      vendor: null,
      tax_lines: [],
      duties: [],
      discount_allocations: [],
    })),

    // Shipping lines (handle connection structure)
    shipping_lines: (order.shippingLines?.edges || []).map(edge => {
      const line = edge.node;
      return {
      id: line.id,
      carrier_identifier: null,
      code: line.code,
      delivery_category: null,
      discounted_price: line.originalPriceSet.shopMoney.amount,
      discounted_price_set: line.originalPriceSet,
      phone: null,
      price: line.originalPriceSet.shopMoney.amount,
      price_set: line.originalPriceSet,
      requested_fulfillment_service_id: null,
      source: "shopify",
      title: line.title,
      tax_lines: [],
      discount_allocations: [],
    }}),

    fulfillments: order.fulfillments,
  };
}

/**
 * Start a bulk operation for large datasets
 */
export async function startBulkOperation(
  organizationId: string,
  bulkQuery: string
): Promise<string> {
  const response = await executeGraphQLQuery<{
    bulkOperationRunQuery: {
      bulkOperation: {
        id: string;
        status: string;
      };
      userErrors: Array<{
        field: string[];
        message: string;
      }>;
    };
  }>(organizationId, BULK_OPERATION_QUERY, { query: bulkQuery });

  if (response.errors || response.data?.bulkOperationRunQuery.userErrors?.length) {
    const errors = [
      ...(response.errors || []).map(e => e.message),
      ...(response.data?.bulkOperationRunQuery.userErrors || []).map(e => e.message),
    ];
    throw new Error(`Bulk operation failed: ${errors.join(', ')}`);
  }

  return response.data!.bulkOperationRunQuery.bulkOperation.id;
}

/**
 * Check bulk operation status
 */
export async function checkBulkOperationStatus(
  organizationId: string
): Promise<{
  id: string;
  status: string;
  url?: string;
  objectCount?: number;
  errorCode?: string;
}> {
  const response = await executeGraphQLQuery<{
    currentBulkOperation: {
      id: string;
      status: string;
      url?: string;
      objectCount?: number;
      errorCode?: string;
    };
  }>(organizationId, BULK_OPERATION_STATUS_QUERY);

  if (response.errors) {
    throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
  }

  return response.data!.currentBulkOperation;
}