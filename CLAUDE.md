# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BullMQ worker service for Bloomwise external integrations. Processes background jobs for:
- Shopify products sync (full, incremental, webhook-triggered)
- Shopify orders sync
- Seal Subscriptions sync

**Tech Stack:**
- BullMQ for job processing
- Redis for queue storage
- Neon PostgreSQL for data persistence
- Drizzle ORM for database queries
- TypeScript + Node.js 20+
- Express + Bull Board for monitoring dashboard

## Essential Commands

```bash
# Development
npm run dev                  # Start worker with hot reload (tsx watch)
npm run type-check           # Run TypeScript type checking (no build)

# Testing
npm run test:connection      # Test Redis and PostgreSQL connectivity
npm run test:enqueue         # Enqueue a test job to verify worker functionality

# Production
npm run build                # Compile TypeScript to dist/
npm start                    # Run compiled worker (node dist/index.js)
```

## Architecture Overview

### Job Processing Flow

1. **Job Enqueueing** (via API or external triggers)
   - Client calls `/api/sync/products` or `/api/sync/orders`
   - API creates a `syncJobs` record in database (status: pending)
   - Job is added to Redis queue via BullMQ

2. **Worker Processing** ([src/queues/shopify-products.ts](src/queues/shopify-products.ts))
   - Worker picks up job from queue
   - Fetches Shopify integration credentials from database
   - Updates syncJob status to "running"
   - Calls sync implementation in [src/lib/sync/products-sync.ts](src/lib/sync/products-sync.ts)
   - Updates syncJob with results (status: completed/failed)

3. **Sync Implementation** ([src/lib/sync/products-sync.ts](src/lib/sync/products-sync.ts))
   - Fetches products from Shopify GraphQL API (paginated, 250 per batch)
   - Transforms Shopify data to database schema
   - Batch upserts to `shopify_products` and `shopify_variants` tables
   - Syncs to internal `products` and `product_variants` tables
   - Updates progress after each batch

### Key Components

**Queue Configuration** ([src/config/queues.ts](src/config/queues.ts))
- Defines all queues: `shopify-products`, `shopify-orders`, `seal-subscriptions`
- Sets retry policy (3 attempts, exponential backoff)
- Configures job retention (100 completed, 500 failed)

**Worker Processors** ([src/queues/](src/queues/))
- Each queue has a dedicated worker file
- Worker concurrency controlled by `WORKER_CONCURRENCY` env var
- Rate limiting: max 10 jobs/second (Shopify API limits)

**Database Schema** ([src/db/schema.ts](src/db/schema.ts))
- `syncJobs` - tracks sync progress and status
- `shopifyIntegrations` - stores Shopify credentials per organization
- `shopifyProducts` - raw Shopify product data
- `shopifyVariants` - raw Shopify variant data
- Schema must match main Bloomwise database exactly

**Shopify GraphQL Client** ([src/lib/shopify/client.ts](src/lib/shopify/client.ts))
- Handles authenticated GraphQL requests
- Auto-retries on rate limits
- Queries defined in [src/lib/shopify/graphql-queries.ts](src/lib/shopify/graphql-queries.ts)

**API Endpoints** ([src/api/routes.ts](src/api/routes.ts))
- `POST /api/sync/products` - enqueue products sync
- `POST /api/sync/orders` - enqueue orders sync
- `GET /api/sync/status/:syncJobId` - check sync job status
- No authentication required for API (internal service)

**Bull Board Dashboard** ([src/dashboard.ts](src/dashboard.ts))
- Runs on port 3001
- Basic auth protected (admin routes only)
- `/health` endpoint (no auth)
- `/admin/queues` - Bull Board UI (requires auth)
- API routes at `/api/*` (no auth)

### Data Flow: Products Sync

```
Client Request → API Route → Create syncJob (DB) → Enqueue to Redis
                                                        ↓
Worker picks job → Fetch credentials → Mark running → Shopify GraphQL API
                                                        ↓
                                      Fetch 250 products (paginated)
                                                        ↓
                            Transform to DB schema → Batch upsert to shopify_products/variants
                                                        ↓
                                      Sync to internal products/product_variants
                                                        ↓
                                      Update syncJob progress (DB)
                                                        ↓
                                      Repeat until no more pages
                                                        ↓
                                      Mark syncJob completed/failed (DB)
```

## Environment Variables

Required (at least one database URL must be set):
- `REDIS_URL` - Redis connection string (format: `redis://default:password@host:6379`)

Database URLs (environment-specific, recommended):
- `DEV_DATABASE_URL` - Development Neon PostgreSQL connection string
- `STAGING_DATABASE_URL` - Staging Neon PostgreSQL connection string
- `PRODUCTION_DATABASE_URL` - Production Neon PostgreSQL connection string
- `DATABASE_URL` - Fallback PostgreSQL connection string (for backward compatibility)

**Environment Detection:**
- API routes detect environment from request headers (origin/referer/host):
  - `dev-local.bloomwise.co` → uses `DEV_DATABASE_URL`
  - `staging.bloomwise.co` → uses `STAGING_DATABASE_URL`
  - `app.bloomwise.co` → uses `PRODUCTION_DATABASE_URL`
- Workers read environment from job data (passed when job is enqueued)
- CLI scripts use `ENVIRONMENT` env var (`dev`, `staging`, or `production`)
- Falls back gracefully if specific environment DB not configured

Optional:
- `NODE_ENV` - Environment (development/production) - affects logging format only
- `LOG_LEVEL` - Logging level (debug/info/warn/error)
- `WORKER_CONCURRENCY` - Number of concurrent jobs per worker (default: 5)
- `WORKER_MAX_RETRIES` - Max retry attempts per job (default: 3)
- `BULL_BOARD_PORT` - Dashboard port (default: 3001)
- `BULL_BOARD_USERNAME` - Dashboard username (default: admin)
- `BULL_BOARD_PASSWORD` - Dashboard password (default: admin)
- `ENVIRONMENT` - Force environment for CLI scripts (`dev`, `staging`, `production`)

## Database Patterns

**Writing Batch Upserts:**
Use Drizzle's `onConflictDoUpdate` with `sql` for proper column references:

```typescript
await db
  .insert(shopifyProducts)
  .values(productsArray)
  .onConflictDoUpdate({
    target: [shopifyProducts.organizationId, shopifyProducts.shopifyProductId],
    set: {
      title: sql`excluded.title`,
      bodyHtml: sql`excluded.body_html`,
      // ... other fields
      updatedAt: new Date(),
    },
  });
```

**Important:** Use `sql` template for excluded columns to avoid Drizzle conflicts. Use regular values for computed fields like timestamps.

## Common Patterns

**Job Processing Structure:**
```typescript
async function processJob(job: Job<JobDataType>) {
  const jobLogger = createJobLogger(job.id!, organizationId);

  try {
    // 1. Verify database records
    // 2. Fetch credentials/config
    // 3. Mark job running
    // 4. Execute main logic
    // 5. Mark job completed
    return result;
  } catch (error) {
    // Mark job failed in DB
    await markSyncJobFailed(syncJobId, errorMessage, error);
    throw error; // Let BullMQ handle retries
  }
}
```

**Logging:**
- Use structured logging via Pino
- Include context: `jobId`, `organizationId`, `syncJobId`
- Job-specific logger: `createJobLogger(jobId, organizationId)`

**Error Handling:**
- Always mark syncJob as failed in database before rethrowing
- Let BullMQ handle retries (configured in queue options)
- Log errors with full context

## Deployment

**Platform:** Dokploy (Docker-based)

**Docker Build:**
- Multi-stage build for optimization
- Runs as non-root user (nodejs:nodejs)
- Health check on port 3001
- Uses dumb-init for signal handling

**CI/CD:**
GitHub Actions workflow ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) automatically builds and deploys on push to main:
1. Builds Docker image with buildx and pushes to GitHub Container Registry (GHCR)
2. Tags: `latest`, `main`, `main-{sha}`
3. Uses GitHub Actions cache for faster builds
4. Triggers Dokploy deployment via webhook

**Required GitHub Secrets:**
- `DOKPLOY_WEBHOOK_URL` - Dokploy deployment webhook URL (e.g., `https://your-domain.com/api/deploy/WEBHOOK_ID`)

**Image Location:**
- Registry: `ghcr.io`
- Image: `ghcr.io/{username}/bloomwise-bullmq:latest`
- Requires Dokploy to be configured to pull from GHCR

**Manual Deployment:**
```bash
# Trigger workflow manually from GitHub Actions tab
# Or push to main/master branch to auto-deploy
```

**Monitoring:**
- Bull Board dashboard: `https://jobs.bloomwise.co`
- Health endpoint: `/health`
- Structured JSON logs in Dokploy console

## Development Notes

**Adding a New Queue/Worker:**
1. Define queue in [src/config/queues.ts](src/config/queues.ts)
2. Create job data interface
3. Create worker file in `src/queues/` (e.g., `shopify-orders.ts`)
4. Implement processor function
5. Export worker instance
6. Import and initialize in [src/index.ts](src/index.ts)
7. Add to Bull Board in [src/dashboard.ts](src/dashboard.ts)

**Adding New Shopify GraphQL Queries:**
1. Define query in [src/lib/shopify/graphql-queries.ts](src/lib/shopify/graphql-queries.ts)
2. Use `executeGraphQLQuery<ResponseType>()` from client
3. Always handle pagination with `pageInfo.hasNextPage`
4. Respect rate limits (250ms delay between batches)

**Database Schema Changes:**
- Schema in this repo must match main Bloomwise database
- Never modify schema here - changes happen in main app
- Update [src/db/schema.ts](src/db/schema.ts) to match after migrations
