#!/bin/bash

# Test the internal orders sync endpoint
# This syncs orders from shopify_orders table to internal tables without calling Shopify API

ORGANIZATION_ID="dbe20573-5df8-4996-a8e8-29fe6aed35b4"
API_URL="http://localhost:3001/api/sync/orders/internal"

echo "Testing internal orders sync..."
echo "Organization ID: $ORGANIZATION_ID"
echo ""

# Test 1: Sync all orders for the organization
echo "Test 1: Sync ALL orders from shopify_orders table"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"organizationId\": \"$ORGANIZATION_ID\"
  }" | jq .

echo ""
echo ""

# Test 2: Sync specific orders
echo "Test 2: Sync SPECIFIC orders by shopifyOrderId"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"organizationId\": \"$ORGANIZATION_ID\",
    \"shopifyOrderIds\": [\"6886828671148\", \"6884822253740\"]
  }" | jq .

echo ""
echo "Done! Check the sync job status at the statusUrl returned above."
