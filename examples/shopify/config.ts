import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion, Shopify } from "@shopify/shopify-api";
import * as Sentry from "@sentry/nextjs";

// Lazy initialization - only create client when actually used (not at build time)
let shopifyInstance: Shopify | null = null;
let validationLogged = false;

/**
 * Validate required Shopify environment variables
 * Logs detailed errors to help debug missing configuration
 */
function validateShopifyEnvVars(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requiredVars = {
    SHOPIFY_PARTNER_CLIENT_ID: process.env.SHOPIFY_PARTNER_CLIENT_ID,
    SHOPIFY_PARTNER_CLIENT_SECRET: process.env.SHOPIFY_PARTNER_CLIENT_SECRET,
  };

  for (const [key, value] of Object.entries(requiredVars)) {
    if (!value) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  if (errors.length > 0 && !validationLogged) {
    validationLogged = true;
    console.error('❌ [SHOPIFY-CONFIG] Missing Shopify configuration:');
    errors.forEach(err => console.error(`   - ${err}`));
    console.error('   Please ensure these environment variables are set in your .env.local or Vercel environment');

    // Log to Sentry for production monitoring
    Sentry.captureMessage('Shopify configuration missing', {
      level: 'error',
      tags: { component: 'shopify-config' },
      extra: { errors, env: process.env.NODE_ENV }
    });
  }

  return { valid: errors.length === 0, errors };
}

export const shopify = new Proxy({} as Shopify, {
  get(_, prop) {
    if (!shopifyInstance) {
      // Validate environment variables before creating instance
      const validation = validateShopifyEnvVars();

      if (!validation.valid) {
        const errorMsg = `Shopify client initialization failed: ${validation.errors.join(', ')}`;
        console.error(`❌ [SHOPIFY-CONFIG] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      console.log('✅ [SHOPIFY-CONFIG] Environment variables validated, initializing Shopify client');

      shopifyInstance = shopifyApi({
        apiKey: process.env.SHOPIFY_PARTNER_CLIENT_ID!,
        apiSecretKey: process.env.SHOPIFY_PARTNER_CLIENT_SECRET!,
        scopes: [
          "read_orders",
          "write_orders",
          "read_products",
          "write_products",
          "read_inventory",
          "write_inventory",
          "read_customers",
        ],
        hostName: process.env.SHOPIFY_APP_URL?.replace(/^https?:\/\//, "") || "localhost:3000",
        apiVersion: ApiVersion.October24,
        isEmbeddedApp: false, // Since we're building a standalone integration
      });

      console.log('✅ [SHOPIFY-CONFIG] Shopify client initialized successfully');
    }
    return (shopifyInstance as any)[prop];
  },
});

// Helper to get the OAuth redirect URL
export function getShopifyAuthUrl() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/shopify/auth/callback`;
}

// Helper to get webhook URL
export function getWebhookUrl(topic: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/shopify/webhooks/${topic}`;
}