# Testing the BullMQ Worker

## Prerequisites

1. Worker is deployed and running on Dokploy
2. You have access to:
   - Redis URL (from Dokploy env vars)
   - Database URL (Neon PostgreSQL)
   - An organization ID with a Shopify integration

## How to Test

### Step 1: Set up environment variables locally

Create a `.env` file with:

```env
REDIS_URL=redis://default:49a709ffdbd9a6078ed26064747b88c5641c83e3c853a702ede46d8fc84ea92f@bloomwiseco-redis-6a1o3m:6379
DATABASE_URL=<your-neon-database-url>
```

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Find your organization ID

Query your database to find an organization with an active Shopify integration:

```sql
SELECT
  o.id as organization_id,
  o.name as organization_name,
  si.id as integration_id,
  si.shop_domain,
  si.is_active
FROM organizations o
JOIN shopify_integrations si ON si.organization_id = o.id
WHERE si.is_active = true
LIMIT 1;
```

### Step 4: Enqueue a test job

**Option A: Let the script find the integration automatically**

```bash
npm run test:enqueue -- --org=<your-organization-id>
```

**Option B: Specify the integration ID**

```bash
npm run test:enqueue -- --org=<organization-id> --integration=<integration-id>
```

**Option C: Full sync (fetch all products)**

```bash
npm run test:enqueue -- --org=<organization-id> --fetchAll
```

### Step 5: Monitor the job

The script will output:

```
===========================================
✅ Test job enqueued successfully!
===========================================
Job ID:          123456
Sync Job ID:     clxxxxxxxxxxxxx
Organization:    org-uuid
Integration:     int-uuid
Shop Domain:     your-store.myshopify.com
Fetch All:       false
===========================================

Monitor the job at: https://jobs.bloomwise.co
Queue: shopify-products
Job ID: 123456
===========================================
```

**Go to Bull Board:**
1. Visit https://jobs.bloomwise.co
2. Login with your credentials
3. Navigate to "shopify-products" queue
4. Find your job by Job ID
5. Watch it process in real-time!

### Step 6: Verify in database

Check the `sync_jobs` table:

```sql
SELECT
  id,
  type,
  status,
  processed_items,
  success_count,
  error_count,
  started_at,
  completed_at,
  error_message
FROM sync_jobs
WHERE id = '<your-sync-job-id>'
ORDER BY created_at DESC;
```

## Expected Results

### Successful Job:

**In Bull Board:**
- Job appears in "shopify-products" queue
- Status changes: waiting → active → completed
- Progress bar shows 0% → 100%
- Logs show batch processing

**In Database:**
- `sync_jobs.status` = 'completed'
- `sync_jobs.processed_items` > 0
- `sync_jobs.success_count` > 0
- `sync_jobs.completed_at` is set

**Worker Logs (in Dokploy):**
```
[INFO] Starting Shopify products sync
[INFO] Fetching Shopify credentials...
[INFO] Starting product sync with Shopify credentials
[INFO] Fetching products batch from Shopify
[INFO] Batch processed - productsInBatch: 250
[INFO] Shopify products sync completed
```

### Failed Job:

**Check:**
1. Bull Board for error message
2. Worker logs in Dokploy
3. `sync_jobs.error_message` in database

## Common Issues

### "No Shopify integration found"
- Verify organization ID is correct
- Check `shopify_integrations` table has active integration
- Ensure `is_active = true`

### "Redis connection failed"
- Verify REDIS_URL is correct
- Check Redis is running in Dokploy
- Test with: `npm run test:connection`

### "Database connection failed"
- Verify DATABASE_URL is correct
- Check Neon database is accessible
- Test with: `npm run test:connection`

### Job stuck in "waiting"
- Check worker is running in Dokploy
- Check worker logs for errors
- Verify worker is connected to same Redis

### Job failed with "Invalid credentials"
- Check Shopify access token is valid
- Verify shop domain is correct
- Check integration hasn't been uninstalled

## Troubleshooting Commands

**Test connections:**
```bash
npm run test:connection
```

**Check Redis:**
```bash
redis-cli -u $REDIS_URL ping
```

**Check database:**
```bash
psql $DATABASE_URL -c "SELECT NOW();"
```

**View worker logs:**
In Dokploy dashboard → bloomwise-worker → Logs

## Next Steps After Successful Test

1. ✅ Worker is processing jobs correctly
2. ✅ Database is being updated
3. ✅ Ready to integrate with Next.js app
4. → Update Next.js to enqueue jobs instead of processing directly
