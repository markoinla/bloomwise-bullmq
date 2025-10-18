# Bloomwise BullMQ Worker Service

Background job processing service for Bloomwise external integrations (Shopify, Seal Subscriptions).

## Architecture

This worker service runs on Dokploy and processes background jobs from Redis queues:
- **Shopify Products Sync** - Full, incremental, and webhook-triggered product syncs
- **Shopify Orders Sync** - Order synchronization
- **Seal Subscriptions** - Subscription data sync

## Prerequisites

- Node.js 20+
- Redis instance (provided by Dokploy)
- Neon PostgreSQL database

## Local Development

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```env
DATABASE_URL=postgresql://user:password@host/database
REDIS_URL=redis://default:password@host:6379
NODE_ENV=development
LOG_LEVEL=debug
WORKER_CONCURRENCY=5
```

### 3. Test Connections

```bash
npm run test:connection
```

This verifies Redis and database connectivity.

### 4. Run Worker Locally

```bash
npm run dev
```

The worker will:
- Connect to Redis and PostgreSQL
- Start Bull Board dashboard on port 3001
- Listen for jobs on configured queues

### 5. Access Dashboard

Open http://localhost:3001 in your browser.

**Login credentials:**
- Username: `admin`
- Password: `admin` (from .env)

The dashboard shows:
- All queues (shopify-products, shopify-orders, seal-subscriptions)
- Job counts (waiting, active, completed, failed)
- Individual job details and logs
- Ability to retry failed jobs

**Health check:** http://localhost:3001/health

## Deployment to Dokploy

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial worker setup"
git remote add origin https://github.com/your-username/bloomwise-bullmq.git
git push -u origin main
```

### Step 2: Create Application in Dokploy

1. Log into your Dokploy dashboard
2. Click **"Create New Application"**
3. Configure:
   - **Name**: `bloomwise-worker`
   - **Source**: GitHub
   - **Repository**: Select your repo
   - **Branch**: `main`
   - **Build Type**: Dockerfile

### Step 3: Configure Environment Variables

In Dokploy, add these environment variables:

```env
DATABASE_URL=<your-neon-postgresql-url>
REDIS_URL=redis://default:49a709ffdbd9a6078ed26064747b88c5641c83e3c853a702ede46d8fc84ea92f@bloomwiseco-redis-6a1o3m:6379
NODE_ENV=production
LOG_LEVEL=info
WORKER_CONCURRENCY=5
WORKER_MAX_RETRIES=3
BULL_BOARD_PORT=3001
BULL_BOARD_USERNAME=admin
BULL_BOARD_PASSWORD=<strong-password-here>
```

### Step 4: Deploy

1. Click **"Deploy"** in Dokploy
2. Dokploy will:
   - Clone your repo
   - Build Docker image using Dockerfile
   - Run container with environment variables
   - Start health checks on port 3001

### Step 5: Verify Deployment

**Access the dashboard:**
- Set custom domain in Dokploy: `jobs.bloomwise.co` → port `3001`
- Visit: https://jobs.bloomwise.co
- Login with your `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD`

**Check logs in Dokploy:**
```
[INFO] Starting Bloomwise BullMQ Worker Service...
[INFO] Redis connected
[INFO] Bull Board dashboard running on port 3001
[INFO] Workers initialized
```

## Project Structure

```
bloomwise-bullmq/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── dashboard.ts             # Bull Board web UI
│   ├── health.ts                # Health check (legacy)
│   ├── config/
│   │   ├── redis.ts             # Redis connection
│   │   ├── database.ts          # Neon database connection
│   │   └── queues.ts            # Queue definitions
│   ├── queues/
│   │   └── shopify-products.ts  # Shopify products processor
│   ├── lib/
│   │   └── utils/
│   │       └── logger.ts        # Structured logging
│   └── scripts/
│       └── test-connection.ts   # Connection testing
├── Dockerfile                   # Production build
├── package.json
└── tsconfig.json
```

## Next Steps

### Implement Sync Logic

The current worker has placeholder processing. You need to:

1. **Create database schema** - Import Drizzle schema for `shopifyIntegrations`, `syncJobs` tables
2. **Add sync functions** - Import or implement Shopify sync logic
3. **Update job processor** - Complete the TODOs in `src/queues/shopify-products.ts`
4. **Add more queues** - Implement `shopify-orders`, `seal-subscriptions` workers

### Update Next.js Application

1. Install BullMQ client: `npm install bullmq ioredis`
2. Create queue client pointing to Dokploy Redis
3. Update API routes to enqueue jobs instead of processing synchronously
4. Add job status polling endpoint

## Bull Board Dashboard

**Included!** The worker service includes Bull Board dashboard for monitoring:

**Features:**
- ✅ View all queues and job counts (waiting, active, completed, failed)
- ✅ Inspect individual jobs (data, logs, stack traces)
- ✅ Manually retry failed jobs
- ✅ Pause/resume queues
- ✅ Real-time job updates

**Access:**
- URL: https://jobs.bloomwise.co (configured in Dokploy)
- Authentication: Basic auth (set via environment variables)
- Credentials: `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD`

## Commands

- `npm run dev` - Run worker in development mode (with hot reload)
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run compiled worker (production)
- `npm run test:connection` - Test Redis and database connections
- `npm run type-check` - Check TypeScript types without building

## Monitoring

### Logs

Structured JSON logs with:
- `jobId` - BullMQ job ID
- `organizationId` - Tenant identifier
- `syncJobId` - Database sync job ID
- `level` - info, warn, error
- `timestamp` - ISO 8601

### Metrics to Track

- Jobs processed per minute
- Job success/failure rate
- Average job duration
- Queue backlog size
- Worker memory/CPU usage

## Troubleshooting

### Worker won't start

Check logs for missing environment variables:
```
[ERROR] Missing required environment variables: DATABASE_URL
```

### Redis connection failed

Verify `REDIS_URL` is correct and Redis is running:
```bash
npm run test:connection
```

### Jobs not processing

1. Check worker is running: `curl http://worker-url/health`
2. Check Redis has jobs: Use Redis CLI or Bull Board
3. Check worker logs for errors

### High memory usage

Reduce `WORKER_CONCURRENCY` in environment variables.

## Security

- Redis credentials stored in environment variables (not in code)
- Database credentials fetched from environment
- Worker runs as non-root user in Docker
- No secrets in job data or logs

## License

MIT
