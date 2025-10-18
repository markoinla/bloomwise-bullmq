/**
 * GraphQL-based orders sync - replaces REST API implementation
 *
 * CRITICAL: Orders endpoints migrate to GraphQL approach for better performance
 * This implementation uses Shopify GraphQL Admin API instead of REST
 */

import { db } from "@/db/drizzle";
import {
  shopifyIntegrations,
  shopifyOrders,
  syncJobs,
  userActivityLogs,
} from "@/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  fetchOrdersGraphQL,
  convertGraphQLOrderToREST
} from "../shopify/graphql-client";
import { batchSyncShopifyOrders } from "@/lib/shopify/order-sync-batch";
import { syncShopifyOrdersToInternalBatch } from "@/lib/shopify/sync-to-internal-batch";

interface OrdersSyncParams {
  organizationId: string;
  jobId: string;
  batchSize?: number;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
  syncToInternal?: boolean;
  forceUpdate?: boolean;
}

interface OrdersSyncResult {
  success: boolean;
  total: number;
  synced: number;
  failed: number;
  hasMore: boolean;
  nextCursor?: string;
  errors: Array<{ orderId: string; error: string }>;
  stats?: {
    externalSynced: number;
    externalFailed: number;
    externalSkipped: number;
    internalCreated: number;
    internalUpdated: number;
    internalSkipped: number;
    internalErrors: number;
  };
}

export async function processOrdersSyncGraphQL(params: OrdersSyncParams): Promise<OrdersSyncResult> {
  const {
    organizationId,
    jobId,
    batchSize = 100, // Reduced from 250 to lower query cost and prevent throttling
    cursor,
    dateFrom,
    dateTo,
    syncToInternal = true,
    forceUpdate = false,
  } = params;

  const result: OrdersSyncResult = {
    success: true,
    total: 0,
    synced: 0,
    failed: 0,
    hasMore: false,
    errors: [],
  };

  try {
    await db
      .update(syncJobs)
      .set({
        status: "running",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    console.log(`Starting GraphQL orders sync for organization ${organizationId}`);

    // Get the Shopify integration
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(
        and(
          eq(shopifyIntegrations.organizationId, organizationId),
          eq(shopifyIntegrations.isActive, true)
        )
      )
      .limit(1);

    if (!integration) {
      throw new Error("No active Shopify integration found");
    }

    // Build GraphQL query filter for date filtering
    let graphqlQuery = "";
    if (dateFrom) {
      const dateFromObj = new Date(dateFrom);
      // Add 2-minute buffer for API timing differences
      const bufferedDate = new Date(dateFromObj.getTime() - 2 * 60 * 1000);
      graphqlQuery = `updated_at:>='${bufferedDate.toISOString()}'`;

      if (dateTo) {
        graphqlQuery += ` AND updated_at:<='${dateTo}'`;
      }
    } else if (dateTo) {
      graphqlQuery = `updated_at:<='${dateTo}'`;
    }

    let batchNumber = 0;
    let totalProcessed = 0;

    try {
      batchNumber++;
      console.log(`Processing GraphQL orders batch ${batchNumber}`);

      // Fetch orders using GraphQL
      const response = await fetchOrdersGraphQL(organizationId, {
        limit: Math.min(batchSize, 100), // Reduced to 100 to lower query cost per request
        cursor,
        query: graphqlQuery,
        sortKey: 'UPDATED_AT',
        reverse: true, // Newest first
      });

      const orders = response.data;
      result.hasMore = response.pageInfo.hasNextPage;
      result.nextCursor = response.pageInfo.endCursor;

      console.log(`Fetched ${orders.length} orders from GraphQL API`);

      if (orders.length === 0) {
        result.total = totalProcessed;
        return result;
      }

      // Convert GraphQL orders to REST format for compatibility with existing sync logic
      const restOrders = orders.map(convertGraphQLOrderToREST);

      // Sync orders to shopify_orders table using existing batch processing
      const syncResults = await batchSyncShopifyOrders(restOrders, organizationId);

      // Optionally sync to internal orders using existing batch processing
      let internalResults = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
      if (syncToInternal && syncResults.success > 0) {
        try {
          internalResults = await syncShopifyOrdersToInternalBatch(organizationId, batchSize, forceUpdate);
          console.log("Internal sync results (batch):", internalResults);
        } catch (error) {
          console.error("Error syncing to internal orders:", error);
        }
      }

      totalProcessed += orders.length;
      result.total = totalProcessed;
      result.synced = syncResults.success;
      result.failed = syncResults.failed + internalResults.errors.length;

      // Build stats
      result.stats = {
        externalSynced: syncResults.success,
        externalFailed: syncResults.failed,
        externalSkipped: syncResults.skipped,
        internalCreated: internalResults.created,
        internalUpdated: internalResults.updated,
        internalSkipped: internalResults.skipped,
        internalErrors: internalResults.errors.length,
      };

      // Update job progress
      // Estimate total items based on batch processing (more accurate than arbitrary 1000)
      const estimatedTotal = result.hasMore
        ? totalProcessed + (batchSize * 2) // Assume at least 2 more batches remain
        : totalProcessed; // We're done, total = processed

      const progress = estimatedTotal > 0
        ? Math.round((totalProcessed / estimatedTotal) * 100)
        : 0;

      await db
        .update(syncJobs)
        .set({
          totalItems: estimatedTotal,
          processedItems: totalProcessed,
          successCount: result.synced,
          errorCount: result.failed,
          lastActivityAt: new Date(),
          metadata: {
            batchNumber,
            currentBatch: orders.length,
            hasNextPage: result.hasMore,
            progress: Math.round(progress),
            apiType: "graphql",
            stats: result.stats,
          },
        })
        .where(eq(syncJobs.id, jobId));

    } catch (error) {
      console.error(`Error in GraphQL orders batch ${batchNumber}:`, error);

      // Record the error but continue with next batch
      await db
        .update(syncJobs)
        .set({
          lastError: error instanceof Error ? error.message : "Unknown error",
          lastActivityAt: new Date(),
        })
        .where(eq(syncJobs.id, jobId));

      result.failed += batchSize; // Assume full batch failed
      result.errors.push({
        orderId: `batch_${batchNumber}`,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw error; // Re-throw to mark job as failed
    }

    // Update integration last sync timestamp
    await db
      .update(shopifyIntegrations)
      .set({
        lastOrderSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopifyIntegrations.organizationId, organizationId));

    // Log activity
    await db.insert(userActivityLogs).values({
      organizationId,
      userId: null, // System action
      action: "synced",
      resource: "shopify_orders",
      description: `Synced ${result.synced} orders from Shopify`,
      metadata: {
        source: "Shopify Sync",
        total: result.total,
        synced: result.synced,
        failed: result.failed,
        batches: batchNumber,
        apiType: "graphql",
        stats: result.stats,
      },
    });

    console.log(`GraphQL orders sync completed: ${result.synced} synced, ${result.failed} failed`);

    return result;

  } catch (error) {
    console.error("Error in GraphQL orders sync:", error);
    result.success = false;
    result.errors.push({
      orderId: "sync_job",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    throw error;
  }
}

/**
 * Process orders sync job using GraphQL with batch pagination
 */
export async function processOrdersSyncJobGraphQL(
  job: typeof syncJobs.$inferSelect
): Promise<void> {
  const batchSize = job.pageSize || 100; // Reduced default from 200 to 100 to prevent throttling
  let hasMore = true;
  let currentBatch = job.currentPage || 0;
  let totalProcessed = job.processedItems || 0;
  let totalSuccess = job.successCount || 0;
  let totalErrors = job.errorCount || 0;
  let totalSkipped = job.skipCount || 0;
  let totalEstimate = job.totalItems || 0;
  let cursor = job.nextPageToken || undefined;
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

      // Process a batch using GraphQL
      // NOTE: syncToInternal is set to FALSE here to avoid syncing on every batch
      // We'll do a single internal sync after all Shopify orders are fetched
      const result = await processOrdersSyncGraphQL({
        organizationId: job.organizationId,
        jobId: job.id,
        batchSize,
        cursor,
        dateFrom: job.config?.dateFrom,
        dateTo: job.config?.dateTo,
        syncToInternal: false, // Disable per-batch internal sync
        forceUpdate: job.config?.forceUpdate || false,
      });

      // Update counters
      totalProcessed += result.total;
      totalSuccess += result.synced;
      totalErrors += result.failed;

      if (result.total > 0) {
        totalEstimate = Math.max(totalEstimate, totalProcessed);
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

      cursor = result.nextCursor;
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
          nextPageToken: cursor || null,
          lastActivityAt: new Date(),
          estimatedCompletionAt: estimatedCompletion,
          metadata: {
            ...job.metadata,
            progress: Math.round(progress),
            lastBatchSize: result.total,
            stats: result.stats,
          },
        })
        .where(eq(syncJobs.id, job.id));

      // Check if we're done
      hasMore = result.hasMore && !!cursor;
      currentBatch++;

      // Add delay between batches to respect rate limits
      // Shopify GraphQL has cost-based rate limiting (default: 1000 points, restores at 50/second)
      // Longer delay helps prevent throttling, especially for large syncs
      // Progressive delay: starts at 500ms, increases to 2s after 5 batches
      if (hasMore) {
        const baseDelay = 500;
        const progressiveDelay = currentBatch > 5 ? 2000 : currentBatch > 3 ? 1000 : baseDelay;
        await new Promise(resolve => setTimeout(resolve, progressiveDelay));
      }

      if (result.stats) {
        totalInternalCreated += result.stats.internalCreated || 0;
        totalInternalUpdated += result.stats.internalUpdated || 0;
        totalInternalErrors += result.stats.internalErrors || 0;
        totalInternalSkipped += result.stats.internalSkipped || 0;
      }
    } catch (error) {
      console.error(`Error processing GraphQL orders batch ${currentBatch} for job ${job.id}:`, error);

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

  // Now that all Shopify orders are fetched, sync them to internal orders
  // This happens ONCE at the end instead of on every batch
  console.log(`[ORDERS-SYNC] All Shopify orders fetched. Starting internal sync...`);

  if (job.config?.syncToInternal !== false && totalSuccess > 0) {
    try {
      const { syncShopifyOrdersToInternalBatch } = await import("@/lib/shopify/sync-to-internal-batch");
      const internalResults = await syncShopifyOrdersToInternalBatch(
        job.organizationId,
        batchSize,
        job.config?.forceUpdate || false
      );

      console.log(`[ORDERS-SYNC] Internal sync complete:`, internalResults);

      totalInternalCreated = internalResults.created;
      totalInternalUpdated = internalResults.updated;
      totalInternalSkipped = internalResults.skipped;
      totalInternalErrors = internalResults.errors.length;
    } catch (error) {
      console.error(`[ORDERS-SYNC] Internal sync failed:`, error);
      totalInternalErrors = totalProcessed;
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