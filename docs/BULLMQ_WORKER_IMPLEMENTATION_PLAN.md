# BullMQ Worker Service Implementation Plan

**Document Version**: 1.0
**Date**: 2025-10-17
**Purpose**: Migrate external integration syncs (Shopify, Seal Subscriptions, future platforms) from Next.js API routes to a dedicated BullMQ worker service hosted on Dokploy.

---

## Executive Summary

This plan outlines the architecture and implementation steps for moving bloomwise's external integration syncs from synchronous Next.js API routes to an asynchronous BullMQ-based job queue system. The worker service will run on Dokploy alongside a Redis instance, providing better reliability, scalability, and visibility for long-running sync operations.

**Key Benefits**:
- No timeout constraints (Vercel has 10s/60s limits)
- Automatic retry logic for failed jobs
- Real-time progress tracking and monitoring
- Independent scaling of web app and background workers
- Better resource utilization and cost efficiency

---

## Architecture Overview

### Current State
- Sync jobs run directly in Next.js API routes (`/api/cron/sync-shopify-products`, `/api/shopify/sync/active`)
- Triggered by Vercel Cron or external schedulers
- Process synchronously within request timeout limits
- Job tracking in `syncJobs` table in Neon PostgreSQL
- Credentials stored in `shopifyIntegrations` table

### Target State
- Next.js API routes become job **enqueuers** (lightweight, fast response)
- BullMQ worker service on Dokploy **processes** jobs (no timeout limits)
- Redis on Dokploy stores job queues and state
- Worker fetches credentials from Neon (no secrets duplication)
- Same `syncJobs` table tracks progress (worker updates it)

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Next.js Application                      │
│                        (Vercel)                              │
│  - User requests                                             │
│  - Webhook receivers (Shopify, Seal)                        │
│  - Job enqueuers (create syncJob + enqueue to Redis)       │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/Network
                       │ Enqueue job via REST API or direct Redis
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      Redis Instance                          │
│                       (Dokploy)                              │
│  - BullMQ job queues                                        │
│  - Job state and progress                                   │
│  - Queue priorities and scheduling                          │
│  - Failed job tracking                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ BullMQ protocol
                       │ Worker polls for jobs
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  BullMQ Worker Service                       │
│                       (Dokploy)                              │
│  - Processes jobs from Redis queues                         │
│  - Fetches integration credentials from Neon                │
│  - Executes sync logic (imported from bloomwise codebase)  │
│  - Updates syncJobs table with progress                     │
│  - Reports completion/failure back to Redis                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ PostgreSQL protocol
                       │ Read credentials, write progress
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Neon PostgreSQL                           │
│  - shopifyIntegrations (credentials: accessToken, shopDomain)│
│  - sealIntegrations (credentials: apiKey)                   │
│  - syncJobs (job tracking and progress)                     │
│  - All business data (orders, products, etc.)               │
└─────────────────────────────────────────────────────────────┘

Optional:
┌─────────────────────────────────────────────────────────────┐
│              Bull Board Dashboard (Dokploy)                  │
│  - Web UI for monitoring queues                             │
│  - View job status, retries, failures                       │
│  - Manually retry failed jobs                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Implementation Plan

### Phase 1: Infrastructure Setup on Dokploy

#### 1.1 Deploy Redis Instance

**Service Configuration**:
- **Name**: `bloomwise-redis`
- **Image**: `redis:7-alpine` (latest stable)
- **Resources**:
  - Memory: 512MB (start small, scale if needed)
  - CPU: 0.5 cores
  - Persistent volume: 1GB (for Redis persistence)
- **Network**:
  - Internal Dokploy network (not exposed to internet)
  - Port: 6379 (default)
  - Connection string: `redis://bloomwise-redis:6379`

**Redis Configuration** (via redis.conf or command args):
- Enable AOF (Append-Only File) persistence for durability
- Set maxmemory policy: `allkeys-lru` (evict least recently used)
- Enable keyspace notifications: `Kx$` (for BullMQ to track expirations)

**Health Check**:
- Command: `redis-cli ping` should return `PONG`
- Interval: 10s
- Timeout: 5s
- Retries: 3

**Backup Strategy**:
- AOF file persisted to Dokploy volume
- Optional: Daily snapshots to object storage (S3/R2)

---

#### 1.2 Deploy BullMQ Worker Service

**Service Configuration**:
- **Name**: `bloomwise-worker`
- **Base Image**: `node:20-alpine` (match bloomwise's Node version)
- **Resources**:
  - Memory: 1GB (start small, scale based on job volume)
  - CPU: 1 core
  - Auto-restart: Always (critical for job processing)
- **Network**:
  - Internal Dokploy network
  - Must be able to reach:
    - Redis (internal)
    - Neon PostgreSQL (external via DATABASE_URL)
    - Shopify API (external, HTTPS)

**Environment Variables**:
```bash
# Database
DATABASE_URL=<Neon PostgreSQL connection string>

# Redis
REDIS_URL=redis://bloomwise-redis:6379

# Application
NODE_ENV=production
LOG_LEVEL=info

# Shopify (for rate limiting, app verification)
SHOPIFY_APP_KEY=<from bloomwise env>
SHOPIFY_APP_SECRET=<from bloomwise env>

# Optional: Sentry for error tracking
SENTRY_DSN=<from bloomwise env>

# Optional: Monitoring
WORKER_CONCURRENCY=5  # How many jobs to process simultaneously
WORKER_MAX_RETRIES=3  # Max retries per failed job
WORKER_RETRY_BACKOFF=exponential  # exponential or fixed
```

**Dependencies** (package.json):
- `bullmq` - Job queue library
- `ioredis` - Redis client (BullMQ dependency)
- `drizzle-orm` - Database ORM (to access Neon)
- `@neondatabase/serverless` - Neon PostgreSQL driver
- `dotenv` - Environment variable management
- `tsx` - TypeScript execution (or compile to JS)

**Health Check**:
- Endpoint: `GET /health` (simple Express server on port 3001)
- Returns: `{ status: 'ok', redis: 'connected', db: 'connected' }`
- Interval: 30s

**Logging**:
- Structured JSON logs (stdout)
- Log levels: error, warn, info, debug
- Include: `jobId`, `organizationId`, `integrationType`, `timestamp`
- Consider shipping logs to Loki/Grafana or Datadog

---

#### 1.3 (Optional) Deploy Bull Board Dashboard

**Service Configuration**:
- **Name**: `bloomwise-bull-board`
- **Image**: Custom Node.js app with Bull Board
- **Resources**: Minimal (256MB RAM, 0.25 CPU)
- **Network**:
  - Exposed to internet via Dokploy reverse proxy
  - URL: `https://jobs.bloomwise.com` or `https://worker-dashboard.bloomwise.com`
- **Authentication**: Basic auth or OAuth (to prevent unauthorized access)

**Features**:
- View all queues (shopify-products, shopify-orders, seal-subscriptions)
- See job counts: waiting, active, completed, failed
- Inspect individual jobs (data, logs, stack traces)
- Manually retry failed jobs
- Pause/resume queues

---

### Phase 2: Worker Service Implementation

#### 2.1 Project Structure

Recommended repository structure for the worker service:

```
bloomwise-worker/
├── package.json
├── tsconfig.json
├── .env.example
├── Dockerfile
├── src/
│   ├── index.ts                    # Entry point
│   ├── config/
│   │   ├── database.ts              # Drizzle setup
│   │   ├── redis.ts                 # Redis connection
│   │   └── queues.ts                # Queue definitions
│   ├── queues/
│   │   ├── shopify-products.ts      # Product sync queue processor
│   │   ├── shopify-orders.ts        # Order sync queue processor
│   │   ├── seal-subscriptions.ts    # Seal sync queue processor
│   │   └── index.ts                 # Export all queue processors
│   ├── lib/
│   │   ├── sync/                    # Sync logic (imported from bloomwise)
│   │   │   ├── products-sync-graphql.ts
│   │   │   ├── orders-sync-graphql.ts
│   │   │   └── shopify-products-to-internal.ts
│   │   ├── shopify/
│   │   │   ├── graphql-client.ts
│   │   │   └── client.ts
│   │   └── utils/
│   │       ├── logger.ts
│   │       └── error-handler.ts
│   ├── db/
│   │   └── schema.ts                # Drizzle schema (subset needed by worker)
│   └── health.ts                    # Health check server
├── scripts/
│   ├── test-connection.ts           # Test Redis + DB connections
│   └── enqueue-test-job.ts          # Manual job enqueuing for testing
└── README.md
```

**Key Design Decisions**:
- **Code Sharing**: Import sync logic from bloomwise via npm package or git submodule
  - Option A: Publish `@bloomwise/sync-lib` as private npm package
  - Option B: Git submodule pointing to `bloomwise/lib/sync`
  - Option C: Copy-paste (not recommended, creates drift)
- **Schema Sharing**: Only include tables needed by worker (shopifyIntegrations, syncJobs, orders, products)
- **Minimal Dependencies**: Keep worker lean - only production sync dependencies

---

#### 2.2 Queue Definitions

**Queue 1: Shopify Products Sync**
- **Name**: `shopify-products`
- **Job Data**:
  ```typescript
  {
    syncJobId: string;           // UUID from syncJobs table
    organizationId: string;      // UUID
    integrationId: string;       // UUID from shopifyIntegrations
    type: 'full' | 'incremental' | 'single'; // Sync type
    productId?: string;          // For single product sync (webhook)
    cursor?: string;             // For incremental sync
  }
  ```
- **Concurrency**: 2-5 jobs (based on Shopify rate limits)
- **Timeout**: 30 minutes per job
- **Retry**: 3 attempts with exponential backoff (1s, 10s, 60s)
- **Priority**: Webhook-triggered (priority 1) > Scheduled (priority 10)

**Queue 2: Shopify Orders Sync**
- **Name**: `shopify-orders`
- **Job Data**: Same structure as products
- **Concurrency**: 2-5 jobs
- **Timeout**: 30 minutes
- **Retry**: 3 attempts
- **Priority**: Webhook > Scheduled

**Queue 3: Seal Subscriptions Sync**
- **Name**: `seal-subscriptions`
- **Job Data**:
  ```typescript
  {
    syncJobId: string;
    organizationId: string;
    integrationId: string;       // From sealIntegrations table
    type: 'subscriptions' | 'orders' | 'customers';
  }
  ```
- **Concurrency**: 3 jobs
- **Timeout**: 20 minutes
- **Retry**: 3 attempts

**Future Queues** (reserved for later):
- `email-notifications` - Send transactional emails
- `report-generation` - Generate PDF reports
- `inventory-updates` - Batch inventory adjustments
- `customer-metrics` - Recalculate customer LTV/metrics

---

#### 2.3 Job Processing Logic

**High-Level Flow** (applies to all sync jobs):

1. **Job Received**:
   - Worker picks up job from Redis queue
   - Log job start with `jobId`, `organizationId`

2. **Fetch Credentials**:
   - Query `shopifyIntegrations` table using `integrationId`
   - Extract `accessToken`, `shopDomain` from database
   - No secrets in job data or Redis (security best practice)

3. **Update Sync Job Status**:
   - Set `syncJobs.status = 'in_progress'`
   - Set `syncJobs.startedAt = now()`
   - Log: "Starting sync for org X, integration Y"

4. **Execute Sync**:
   - Call existing sync function (e.g., `syncShopifyProducts()`)
   - Pass credentials, organizationId, syncJobId
   - Monitor progress (BullMQ provides `job.progress()` method)

5. **Progress Updates**:
   - Every 100 items processed, update:
     - `syncJobs.itemsProcessed = X`
     - `job.progress(X / totalItems * 100)` (for Bull Board)
   - Log: "Processed X/Y items"

6. **Handle Completion**:
   - **Success**:
     - Set `syncJobs.status = 'completed'`
     - Set `syncJobs.completedAt = now()`
     - Set `syncJobs.itemsProcessed = totalItems`
     - Log: "Sync completed successfully"
   - **Failure**:
     - Set `syncJobs.status = 'failed'`
     - Set `syncJobs.errorMessage = error.message`
     - Set `syncJobs.failedAt = now()`
     - Log error with stack trace
     - Let BullMQ retry (if attempts remain)

7. **Cleanup**:
   - Close Shopify client connections
   - Free memory
   - Mark BullMQ job as complete or failed

---

#### 2.4 Error Handling Strategy

**Transient Errors** (should retry):
- Network timeouts
- Shopify rate limit errors (429)
- Database connection errors
- Redis connection errors

**Permanent Errors** (should NOT retry):
- Invalid credentials (401 Unauthorized)
- Integration not found in database
- Shopify store uninstalled
- Invalid job data

**Retry Configuration**:
- **Attempts**: 3 (initial + 2 retries)
- **Backoff**: Exponential
  - Attempt 1: Immediate
  - Attempt 2: 10 seconds delay
  - Attempt 3: 60 seconds delay
- **Dead Letter Queue**: Failed jobs after 3 attempts go to `{queueName}-failed` queue
- **Manual Review**: Admin can inspect and retry via Bull Board

**Error Logging**:
- All errors logged with full context (organizationId, integrationId, jobId)
- Critical errors sent to Sentry
- Failed jobs trigger alerts (email/Slack) for admin

---

#### 2.5 Rate Limiting

**Shopify API Limits**:
- REST API: 2 requests/second (legacy, not used)
- GraphQL API: 1000 points/second (bucket-based)
- Each query costs points based on complexity

**Implementation**:
- Use BullMQ's built-in rate limiter:
  ```typescript
  {
    limiter: {
      max: 10,        // Max 10 jobs
      duration: 1000  // Per 1 second
    }
  }
  ```
- Or implement token bucket in Shopify client (already exists in bloomwise)

**Strategy**:
- Process jobs sequentially per organization (avoid hitting same store in parallel)
- Use BullMQ's `concurrency` setting per queue
- Backoff on 429 errors (Shopify returns `Retry-After` header)

---

### Phase 3: Next.js Integration Changes

#### 3.1 Install BullMQ Client in Next.js

**Dependencies**:
- `bullmq` - For enqueuing jobs
- `ioredis` - Redis client

**Configuration** (`lib/queue/client.ts`):
- Create Redis connection to Dokploy Redis
- Initialize queue clients (shopify-products, shopify-orders, seal-subscriptions)
- Export helper functions: `enqueueShopifyProductsSync()`, `enqueueShopifyOrdersSync()`

**Connection String**:
- Development: `redis://localhost:6379` (local Redis for testing)
- Production: `redis://<dokploy-redis-ip>:6379` (or use Tailscale/VPN for security)

**Security Consideration**:
- Redis is currently unauthenticated (Dokploy internal network)
- For production, enable Redis AUTH: `REDIS_PASSWORD=<strong-password>`
- Update connection string: `redis://:password@host:6379`

---

#### 3.2 Update API Routes to Enqueue Jobs

**Example: `/api/shopify/sync/active/route.ts`**

**Before** (current implementation):
```
POST /api/shopify/sync/active
→ Fetch shopifyIntegrations
→ Call syncShopifyProducts() directly
→ Wait for completion (timeout risk)
→ Return result
```

**After** (with BullMQ):
```
POST /api/shopify/sync/active
→ Fetch shopifyIntegrations
→ Create syncJob record in database (status: 'pending')
→ Enqueue job to Redis (shopify-products queue)
→ Return immediately { syncJobId, status: 'pending' }
```

**Key Changes**:
- Remove direct call to sync functions
- Add call to `enqueueShopifyProductsSync()`
- Return `syncJobId` to client for polling
- Response time: <500ms (was 10-60s before)

**Similar Updates Needed**:
- `/api/cron/sync-shopify-products/route.ts` - Enqueue instead of process
- `/api/cron/sync-shopify-orders/route.ts` - Enqueue instead of process
- `/api/shopify/sync/orders/route.ts` - Enqueue instead of process
- `/api/shopify/webhooks/route.ts` - Enqueue single-item sync jobs (high priority)

---

#### 3.3 Add Job Status Polling Endpoint

**New Endpoint**: `GET /api/sync-jobs/[id]/status`

**Purpose**: Allow UI to poll sync job progress

**Response**:
```json
{
  "id": "uuid",
  "status": "in_progress",
  "type": "shopify_products",
  "organizationId": "uuid",
  "startedAt": "2025-10-17T10:30:00Z",
  "itemsProcessed": 250,
  "itemsTotal": 1000,
  "progress": 25,
  "errorMessage": null
}
```

**Implementation**:
- Query `syncJobs` table by ID
- Verify organizationId matches current user
- Return current status

**Frontend Integration**:
- After triggering sync, poll this endpoint every 2 seconds
- Show progress bar: `itemsProcessed / itemsTotal`
- Display status: "Syncing products... 250/1000"
- On completion, show success/failure message

---

#### 3.4 Update Webhook Handlers

**Shopify Webhooks** (currently trigger immediate sync):

**Before**:
```
Webhook: products/update
→ Find shopifyIntegrations
→ Sync single product immediately
→ Risk: slow response, webhook timeout
```

**After**:
```
Webhook: products/update
→ Find shopifyIntegrations
→ Enqueue high-priority job { type: 'single', productId: '...' }
→ Return 200 OK immediately (<200ms)
→ Worker processes in background
```

**Benefits**:
- Webhook never times out
- Shopify receives fast 200 OK response
- Single product syncs processed within seconds (high priority)

**Webhooks to Update**:
- `products/create`, `products/update`, `products/delete`
- `orders/create`, `orders/updated`, `orders/cancelled`

---

### Phase 4: Monitoring and Observability

#### 4.1 Metrics to Track

**Queue Metrics** (via Bull Board or custom):
- Jobs waiting per queue
- Jobs active per queue
- Jobs completed (last hour, day, week)
- Jobs failed (last hour, day, week)
- Average job duration
- Job throughput (jobs/minute)

**Sync Metrics** (via syncJobs table):
- Total syncs per organization (last 30 days)
- Success rate per integration type
- Average sync duration
- Items synced per sync (products, orders)

**Infrastructure Metrics** (via Dokploy/Grafana):
- Redis memory usage
- Worker CPU/memory usage
- Redis connection count
- Worker restarts (indicates crashes)

---

#### 4.2 Alerting

**Critical Alerts** (immediate notification):
- Worker service down (health check failing)
- Redis down (connection errors)
- High failure rate (>10% jobs failing)
- Queue backlog (>1000 waiting jobs)

**Warning Alerts** (review within 24h):
- Job taking longer than expected (>30min)
- Retry rate increasing
- Redis memory >80%

**Notification Channels**:
- Email to ops team
- Slack channel (#alerts or #ops)
- PagerDuty (for critical issues)

---

#### 4.3 Logging Best Practices

**Structured Logging**:
```json
{
  "timestamp": "2025-10-17T10:30:00Z",
  "level": "info",
  "service": "bloomwise-worker",
  "queue": "shopify-products",
  "jobId": "job-123",
  "organizationId": "org-456",
  "integrationId": "int-789",
  "message": "Starting product sync",
  "meta": {
    "shopDomain": "example.myshopify.com",
    "syncType": "full"
  }
}
```

**Log Aggregation**:
- Ship logs to centralized service (Loki, Datadog, CloudWatch)
- Searchable by organizationId, integrationId, jobId
- Retention: 30 days

---

### Phase 5: Testing and Deployment

#### 5.1 Local Development Setup

**Run Redis Locally**:
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

**Run Worker Locally**:
```bash
cd bloomwise-worker
npm install
cp .env.example .env
# Edit .env with DATABASE_URL and REDIS_URL
npm run dev
```

**Trigger Test Job**:
```bash
# From Next.js app
npm run test:enqueue-job
# Or via curl
curl -X POST http://localhost:3000/api/shopify/sync/active \
  -H "Authorization: Bearer ..." \
  -d '{"integrationType": "shopify"}'
```

**Verify Job Processing**:
- Check worker logs for job pickup
- Query `syncJobs` table for status
- Open Bull Board: http://localhost:3001/admin/queues

---

#### 5.2 Testing Checklist

**Unit Tests**:
- [ ] Queue configuration loads correctly
- [ ] Job data validation works
- [ ] Credentials fetched from database correctly
- [ ] Error handling for missing integration
- [ ] Retry logic triggers on transient errors

**Integration Tests**:
- [ ] Job enqueued from Next.js appears in Redis
- [ ] Worker picks up job from Redis
- [ ] Worker updates syncJobs table
- [ ] Progress updates reflected in database
- [ ] Failed jobs retry correctly
- [ ] Completed jobs marked as done

**End-to-End Tests**:
- [ ] Full Shopify product sync completes successfully
- [ ] Full Shopify order sync completes successfully
- [ ] Webhook-triggered single product sync works
- [ ] Multiple organizations can sync concurrently
- [ ] Rate limiting prevents Shopify 429 errors
- [ ] Failed sync can be manually retried via Bull Board

**Load Tests**:
- [ ] Worker handles 100 concurrent jobs
- [ ] Redis memory usage stays below 80%
- [ ] Worker CPU/memory usage acceptable
- [ ] No memory leaks after 1000+ jobs

---

#### 5.3 Deployment Steps

**Step 1: Deploy Redis on Dokploy**
1. Create new service: `bloomwise-redis`
2. Use `redis:7-alpine` image
3. Configure persistent volume
4. Set resource limits
5. Verify health check passes
6. Note internal connection string

**Step 2: Build and Deploy Worker**
1. Build Docker image for worker
2. Push to registry (Docker Hub, GitHub Container Registry, or Dokploy's registry)
3. Create Dokploy service: `bloomwise-worker`
4. Set environment variables (DATABASE_URL, REDIS_URL, etc.)
5. Configure health check
6. Deploy and verify startup logs

**Step 3: Deploy Bull Board (Optional)**
1. Build Bull Board Docker image
2. Deploy as Dokploy service
3. Configure reverse proxy (HTTPS)
4. Set up authentication (basic auth)
5. Test access via `https://jobs.bloomwise.com`

**Step 4: Update Next.js**
1. Add BullMQ client dependencies
2. Update API routes to enqueue jobs
3. Deploy Next.js to staging
4. Test one sync end-to-end
5. Monitor for errors
6. Deploy to production

**Step 5: Gradual Rollout**
1. Enable for 1 test organization
2. Run full sync, verify success
3. Enable for 10% of organizations
4. Monitor for 24 hours
5. Enable for 50% of organizations
6. Monitor for 48 hours
7. Enable for 100% of organizations

---

### Phase 6: Maintenance and Operations

#### 6.1 Runbooks

**Runbook 1: Worker Service Down**
1. Check Dokploy logs: `docker logs bloomwise-worker`
2. Check health endpoint: `curl http://bloomwise-worker:3001/health`
3. Verify Redis connection: `redis-cli -h bloomwise-redis ping`
4. Restart service: Dokploy UI → Restart
5. Check for errors in Sentry
6. If persistent, scale down concurrency in env vars

**Runbook 2: Queue Backlog Growing**
1. Check Bull Board for job counts
2. Identify slow jobs (>10min duration)
3. Check Shopify API status (status.shopify.com)
4. Check worker CPU/memory (may need scaling)
5. Temporarily increase concurrency or add worker instances
6. If jobs failing, check error logs

**Runbook 3: Failed Job Investigation**
1. Open Bull Board, find failed job
2. Review error message and stack trace
3. Check if transient (network error) or permanent (bad data)
4. If transient, manually retry
5. If permanent, fix root cause and re-enqueue
6. Update error handling to prevent recurrence

**Runbook 4: Sync Taking Too Long**
1. Check syncJobs table for stuck jobs (status=in_progress, >1hr old)
2. Find corresponding BullMQ job ID
3. Check worker logs for that job
4. If hanging, kill job and restart worker
5. Investigate root cause (API slowness, infinite loop, etc.)
6. Add timeout to prevent future hangs

---

#### 6.2 Performance Tuning

**Worker Scaling**:
- Start with 1 worker instance (1 core, 1GB RAM)
- If queue backlog grows:
  - Increase concurrency (5 → 10 jobs per worker)
  - Or add more worker instances (horizontal scaling)
- Monitor Redis CPU/memory (should stay <50%)

**Redis Scaling**:
- Start with 512MB RAM
- If memory >80%, upgrade to 1GB
- If evicting keys (check `evicted_keys` metric), increase memory

**Database Connection Pooling**:
- Worker uses connection pool (10 connections max)
- If hitting connection limit, tune pool size
- Monitor Neon connection count

**Job Batching**:
- Instead of 1 job per product (webhook), batch updates every 1 minute
- Reduces job overhead, improves throughput
- Trade-off: slight delay in processing webhooks

---

#### 6.3 Cost Estimation

**Monthly Costs** (Dokploy hosted):

| Component | Specs | Monthly Cost |
|-----------|-------|--------------|
| Redis | 512MB RAM, 1 CPU | ~$10 |
| Worker (1 instance) | 1GB RAM, 1 CPU | ~$15 |
| Bull Board (optional) | 256MB RAM, 0.25 CPU | ~$5 |
| Dokploy infrastructure | Shared | $0 (already paying) |
| **Total** | | **$30/mo** |

**Scaling Costs**:
- +1 worker instance: +$15/mo
- Redis upgraded to 1GB: +$5/mo
- At 10 organizations with active syncs: $30-50/mo
- At 100 organizations: $100-150/mo (3-5 workers, larger Redis)

**Compared to Vercel/Serverless**:
- Vercel Cron has 10s timeout (unusable for large syncs)
- Vercel Pro allows longer functions but billed per invocation
- BullMQ is predictable, flat cost

---

## Migration Checklist

**Pre-Migration**:
- [ ] Document current sync behavior (baseline metrics)
- [ ] Set up staging environment on Dokploy
- [ ] Write integration tests for worker
- [ ] Create rollback plan (keep old API routes temporarily)

**Migration**:
- [ ] Deploy Redis to Dokploy
- [ ] Deploy Worker to Dokploy
- [ ] Deploy Bull Board (optional)
- [ ] Update Next.js staging with BullMQ client
- [ ] Test with 1 organization (full sync)
- [ ] Monitor for 24 hours
- [ ] Deploy to production (gradual rollout)

**Post-Migration**:
- [ ] Monitor job success rate (target: >95%)
- [ ] Monitor sync duration (should be similar or faster)
- [ ] Set up alerts for failures
- [ ] Document operational procedures
- [ ] Remove old sync code after 30 days of stability

---

## Future Enhancements

**Phase 2 Features**:
1. **Scheduled Syncs**: BullMQ's built-in cron (replace Vercel Cron)
   - `shopify-products` queue runs daily at 2am
   - `shopify-orders` queue runs every 15 minutes
2. **Job Priorities**: Webhook syncs (priority 1) processed before scheduled (priority 10)
3. **Dead Letter Queue**: Auto-retry failed jobs after investigation
4. **Webhook Batching**: Batch product/update webhooks (1 job per 100 webhooks)
5. **Custom Integrations**: FloristOne, Square, QuickBooks syncs via same queue system

**Phase 3 Features**:
1. **Real-Time Progress**: WebSocket updates instead of polling
2. **Job Chaining**: Sync products → update inventory → recalculate metrics
3. **Multi-Tenant Rate Limiting**: Per-organization API quotas
4. **Advanced Monitoring**: Custom Grafana dashboards for queue metrics
5. **Job Scheduling UI**: Allow users to configure sync frequency in bloomwise UI

---

## Security Considerations

**Credentials**:
- ✅ Stored in Neon (encrypted at rest)
- ✅ Never logged or exposed in job data
- ✅ Fetched fresh from database per job
- ⚠️ Consider encrypting `accessToken` column (application-level encryption)

**Redis Security**:
- ✅ Internal network only (not exposed to internet)
- ⚠️ Enable Redis AUTH for production (`requirepass` directive)
- ⚠️ Use TLS for Redis connection if Dokploy supports it

**Network Security**:
- ✅ Worker → Neon over TLS (Neon enforces SSL)
- ✅ Worker → Shopify over HTTPS
- ⚠️ Consider VPN/Tailscale for Next.js → Redis (if exposed)

**API Security**:
- ✅ Sync job APIs require authentication (Better Auth session)
- ✅ Organization isolation (users can't see other orgs' jobs)
- ⚠️ Bull Board requires authentication (basic auth at minimum)

**Compliance**:
- GDPR: Sync jobs may process customer PII (names, emails, addresses)
- Ensure data retention policy (delete old syncJobs after 90 days)
- Log only necessary data (avoid logging full customer records)

---

## Conclusion

This plan provides a comprehensive roadmap for migrating bloomwise's external integration syncs to a BullMQ-based worker architecture. The phased approach minimizes risk while delivering immediate benefits:

**Immediate Benefits** (Phase 1-3):
- No more timeout errors on large syncs
- Better visibility into sync progress
- Automatic retries on failures
- Independent scaling of web app and workers

**Long-Term Benefits** (Phase 4-6):
- Unified job queue for all background tasks
- Reduced operational complexity (no Vercel Cron)
- Better resource utilization and cost efficiency
- Foundation for future integrations (Square, FloristOne, QuickBooks)

**Success Criteria**:
- 95%+ sync success rate
- <5 second webhook response time
- <1% job retry rate
- Zero timeout-related failures
- Positive developer experience (easy to add new job types)

**Timeline Estimate**:
- Infrastructure setup: 1 week
- Worker implementation: 2 weeks
- Next.js integration: 1 week
- Testing and staging: 1 week
- Production rollout: 1 week
- **Total: 6 weeks**

**Next Steps**:
1. Review this plan with team
2. Provision Dokploy resources (Redis, worker)
3. Create worker repository from template
4. Implement first queue (shopify-products)
5. Test end-to-end with staging data
6. Deploy to production with gradual rollout

---

## Appendix

### A. BullMQ vs Alternatives Comparison

See detailed comparison in main document above (Graphile Worker, Inngest, Temporal).

### B. Example Job Data Structures

**Shopify Products Sync Job**:
```json
{
  "syncJobId": "550e8400-e29b-41d4-a716-446655440000",
  "organizationId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "integrationId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "type": "full",
  "cursor": null,
  "batchSize": 250
}
```

**Webhook-Triggered Single Product Sync**:
```json
{
  "syncJobId": "660e8400-e29b-41d4-a716-446655440001",
  "organizationId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "integrationId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "type": "single",
  "productId": "gid://shopify/Product/1234567890"
}
```

### C. Useful Resources

**BullMQ Documentation**:
- Official Docs: https://docs.bullmq.io/
- GitHub: https://github.com/taskforcesh/bullmq
- Bull Board (Dashboard): https://github.com/felixmosh/bull-board

**Dokploy Documentation**:
- Deploying Services: https://docs.dokploy.com/
- Redis Setup: (specific to Dokploy version)

**Shopify API**:
- GraphQL Admin API: https://shopify.dev/docs/api/admin-graphql
- Rate Limits: https://shopify.dev/docs/api/usage/rate-limits

**Monitoring**:
- Bull Board Demo: https://bullboard.org/
- Sentry Node.js: https://docs.sentry.io/platforms/node/

---

**Document Maintenance**:
- This plan should be updated as implementation progresses
- Track deviations from plan in separate CHANGELOG.md
- Archive completed phases for historical reference
