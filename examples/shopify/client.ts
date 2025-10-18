import { shopify } from "./config";
import { db } from "@/db/drizzle";
import { shopifyIntegrations } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { ApiVersion, Session } from "@shopify/shopify-api";

export interface ShopifyClient {
  rest: any;
  graphql: any;
}

// Get Shopify integration for an organization
export async function getShopifyIntegration(organizationId: string) {
  const integration = await db
    .select()
    .from(shopifyIntegrations)
    .where(
      and(
        eq(shopifyIntegrations.organizationId, organizationId),
        eq(shopifyIntegrations.isActive, true)
      )
    )
    .limit(1);

  return integration[0];
}

// Create a Shopify client for a specific organization
export async function createShopifyClient(organizationId: string): Promise<ShopifyClient | null> {
  const integration = await getShopifyIntegration(organizationId);

  if (!integration) {
    return null;
  }

  // Create a session from stored integration data
  const session: Session = {
    id: `${organizationId}_${integration.shopDomain}`,
    shop: integration.shopDomain,
    state: "",
    isOnline: false,
    accessToken: integration.accessToken,
    scope: integration.scope,
  };

  // Create REST and GraphQL clients
  const restClient = new shopify.clients.Rest({
    session,
    apiVersion: ApiVersion.October24,
  });

  const graphqlClient = new shopify.clients.Graphql({
    session,
    apiVersion: ApiVersion.October24,
  });

  return {
    rest: restClient,
    graphql: graphqlClient,
  };
}

// Verify webhook signature
export function verifyWebhook(rawBody: string, signature: string): boolean {
  try {
    // Get the webhook secret from environment variable
    // For webhooks, use SHOPIFY_API_SECRET (API Secret Key) or SHOPIFY_WEBHOOK_SECRET
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_PARTNER_CLIENT_SECRET;

    if (!webhookSecret) {
      console.error("❌ [SHOPIFY-WEBHOOK] No webhook secret configured");
      console.error("❌ [SHOPIFY-WEBHOOK] Please set SHOPIFY_WEBHOOK_SECRET or SHOPIFY_PARTNER_CLIENT_SECRET environment variable");

      // Log to Sentry for production monitoring
      import('@sentry/nextjs').then(Sentry => {
        Sentry.captureMessage('Shopify webhook secret not configured', {
          level: 'error',
          tags: { component: 'shopify-webhook' }
        });
      }).catch(() => {
        // Sentry import failed, continue
      });

      return false;
    }

    // For Shopify API v6+, we'll use manual HMAC validation
    // as the validate method signature has changed

    // Manual HMAC validation as fallback
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody, 'utf8')
      .digest('base64');

    const isValid = hash === signature;

    if (!isValid) {
      console.error("❌ [SHOPIFY-WEBHOOK] HMAC verification failed");
      console.error("❌ [SHOPIFY-WEBHOOK] Expected:", hash);
      console.error("❌ [SHOPIFY-WEBHOOK] Received:", signature);
      console.error("❌ [SHOPIFY-WEBHOOK] Body length:", rawBody.length);
      console.error("❌ [SHOPIFY-WEBHOOK] Secret used (first 10 chars):", webhookSecret.substring(0, 10) + '...');
      console.error("❌ [SHOPIFY-WEBHOOK] Body preview (first 100 chars):", rawBody.substring(0, 100));
    } else {
      console.log("✅ [SHOPIFY-WEBHOOK] HMAC verification successful");
    }

    return isValid;
  } catch (error) {
    console.error("❌ [SHOPIFY-WEBHOOK] Webhook verification error:", error);

    // Log to Sentry
    import('@sentry/nextjs').then(Sentry => {
      Sentry.captureException(error, {
        tags: { component: 'shopify-webhook' }
      });
    }).catch(() => {
      // Sentry import failed, continue
    });

    return false;
  }
}

// Register webhooks for an organization
export async function registerWebhooks(organizationId: string) {
  const client = await createShopifyClient(organizationId);
  if (!client) {
    throw new Error("No Shopify integration found");
  }

  const integration = await getShopifyIntegration(organizationId);
  if (!integration) {
    throw new Error("No Shopify integration found");
  }

  const webhookTopics = [
    "orders/create",
    "orders/updated",
    "orders/cancelled",
    "products/create",
    "products/update",
    "products/delete",
  ];

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Configuration flags for webhook handling
  const FORCE_WEBHOOK_OVERRIDE = process.env.FORCE_SHOPIFY_WEBHOOK_OVERRIDE === 'true';
  const CHECK_DUPLICATE_CONNECTIONS = process.env.CHECK_DUPLICATE_SHOPIFY_CONNECTIONS !== 'false' && !FORCE_WEBHOOK_OVERRIDE; // Default to true unless forcing

  if (FORCE_WEBHOOK_OVERRIDE) {
    console.log('🔧 FORCE_SHOPIFY_WEBHOOK_OVERRIDE is enabled - will override all existing webhooks');
  }

  // First, get existing webhooks
  try {
    const existingWebhooks = await client.rest.get({
      path: "webhooks",
    });

    const webhooks = existingWebhooks.body.webhooks || [];

    // Check if webhooks exist for a different URL (indicating another ViolaFlow instance)
    if (CHECK_DUPLICATE_CONNECTIONS) {
      const otherWebhooks = webhooks.filter(
        (webhook: any) => webhook.address && !webhook.address.includes(baseUrl)
      );

      if (otherWebhooks.length > 0) {
        console.error(`⚠️ Shop ${integration.shopDomain} has webhooks registered to another URL:`, otherWebhooks[0].address);
        throw new Error('SHOP_ALREADY_CONNECTED');
      }
    }

    // Delete existing webhooks
    for (const webhook of webhooks) {
      // If forcing override, delete ALL webhooks. Otherwise only delete our own
      if (FORCE_WEBHOOK_OVERRIDE || webhook.address === `${baseUrl}/api/shopify/webhooks`) {
        try {
          await client.rest.delete({
            path: `webhooks/${webhook.id}`,
          });
          console.log(`🗑️ Deleted ${FORCE_WEBHOOK_OVERRIDE ? 'existing' : 'our'} webhook for ${webhook.topic}${webhook.address && FORCE_WEBHOOK_OVERRIDE ? ` (was: ${webhook.address})` : ''}`);
        } catch (deleteError) {
          console.error(`Failed to delete webhook ${webhook.id}:`, deleteError);
        }
      }
    }
  } catch (error: any) {
    if (error.message === 'SHOP_ALREADY_CONNECTED') {
      throw error; // Re-throw to handle in callback
    }
    console.error("Failed to fetch existing webhooks:", error);
  }

  // Now register new webhooks
  for (const topic of webhookTopics) {
    try {
      await client.rest.post({
        path: "webhooks",
        data: {
          webhook: {
            topic,
            address: `${baseUrl}/api/shopify/webhooks`,
            format: "json",
          },
        },
      });
      console.log(`✅ Registered webhook for ${topic}`);
    } catch (error: any) {
      // Check if webhook already exists (in case deletion failed or concurrent registration)
      if (error.response?.body?.errors?.address?.[0]?.includes("already been taken") ||
          error.body?.errors?.address?.[0]?.includes("already been taken")) {
        console.log(`ℹ️ Webhook for ${topic} already exists, skipping`);
      } else {
        console.error(`Failed to register webhook for ${topic}:`, error);
      }
    }
  }
}