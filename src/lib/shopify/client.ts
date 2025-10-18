/**
 * Shopify GraphQL Client for Worker
 * Simplified version without Next.js dependencies
 */

import { logger } from '../utils/logger';

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

export interface ShopifyClientConfig {
  shopDomain: string;
  accessToken: string;
}

/**
 * Execute a GraphQL query against Shopify Admin API
 */
export async function executeGraphQLQuery<T>(
  config: ShopifyClientConfig,
  query: string,
  variables?: Record<string, any>,
  retryCount: number = 0
): Promise<GraphQLResponse<T>> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_BASE = 1000;

  const { shopDomain, accessToken } = config;
  const graphqlEndpoint = `https://${shopDomain}/admin/api/2024-10/graphql.json`;

  try {
    const response = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query,
        variables: variables || {},
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    // Log query cost if available
    if (result.extensions?.cost) {
      logger.debug(
        {
          cost: result.extensions.cost,
          shopDomain,
        },
        'GraphQL query cost'
      );
    }

    // Check for GraphQL errors
    if (result.errors && result.errors.length > 0) {
      const errorMessages = result.errors.map((e: any) => e.message).join(', ');
      throw new Error(`GraphQL errors: ${errorMessages}`);
    }

    return result as GraphQLResponse<T>;
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if this is a rate limit error
    const isRateLimitError =
      errorMessage.toLowerCase().includes('throttled') ||
      errorMessage.includes('429') ||
      errorMessage.toLowerCase().includes('rate limit');

    const isRetryableError =
      isRateLimitError ||
      errorMessage.toLowerCase().includes('timeout') ||
      errorMessage.toLowerCase().includes('network');

    if (isRetryableError && retryCount < MAX_RETRIES) {
      let retryDelay: number;
      if (isRateLimitError) {
        retryDelay = retryCount === 0 ? 2000 : retryCount === 1 ? 5000 : 10000;
        logger.warn(
          { retryCount, retryDelay, shopDomain },
          'Shopify rate limit hit, retrying...'
        );
      } else {
        retryDelay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
        logger.warn(
          { retryCount, retryDelay, error: errorMessage },
          'Retryable error, retrying...'
        );
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return executeGraphQLQuery<T>(config, query, variables, retryCount + 1);
    }

    logger.error(
      { error, shopDomain, retryCount, queryExcerpt: query.substring(0, 200) },
      'GraphQL query failed'
    );

    throw error;
  }
}
