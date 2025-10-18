import { db } from "@/db/drizzle";
import { syncJobs } from "@/db/schema/sync-jobs";
import { eq, and } from "drizzle-orm";
import { syncShopifyOrdersBatch } from "./shopify-orders-sync";
import { syncExistingShopifyOrders } from "./existing-orders-sync";
import { shopifyLogger, trackPerformance } from "@/lib/sentry-logger";

export interface SyncJobConfig {
  organizationId: string;
  type: "shopify_orders_initial" | "shopify_orders_incremental" | "shopify_products" | "shopify_customers";
  config?: {
    source?: string;
    dateFrom?: string;
    dateTo?: string;
    fetchAll?: boolean;
    syncToInternal?: boolean;
    forceUpdate?: boolean;
    filters?: Record<string, any>;
  };
  createdBy?: string;
}

/**
 * Creates a new sync job and executes it immediately.
 */
export async function createSyncJob(jobConfig: SyncJobConfig) {
  console.log(`[JOB-CREATE] Creating sync job:`);
  console.log(`[JOB-CREATE]   - Organization: ${jobConfig.organizationId}`);
  console.log(`[JOB-CREATE]   - Type: ${jobConfig.type}`);
  console.log(`[JOB-CREATE]   - Created by: ${jobConfig.createdBy}`);
  console.log(`[JOB-CREATE]   - Config: ${JSON.stringify(jobConfig.config)}`);

  try {
    // Create the job record
    const [job] = await db
      .insert(syncJobs)
      .values({
        organizationId: jobConfig.organizationId,
        type: jobConfig.type,
        status: "pending",
        config: jobConfig.config || {},
        createdBy: jobConfig.createdBy,
      })
      .returning();

    console.log(`[JOB-CREATE] ✓ Job created with ID: ${job.id}`);

    // Execute the job asynchronously in the background
    console.log(`[JOB-CREATE] Starting background processing for job ${job.id}...`);
    processSyncJob(job.id).catch(error => {
      console.error(`[JOB-CREATE] ❌ Failed to process sync job ${job.id}:`, error);
      console.error(`[JOB-CREATE] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');

      // Log to Sentry for monitoring
      const syncType = jobConfig.type.includes("products") ? "products" : "orders";
      shopifyLogger.syncBatchFailed(syncType as "products" | "orders", error instanceof Error ? error : new Error(String(error)), job.id);
    });

    return job;
  } catch (error) {
    console.error(`[JOB-CREATE] ❌ Failed to create sync job:`, error);
    console.error(`[JOB-CREATE] Error details:`, {
      organizationId: jobConfig.organizationId,
      type: jobConfig.type,
      createdBy: jobConfig.createdBy,
      config: jobConfig.config,
    });

    // Log to Sentry
    const syncType = jobConfig.type.includes("products") ? "products" : "orders";
    shopifyLogger.syncBatchFailed(syncType as "products" | "orders", error instanceof Error ? error : new Error(String(error)));

    throw error; // Re-throw to let caller handle it
  }
}

/**
 * Main job processor - handles different sync types
 */
export async function processSyncJob(jobId: string) {
  return trackPerformance("shopify.sync.job", { jobId }, async () => {
    const processStartTime = new Date();
    console.log(`[JOB-PROCESS] Starting to process job ${jobId} at ${processStartTime.toISOString()}`);

    const [job] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, jobId))
      .limit(1);

    if (!job) {
      console.error(`[JOB-PROCESS] ❌ Job ${jobId} not found in database`);
      throw new Error(`Job ${jobId} not found`);
    }

    console.log(`[JOB-PROCESS] Job details:`);
    console.log(`[JOB-PROCESS]   - Type: ${job.type}`);
    console.log(`[JOB-PROCESS]   - Organization: ${job.organizationId}`);
    console.log(`[JOB-PROCESS]   - Current status: ${job.status}`);
    console.log(`[JOB-PROCESS]   - Config: ${JSON.stringify(job.config)}`);

    // Determine sync type for logging
    const syncType = job.type.includes("products") ? "products" : "orders";
    const batchSize = job.config?.batchSize || 250;

    // Log batch start to Sentry
    shopifyLogger.syncBatchStarted(syncType as "products" | "orders", batchSize, jobId);

    // Atomic update: Only set to running if currently pending
    // This prevents race conditions where multiple processes try to run the same job
    console.log(`[JOB-PROCESS] Attempting to mark job as 'running'...`);
    const [updatedJob] = await db
      .update(syncJobs)
      .set({
        status: "running",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(and(
        eq(syncJobs.id, jobId),
        eq(syncJobs.status, "pending") // Only update if pending
      ))
      .returning();

    // If no rows were updated, job was already running or in another state
    if (!updatedJob) {
      console.log(`[JOB-PROCESS] ⚠️ Job ${jobId} is not in pending state (likely already running), skipping`);
      return job;
    }

    console.log(`[JOB-PROCESS] ✓ Job ${jobId} marked as running`);

    try {
      console.log(`[JOB-PROCESS] Executing sync handler for type: ${updatedJob.type}`);

    switch (updatedJob.type) {
      case "shopify_orders_initial":
        console.log(`[JOB-PROCESS] Loading GraphQL orders sync module...`);
        // Use GraphQL for orders sync (better performance and future-proof)
        const { processOrdersSyncJobGraphQL } = await import("./orders-sync-graphql");
        console.log(`[JOB-PROCESS] ✓ Orders sync module loaded, starting sync...`);
        await processOrdersSyncJobGraphQL(updatedJob);
        console.log(`[JOB-PROCESS] ✓ Orders sync completed`);
        break;
      case "shopify_orders_incremental":
        console.log(`[JOB-PROCESS] Starting incremental orders sync...`);
        await processExistingOrdersSync(updatedJob);
        console.log(`[JOB-PROCESS] ✓ Incremental orders sync completed`);
        break;
      case "shopify_products":
      case "shopify_products_initial":
      case "shopify_products_incremental":
        console.log(`[JOB-PROCESS] Loading GraphQL products sync module...`);
        // Use GraphQL for products sync (required by Feb 1, 2025)
        const { processProductsSyncGraphQL } = await import("./products-sync-graphql");
        console.log(`[JOB-PROCESS] ✓ Products sync module loaded, starting sync...`);
        const syncParams = {
          organizationId: updatedJob.organizationId,
          jobId: updatedJob.id,
          fetchAll: updatedJob.config?.fetchAll || false,
          includeVariants: updatedJob.config?.includeVariants ?? true,
          productIds: updatedJob.config?.productIds,
          collectionIds: updatedJob.config?.collectionIds,
          updatedAfter: updatedJob.config?.updatedAfter,
        };
        console.log(`[JOB-PROCESS] Sync params: ${JSON.stringify(syncParams)}`);
        await processProductsSyncGraphQL(syncParams);
        console.log(`[JOB-PROCESS] ✓ Products sync completed`);
        break;
      case "shopify_customers":
        console.log(`[JOB-PROCESS] ⚠️ Customer sync not implemented yet`);
        // TODO: Implement customer sync
        throw new Error("Customer sync not implemented yet");
      default:
        console.error(`[JOB-PROCESS] ❌ Unknown job type: ${updatedJob.type}`);
        throw new Error(`Unknown job type: ${updatedJob.type}`);
    }

    // Mark job as completed
    console.log(`[JOB-PROCESS] Marking job ${jobId} as completed...`);
    await db
      .update(syncJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    const [finalJob] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, jobId))
      .limit(1);

    const processEndTime = new Date();
    const duration = processEndTime.getTime() - processStartTime.getTime();
    console.log(`[JOB-PROCESS] ✓ Job ${jobId} completed successfully`);
    console.log(`[JOB-PROCESS] Total processing time: ${duration}ms`);

    // Log batch completion to Sentry
    const stats = {
      total: finalJob?.result?.processed || 0,
      successful: finalJob?.result?.successful || 0,
      failed: finalJob?.result?.failed || 0,
      duration: duration,
    };
    shopifyLogger.syncBatchCompleted(syncType as "products" | "orders", stats, jobId);

    return finalJob;
  } catch (error) {
    // Mark job as failed
    await db
      .update(syncJobs)
      .set({
        status: "failed",
        lastError: error instanceof Error ? error.message : "Unknown error",
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    // Log batch failure to Sentry
    const syncType = job.type.includes("products") ? "products" : "orders";
    shopifyLogger.syncBatchFailed(syncType as "products" | "orders", error instanceof Error ? error : new Error(String(error)), jobId);

    throw error;
  }
  });
}

/**
 * Process existing Shopify orders sync job - syncs orders already in shopify_orders table
 */
async function processExistingOrdersSync(job: typeof syncJobs.$inferSelect) {
  console.log(`Processing existing orders sync job ${job.id}`);

  const batchSize = job.pageSize || 200;
  let hasMore = true;
  let totalProcessed = job.processedItems || 0;
  let totalSuccess = job.successCount || 0;
  let totalErrors = job.errorCount || 0;
  let totalSkipped = job.skipCount || 0;
  let batchNumber = 0;

  while (hasMore && job.status === "running") {
    try {
      // Check if job has been cancelled
      const [currentJob] = await db
        .select({ status: syncJobs.status })
        .from(syncJobs)
        .where(eq(syncJobs.id, job.id))
        .limit(1);

      if (currentJob?.status === "cancelled" || currentJob?.status === "paused") {
        console.log(`Job ${job.id} has been ${currentJob.status}`);
        break;
      }

      batchNumber++;
      console.log(`Processing existing orders batch ${batchNumber}`);

      // Process existing unsynced orders
      const result = await syncExistingShopifyOrders({
        organizationId: job.organizationId,
        batchSize,
      });

      // Update counters
      totalProcessed += result.processed;
      totalSuccess += result.success;
      totalErrors += result.errors;
      totalSkipped += result.skipped;

      // Calculate progress
      const progress = result.totalItems > 0 ? (totalSuccess / result.totalItems) * 100 : 100;
      const estimatedCompletion = result.hasMore ? calculateETA(
        job.startedAt || new Date(),
        totalSuccess,
        result.totalItems
      ) : null;

      // Update job progress
      await db
        .update(syncJobs)
        .set({
          totalItems: result.totalItems,
          processedItems: totalProcessed,
          successCount: totalSuccess,
          errorCount: totalErrors,
          skipCount: totalSkipped,
          lastActivityAt: new Date(),
          estimatedCompletionAt: estimatedCompletion,
          metadata: {
            ...job.metadata,
            progress: Math.round(progress),
            lastBatchSize: result.processed,
            batchNumber,
          },
        })
        .where(eq(syncJobs.id, job.id));

      // Check if we're done
      hasMore = result.hasMore;

      // Add small delay between batches to avoid rate limits
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      // If no items were processed in this batch, we're done
      if (result.processed === 0) {
        hasMore = false;
      }

    } catch (error) {
      console.error(`Error processing existing orders batch ${batchNumber} for job ${job.id}:`, error);

      // Record the error
      const errors = job.errors || [];
      errors.push({
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : "Unknown error",
        item: { batch: batchNumber },
      });

      await db
        .update(syncJobs)
        .set({
          lastError: error instanceof Error ? error.message : "Unknown error",
          errors: errors.slice(-100), // Keep last 100 errors
          errorCount: totalErrors + 1,
          lastActivityAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));

      totalErrors += 1;

      // Decide whether to continue or fail
      if (totalErrors > 5) {
        throw new Error(`Too many errors (${totalErrors}), stopping job`);
      }

      hasMore = false; // Stop on error for existing orders sync
    }
  }

  const [currentState] = await db
    .select({ metadata: syncJobs.metadata })
    .from(syncJobs)
    .where(eq(syncJobs.id, job.id))
    .limit(1);

  const summary = {
    processed: totalProcessed,
    externalSynced: totalSuccess,
    externalErrors: totalErrors,
    skipped: totalSkipped,
  };

  await db
    .update(syncJobs)
    .set({
      processedItems: totalProcessed,
      successCount: totalSuccess,
      errorCount: totalErrors,
      skipCount: totalSkipped,
      metadata: {
        ...(currentState?.metadata || {}),
        summary,
      },
    })
    .where(eq(syncJobs.id, job.id));

  console.log(`Finished existing orders sync job ${job.id}. Processed: ${totalProcessed}, Success: ${totalSuccess}, Errors: ${totalErrors}`);
}

/**
 * Process Shopify orders sync job in batches
 */
async function processShopifyOrdersSync(job: typeof syncJobs.$inferSelect) {
  const batchSize = job.pageSize || 200;
  let hasMore = true;
  let currentBatch = job.currentPage || 0;
  let totalProcessed = job.processedItems || 0;
  let totalSuccess = job.successCount || 0;
  let totalErrors = job.errorCount || 0;
  let totalSkipped = job.skipCount || 0;
  let totalEstimate = job.totalItems || 0;
  let pageToken = job.nextPageToken || undefined;
  let totalInternalCreated = 0;
  let totalInternalUpdated = 0;
  let totalInternalErrors = 0;
  let totalInternalSkipped = 0;

  while (hasMore && job.status === "running") {
    try {
      // Check if job has been cancelled
      const [currentJob] = await db
        .select({ status: syncJobs.status })
        .from(syncJobs)
        .where(eq(syncJobs.id, job.id))
        .limit(1);

      if (currentJob?.status === "cancelled" || currentJob?.status === "paused") {
        console.log(`Job ${job.id} has been ${currentJob.status}`);
        break;
      }

      // Process a batch
      const result = await syncShopifyOrdersBatch({
        organizationId: job.organizationId,
        batchSize,
        pageToken,
        dateFrom: job.config?.dateFrom,
        dateTo: job.config?.dateTo,
        syncToInternal: job.config?.syncToInternal !== false,
        forceUpdate: job.config?.forceUpdate || false,
      });

      // Update counters
      totalProcessed += result.processed;
      totalSuccess += result.success;
      totalErrors += result.errors;
      totalSkipped += result.skipped;

      if (result.totalItems > 0) {
        totalEstimate = result.totalItems;
      } else if (hasMore) {
        totalEstimate = Math.max(totalEstimate, totalProcessed + batchSize);
      } else {
        totalEstimate = Math.max(totalEstimate, totalProcessed);
      }

      // Calculate progress and ETA
      const progress = totalEstimate > 0 ? (totalProcessed / totalEstimate) * 100 : 0;
      const estimatedCompletion = calculateETA(
        job.startedAt || new Date(),
        totalProcessed,
        totalEstimate
      );

      pageToken = result.nextPageToken || undefined;
      // Update job progress
      await db
        .update(syncJobs)
        .set({
          totalItems: totalEstimate,
          processedItems: totalProcessed,
          successCount: totalSuccess,
          errorCount: totalErrors,
          skipCount: totalSkipped,
          currentPage: currentBatch + 1,
          nextPageToken: pageToken || null,
          lastActivityAt: new Date(),
          estimatedCompletionAt: estimatedCompletion,
          metadata: {
            ...job.metadata,
            progress: Math.round(progress),
            lastBatchSize: result.processed,
            stats: result.stats,
          },
        })
        .where(eq(syncJobs.id, job.id));

      // Check if we're done
      hasMore = result.hasMore && !!pageToken;
      currentBatch++;

      // Add small delay between batches to avoid rate limits
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      if (result.stats) {
        totalInternalCreated += result.stats.internalCreated || 0;
        totalInternalUpdated += result.stats.internalUpdated || 0;
        totalInternalErrors += result.stats.internalErrors || 0;
        totalInternalSkipped += result.stats.internalSkipped || 0;
      }
    } catch (error) {
      console.error(`Error processing batch ${currentBatch} for job ${job.id}:`, error);

      // Record the error
      const errors = job.errors || [];
      errors.push({
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : "Unknown error",
        item: { batch: currentBatch },
      });

      await db
        .update(syncJobs)
        .set({
          lastError: error instanceof Error ? error.message : "Unknown error",
          errors: errors.slice(-100), // Keep last 100 errors
          errorCount: totalErrors + 1,
          lastActivityAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));

      totalErrors += 1;

      // Decide whether to continue or fail
      if (totalErrors > 10) {
        throw new Error(`Too many errors (${totalErrors}), stopping job`);
      }
    }
  }

  const [currentState] = await db
    .select({ metadata: syncJobs.metadata })
    .from(syncJobs)
    .where(eq(syncJobs.id, job.id))
    .limit(1);

  const summary = {
    batches: currentBatch,
    processed: totalProcessed,
    externalSynced: totalSuccess,
    externalErrors: totalErrors,
    skipped: totalSkipped,
    estimatedTotal: totalEstimate,
    internalCreated: totalInternalCreated,
    internalUpdated: totalInternalUpdated,
    internalErrors: totalInternalErrors,
    internalSkipped: totalInternalSkipped,
  };

  await db
    .update(syncJobs)
    .set({
      totalItems: totalEstimate,
      processedItems: totalProcessed,
      successCount: totalSuccess,
      errorCount: totalErrors,
      skipCount: totalSkipped,
      metadata: {
        ...(currentState?.metadata || {}),
        summary,
      },
    })
    .where(eq(syncJobs.id, job.id));
}

/**
 * Calculate estimated time of completion
 */
function calculateETA(
  startTime: Date,
  processed: number,
  total: number
): Date | null {
  if (processed === 0 || total === 0) return null;

  const elapsedMs = Date.now() - startTime.getTime();
  const rate = processed / elapsedMs; // items per millisecond
  const remaining = total - processed;
  const remainingMs = remaining / rate;

  return new Date(Date.now() + remainingMs);
}

/**
 * Get job status and progress
 */
export async function getJobStatus(jobId: string) {
  const [job] = await db
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.id, jobId))
    .limit(1);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const progress = job.totalItems > 0
    ? Math.round((job.processedItems / job.totalItems) * 100)
    : 0;

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    successCount: job.successCount,
    errorCount: job.errorCount,
    skipCount: job.skipCount,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    estimatedCompletionAt: job.estimatedCompletionAt,
    lastError: job.lastError,
    config: job.config,
  };
}

/**
 * Cancel a running job
 */
export async function cancelJob(jobId: string) {
  const [job] = await db
    .update(syncJobs)
    .set({
      status: "cancelled",
      lastActivityAt: new Date(),
    })
    .where(and(
      eq(syncJobs.id, jobId),
      eq(syncJobs.status, "running")
    ))
    .returning();

  return job;
}

/**
 * Resume a paused or failed job
 */
export async function resumeJob(jobId: string) {
  const [job] = await db
    .update(syncJobs)
    .set({
      status: "pending",
      lastError: null,
      lastActivityAt: new Date(),
    })
    .where(and(
      eq(syncJobs.id, jobId),
      syncJobs.status.in(["paused", "failed", "cancelled"])
    ))
    .returning();

  if (job) {
    // Execute the job asynchronously in the background
    processSyncJob(job.id).catch(error => {
      console.error(`Failed to resume sync job ${job.id}:`, error);
    });
  }

  return job;
}
