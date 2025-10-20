/**
 * Shopify GraphQL queries for migrating from REST API
 *
 * Migration strategy: Create typed GraphQL queries to replace REST endpoints
 * Timeline: Must complete products by Feb 1, 2025
 */

// Products Query - replaces /admin/api/2024-10/products.json
export const PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          title
          description
          handle
          productType
          vendor
          tags
          status
          createdAt
          updatedAt
          publishedAt
          totalInventory
          tracksInventory

          # SEO fields
          seo {
            title
            description
          }

          # Images
          images(first: 10) {
            edges {
              node {
                id
                url
                altText
                width
                height
              }
            }
          }

          # Variants
          variants(first: 100) {
            edges {
              node {
                id
                legacyResourceId
                title
                sku
                barcode
                price
                compareAtPrice
                position
                # weight and weightUnit not available in 2024-10 API
                inventoryQuantity
                availableForSale
                createdAt
                updatedAt

                # Inventory tracking
                inventoryItem {
                  id
                  tracked
                  requiresShipping
                }

                # Option values
                selectedOptions {
                  name
                  value
                }

                # Image
                image {
                  id
                  url
                  altText
                }
              }
            }
          }

          # Options
          options {
            id
            name
            values
            position
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

// Single Product Query - replaces /admin/api/2024-10/products/{id}.json
export const PRODUCT_QUERY = `
  query getProduct($id: ID!) {
    product(id: $id) {
      id
      legacyResourceId
      title
      description
      handle
      productType
      vendor
      tags
      status
      createdAt
      updatedAt
      publishedAt
      totalInventory
      tracksInventory

      seo {
        title
        description
      }

      images(first: 20) {
        edges {
          node {
            id
            url
            altText
            width
            height
          }
        }
      }

      variants(first: 100) {
        edges {
          node {
            id
            legacyResourceId
            title
            sku
            barcode
            price
            compareAtPrice
            position
            # weight and weightUnit not available in 2024-10 API
            inventoryQuantity
            availableForSale
            createdAt
            updatedAt

            inventoryItem {
              id
              tracked
              requiresShipping
            }

            selectedOptions {
              name
              value
            }

            image {
              id
              url
              altText
            }
          }
        }
      }

      options {
        id
        name
        values
        position
      }
    }
  }
`;

// Orders Query - replaces /admin/api/2024-10/orders.json
export const ORDERS_QUERY = `
  query getOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          email
          phone
          processedAt
          createdAt
          updatedAt
          cancelledAt
          cancelReason

          # Financial info
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          # Status fields
          displayFulfillmentStatus
          displayFinancialStatus
          confirmed
          closed

          # Customer info
          customer {
            id
            legacyResourceId
            firstName
            lastName
            email
            phone
            createdAt
            updatedAt
          }

          # Shipping address
          shippingAddress {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            country
            zip
            phone
          }

          # Billing address
          billingAddress {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            country
            zip
            phone
          }

          # Line items
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  id
                  legacyResourceId
                  title
                  sku
                  barcode
                  product {
                    id
                    legacyResourceId
                    title
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }

          # Fulfillments
          fulfillments {
            id
            legacyResourceId
            status
            createdAt
            updatedAt
            trackingInfo {
              company
              number
              url
            }

            fulfillmentLineItems(first: 100) {
              edges {
                node {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
            }
          }

          # Shipping lines
          shippingLines(first: 10) {
            edges {
              node {
                id
                title
                code
                originalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }

          # Note
          note

          # Tags
          tags

          # Metafields for custom data
          metafields(first: 20) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

// Single Order Query - replaces /admin/api/2024-10/orders/{id}.json
export const ORDER_QUERY = `
  query getOrder($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      email
      phone
      processedAt
      createdAt
      updatedAt
      cancelledAt
      cancelReason

      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      subtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalDiscountsSet {
        shopMoney {
          amount
          currencyCode
        }
      }

      displayFulfillmentStatus
      displayFinancialStatus
      confirmed
      closed

      customer {
        id
        legacyResourceId
        firstName
        lastName
        email
        phone
        createdAt
        updatedAt
      }

      shippingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        country
        zip
        phone
      }

      billingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        country
        zip
        phone
      }

      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            variant {
              id
              legacyResourceId
              title
              sku
              barcode
              product {
                id
                legacyResourceId
                title
              }
            }
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }

      fulfillments {
        id
        legacyResourceId
        status
        createdAt
        updatedAt
        trackingCompany
        trackingNumbers

        fulfillmentLineItems(first: 100) {
          edges {
            node {
              id
              quantity
              lineItem {
                id
              }
            }
          }
        }
      }

      shippingLines(first: 10) {
        edges {
          node {
            id
            title
            code
            originalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }

      note
      tags

      metafields(first: 20) {
        edges {
          node {
            id
            namespace
            key
            value
            type
          }
        }
      }
    }
  }
`;

// Bulk operation query for large datasets
export const BULK_OPERATION_QUERY = `
  mutation bulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
        partialDataUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Check bulk operation status
export const BULK_OPERATION_STATUS_QUERY = `
  query getCurrentBulkOperation {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }
`;

// TypeScript interfaces for type safety
export interface ShopifyProduct {
  id: string;
  legacyResourceId: string;
  title: string;
  description: string;
  handle: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  totalInventory: number;
  tracksInventory: boolean;
  seo?: {
    title?: string;
    description?: string;
  };
  images: {
    edges: Array<{
      node: {
        id: string;
        url: string;
        altText?: string;
        width?: number;
        height?: number;
      }
    }>
  };
  variants: {
    edges: Array<{
      node: ShopifyVariant;
    }>
  };
  options: Array<{
    id: string;
    name: string;
    values: string[];
    position: number;
  }>;
}

export interface ShopifyVariant {
  id: string;
  legacyResourceId: string;
  title: string;
  sku?: string;
  barcode?: string;
  price: string;
  compareAtPrice?: string;
  position: number;
  weight?: number;
  weightUnit?: string;
  inventoryQuantity: number;
  availableForSale: boolean;
  createdAt: string;
  updatedAt: string;
  inventoryItem?: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
  };
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
  image?: {
    id: string;
    url: string;
    altText?: string;
  };
}

export interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  email?: string;
  phone?: string;
  processedAt?: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  totalPriceSet: MoneyBag;
  subtotalPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  totalDiscountsSet: MoneyBag;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  confirmed: boolean;
  closed: boolean;
  customer?: ShopifyCustomer;
  shippingAddress?: Address;
  billingAddress?: Address;
  lineItems: {
    edges: Array<{
      node: ShopifyLineItem;
    }>
  };
  fulfillments: ShopifyFulfillment[];
  shippingLines: {
    edges: Array<{
      node: ShopifyShippingLine;
    }>;
  };
  note?: string;
  tags: string[];
}

export interface MoneyBag {
  shopMoney: {
    amount: string;
    currencyCode: string;
  };
}

export interface ShopifyCustomer {
  id: string;
  legacyResourceId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Address {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface ShopifyLineItem {
  id: string;
  title: string;
  quantity: number;
  variant?: {
    id: string;
    legacyResourceId: string;
    title: string;
    sku?: string;
    barcode?: string;
    product: {
      id: string;
      legacyResourceId: string;
      title: string;
    };
  };
  originalUnitPriceSet: MoneyBag;
  discountedUnitPriceSet: MoneyBag;
  discountedTotalSet: MoneyBag;
  customAttributes: Array<{
    key: string;
    value: string;
  }>;
}

export interface ShopifyFulfillment {
  id: string;
  legacyResourceId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  trackingInfo: {
    company?: string;
    number?: string;
    url?: string;
  }[];
  fulfillmentLineItems: {
    edges: Array<{
      node: {
        id: string;
        quantity: number;
        lineItem: {
          id: string;
        };
      }
    }>
  };
}

export interface ShopifyShippingLine {
  id: string;
  title: string;
  code?: string;
  originalPriceSet: MoneyBag;
}

// Query variables interfaces
export interface ProductsQueryVariables {
  first: number;
  after?: string;
  query?: string;
  sortKey?: 'CREATED_AT' | 'ID' | 'PRODUCT_TYPE' | 'TITLE' | 'UPDATED_AT' | 'VENDOR';
  reverse?: boolean;
}

export interface OrdersQueryVariables {
  first: number;
  after?: string;
  query?: string;
  sortKey?: 'CREATED_AT' | 'ID' | 'ORDER_NUMBER' | 'PROCESSED_AT' | 'TOTAL_PRICE' | 'UPDATED_AT';
  reverse?: boolean;
}

// Customers Query - replaces /admin/api/2024-10/customers.json
export const CUSTOMERS_QUERY = `
  query getCustomers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys, $reverse: Boolean) {
    customers(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          firstName
          lastName
          email
          phone
          state
          verifiedEmail

          # Email marketing consent
          emailMarketingConsent {
            consentUpdatedAt
            marketingOptInLevel
            marketingState
          }

          # SMS marketing consent
          smsMarketingConsent {
            consentCollectedFrom
            consentUpdatedAt
            marketingOptInLevel
            marketingState
          }

          # Default address
          defaultAddress {
            id
            address1
            address2
            city
            province
            country
            zip
            phone
            firstName
            lastName
            company
          }

          # All addresses
          addresses(first: 10) {
            id
            address1
            address2
            city
            province
            country
            zip
            phone
            firstName
            lastName
            company
          }

          # Stats
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }

          # Metadata
          tags
          note

          # Timestamps
          createdAt
          updatedAt
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

export interface CustomersQueryVariables {
  first: number;
  after?: string;
  query?: string;
  sortKey?: 'CREATED_AT' | 'ID' | 'NAME' | 'ORDERS_COUNT' | 'TOTAL_SPENT' | 'UPDATED_AT';
  reverse?: boolean;
}