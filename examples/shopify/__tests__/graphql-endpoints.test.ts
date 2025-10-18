import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchProductsGraphQL, fetchOrdersGraphQL, convertGraphQLProductToREST, convertGraphQLOrderToREST } from '../graphql-client';

// Mock the Shopify client
vi.mock('../client', () => ({
  createShopifyClient: vi.fn().mockResolvedValue({
    graphql: {
      request: vi.fn()
    }
  })
}));

// Mock auth utils
vi.mock('../../auth-utils', () => ({
  getOrganizationId: vi.fn().mockResolvedValue('test-org-id')
}));

// Mock rate limiter
vi.mock('../../utils/rate-limiter', () => ({
  shopifyRateLimiter: {
    waitIfNeeded: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('Shopify GraphQL Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchProductsGraphQL', () => {
    it('should fetch products successfully', async () => {
      const mockResponse = {
        data: {
          products: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Product/123',
                  legacyResourceId: '123',
                  title: 'Test Product',
                  description: 'Test Description',
                  vendor: 'Test Vendor',
                  productType: 'Test Type',
                  status: 'ACTIVE',
                  createdAt: '2024-01-01T00:00:00Z',
                  updatedAt: '2024-01-01T00:00:00Z',
                  variants: {
                    edges: [
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/456',
                          legacyResourceId: '456',
                          title: 'Default Title',
                          price: '10.00',
                          sku: 'TEST-SKU',
                          inventoryQuantity: 5,
                          selectedOptions: [
                            { name: 'Title', value: 'Default Title' }
                          ]
                        }
                      }
                    ]
                  },
                  images: {
                    edges: []
                  },
                  options: []
                }
              }
            ],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: 'cursor1',
              endCursor: 'cursor1'
            }
          }
        }
      };

      const { createShopifyClient } = await import('../client');
      const mockClient = await createShopifyClient('test-org-id');
      vi.mocked(mockClient.graphql.request).mockResolvedValue(mockResponse);

      const result = await fetchProductsGraphQL('test-org-id', { limit: 10 });

      expect(result).toEqual({
        data: expect.arrayContaining([
          expect.objectContaining({
            legacyResourceId: '123',
            title: 'Test Product'
          })
        ]),
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: 'cursor1',
          endCursor: 'cursor1'
        },
        totalCount: undefined
      });
    });

    it('should handle GraphQL errors', async () => {
      const mockResponse = {
        errors: [{ message: 'Test error' }]
      };

      const { createShopifyClient } = await import('../client');
      const mockClient = await createShopifyClient('test-org-id');
      vi.mocked(mockClient.graphql.request).mockResolvedValue(mockResponse);

      await expect(fetchProductsGraphQL('test-org-id')).rejects.toThrow('GraphQL errors: Test error');
    });
  });

  describe('fetchOrdersGraphQL', () => {
    it('should fetch orders successfully', async () => {
      const mockResponse = {
        data: {
          orders: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Order/789',
                  legacyResourceId: '789',
                  name: '#1001',
                  email: 'test@example.com',
                  createdAt: '2024-01-01T00:00:00Z',
                  updatedAt: '2024-01-01T00:00:00Z',
                  totalPriceSet: {
                    shopMoney: {
                      amount: '100.00',
                      currencyCode: 'USD'
                    }
                  },
                  subtotalPriceSet: {
                    shopMoney: {
                      amount: '90.00',
                      currencyCode: 'USD'
                    }
                  },
                  totalTaxSet: {
                    shopMoney: {
                      amount: '10.00',
                      currencyCode: 'USD'
                    }
                  },
                  totalDiscountsSet: {
                    shopMoney: {
                      amount: '0.00',
                      currencyCode: 'USD'
                    }
                  },
                  displayFinancialStatus: 'PAID',
                  displayFulfillmentStatus: 'FULFILLED',
                  confirmed: true,
                  closed: false,
                  tags: ['test'],
                  lineItems: {
                    edges: []
                  },
                  fulfillments: [],
                  shippingLines: []
                }
              }
            ],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: 'cursor1',
              endCursor: 'cursor1'
            }
          }
        }
      };

      const { createShopifyClient } = await import('../client');
      const mockClient = await createShopifyClient('test-org-id');
      vi.mocked(mockClient.graphql.request).mockResolvedValue(mockResponse);

      const result = await fetchOrdersGraphQL('test-org-id', { limit: 10 });

      expect(result).toEqual({
        data: expect.arrayContaining([
          expect.objectContaining({
            legacyResourceId: '789',
            name: '#1001'
          })
        ]),
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: 'cursor1',
          endCursor: 'cursor1'
        },
        totalCount: undefined
      });
    });
  });

  describe('convertGraphQLProductToREST', () => {
    it('should convert GraphQL product to REST format', () => {
      const graphqlProduct = {
        id: 'gid://shopify/Product/123',
        legacyResourceId: '123',
        title: 'Test Product',
        description: 'Test Description',
        vendor: 'Test Vendor',
        productType: 'Test Type',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        publishedAt: '2024-01-01T00:00:00Z',
        handle: 'test-product',
        status: 'ACTIVE',
        tags: ['tag1', 'tag2'],
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/456',
                legacyResourceId: '456',
                title: 'Default Title',
                price: '10.00',
                position: 1,
                selectedOptions: [
                  { name: 'Title', value: 'Default Title' }
                ],
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                inventoryQuantity: 5
              }
            }
          ]
        },
        images: {
          edges: []
        },
        options: []
      };

      const restProduct = convertGraphQLProductToREST(graphqlProduct);

      expect(restProduct).toEqual(
        expect.objectContaining({
          id: 123,
          title: 'Test Product',
          body_html: 'Test Description',
          vendor: 'Test Vendor',
          product_type: 'Test Type',
          status: 'active',
          admin_graphql_api_id: 'gid://shopify/Product/123',
          variants: expect.arrayContaining([
            expect.objectContaining({
              id: 456,
              product_id: 123,
              title: 'Default Title',
              price: '10.00'
            })
          ])
        })
      );
    });
  });

  describe('convertGraphQLOrderToREST', () => {
    it('should convert GraphQL order to REST format', () => {
      const graphqlOrder = {
        id: 'gid://shopify/Order/789',
        legacyResourceId: '789',
        name: '#1001',
        email: 'test@example.com',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        processedAt: '2024-01-01T00:00:00Z',
        confirmed: true,
        closed: false,
        tags: ['test'],
        totalPriceSet: {
          shopMoney: {
            amount: '100.00',
            currencyCode: 'USD'
          }
        },
        subtotalPriceSet: {
          shopMoney: {
            amount: '90.00',
            currencyCode: 'USD'
          }
        },
        totalTaxSet: {
          shopMoney: {
            amount: '10.00',
            currencyCode: 'USD'
          }
        },
        totalDiscountsSet: {
          shopMoney: {
            amount: '0.00',
            currencyCode: 'USD'
          }
        },
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'FULFILLED',
        lineItems: {
          edges: []
        },
        fulfillments: [],
        shippingLines: []
      };

      const restOrder = convertGraphQLOrderToREST(graphqlOrder);

      expect(restOrder).toEqual(
        expect.objectContaining({
          id: 789,
          admin_graphql_api_id: 'gid://shopify/Order/789',
          name: '#1001',
          email: 'test@example.com',
          confirmed: true,
          current_total_price: '100.00',
          current_subtotal_price: '90.00',
          current_total_tax: '10.00',
          financial_status: 'paid',
          fulfillment_status: 'fulfilled'
        })
      );
    });
  });
});