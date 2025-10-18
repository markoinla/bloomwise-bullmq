/**
 * Database query helpers for the worker
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../config/database';
import { syncJobs, shopifyIntegrations, type SyncJob, type ShopifyIntegration } from './schema';
import { logger } from '../lib/utils/logger';

// ============================================
// Shopify Integration Queries
// ============================================

export async function getShopifyIntegration(integrationId: string): Promise<ShopifyIntegration | null> {
  try {
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.id, integrationId))
      .limit(1);

    return integration || null;
  } catch (error) {
    logger.error({ error, integrationId }, 'Failed to fetch Shopify integration');
    throw error;
  }
}

export async function getShopifyIntegrationByOrg(organizationId: string): Promise<ShopifyIntegration | null> {
  try {
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

    return integration || null;
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to fetch Shopify integration by org');
    throw error;
  }
}

// ============================================
// Sync Job Queries
// ============================================

export async function getSyncJob(syncJobId: string): Promise<SyncJob | null> {
  try {
    const [job] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, syncJobId))
      .limit(1);

    return job || null;
  } catch (error) {
    logger.error({ error, syncJobId }, 'Failed to fetch sync job');
    throw error;
  }
}

export async function updateSyncJobStatus(
  syncJobId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused',
  updates?: Partial<{
    errorMessage: string;
    lastError: string;
    startedAt: Date;
    completedAt: Date;
  }>
): Promise<void> {
  try {
    await db
      .update(syncJobs)
      .set({
        status,
        updatedAt: new Date(),
        ...updates,
      })
      .where(eq(syncJobs.id, syncJobId));

    logger.info({ syncJobId, status }, 'Updated sync job status');
  } catch (error) {
    logger.error({ error, syncJobId, status }, 'Failed to update sync job status');
    throw error;
  }
}

export async function updateSyncJobProgress(
  syncJobId: string,
  progress: {
    processedItems?: number;
    totalItems?: number;
    successCount?: number;
    errorCount?: number;
    skipCount?: number;
    lastProcessedId?: string;
    nextPageToken?: string;
  }
): Promise<void> {
  try {
    await db
      .update(syncJobs)
      .set({
        ...progress,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, syncJobId));

    logger.debug({ syncJobId, progress }, 'Updated sync job progress');
  } catch (error) {
    logger.error({ error, syncJobId }, 'Failed to update sync job progress');
    throw error;
  }
}

export async function markSyncJobRunning(syncJobId: string): Promise<void> {
  await updateSyncJobStatus(syncJobId, 'running', {
    startedAt: new Date(),
  });
}

export async function markSyncJobCompleted(
  syncJobId: string,
  finalCounts: {
    totalItems: number;
    processedItems: number;
    successCount: number;
    errorCount: number;
    skipCount: number;
  }
): Promise<void> {
  await db
    .update(syncJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
      ...finalCounts,
    })
    .where(eq(syncJobs.id, syncJobId));

  logger.info({ syncJobId, finalCounts }, 'Sync job completed');
}

export async function markSyncJobFailed(
  syncJobId: string,
  errorMessage: string,
  errorDetails?: any
): Promise<void> {
  await db
    .update(syncJobs)
    .set({
      status: 'failed',
      errorMessage,
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(syncJobs.id, syncJobId));

  logger.error({ syncJobId, errorMessage, errorDetails }, 'Sync job failed');
}
