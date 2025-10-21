# Comprehensive Shopify Order Fields

This document shows all fields we could add to our order query for maximum data capture.

## Fields We're Currently Missing

### Order-Level Fields
- `edited` - Whether order has been edited
- `test` - Whether this is a test order
- `fullyPaid` - Payment status flag
- `unpaid` - Payment status flag
- `restockable` - Whether items can be restocked
- `riskLevel` - Fraud risk assessment
- `clientIp` - Customer's IP address
- `customerLocale` - Customer's locale
- `merchantEditable` - Whether merchant can edit
- `poNumber` - Purchase order number
- `sourceIdentifier` - Source system identifier
- `sourceName` - Source channel name
- `statusPageUrl` - Order status page URL
- `subtotalLineItemsQuantity` - Total item quantity

### Additional Money Fields
- `totalShippingPriceSet` - Total shipping cost
- `totalTipReceivedSet` - Tips received
- `currentTotalPriceSet` - Current total (after refunds)
- `currentSubtotalPriceSet` - Current subtotal
- `currentTotalTaxSet` - Current tax total
- `currentTotalDiscountsSet` - Current discounts
- `cartDiscountAmountSet` - Cart-level discounts
- `presentmentMoney` - Customer-facing currency

### Line Item Fields
- `name` - Full line item name
- `requiresShipping` - Shipping required flag
- `fulfillableQuantity` - Quantity that can be fulfilled
- `fulfillmentStatus` - Status per item
- `taxable` - Tax applicability
- `vendor` - Product vendor
- `variantTitle` - Variant display title
- `originalTotalSet` - Original total before discounts
- `taxLines` - Detailed tax breakdown
- `discountAllocations` - Discount details
- `duties` - International duties

### Fulfillment Fields
- `deliveredAt` - Actual delivery timestamp
- `displayStatus` - Display-friendly status
- `estimatedDeliveryAt` - Estimated delivery
- `inTransitAt` - In-transit timestamp
- `name` - Fulfillment name/number
- `fulfillmentOrders` - Related fulfillment orders

### Shipping Line Fields
- `source` - Shipping source
- `phone` - Shipping contact phone
- `requestedFulfillmentService` - Fulfillment service details
- `deliveryCategory` - Delivery category
- `carrierIdentifier` - Carrier ID
- `discountedPriceSet` - Shipping after discounts
- `taxLines` - Shipping tax breakdown

### Transaction Fields (Payment Details)
- `transactions` - All payment transactions
  - `kind` - Transaction type (sale, refund, etc.)
  - `status` - Transaction status
  - `processedAt` - When processed
  - `gateway` - Payment gateway
  - `paymentDetails` - Card details, etc.
  - `amountSet` - Transaction amount
  - `errorCode` - Any errors

### Refund Fields
- `refunds` - All refunds for the order
  - `note` - Refund reason
  - `totalRefundedSet` - Amount refunded
  - `refundLineItems` - Items refunded
  - `transactions` - Refund transactions

### Additional Fields
- `channelInformation` - Sales channel details
- `customerJourneySummary` - Customer journey data
- `provinceCode` / `countryCode` - Address codes
- `latitude` / `longitude` - Address geocoding

## Recommendation

I'll create an **enhanced** version of the ORDERS_QUERY that includes the most useful fields for your use case while keeping query cost reasonable.

Priority additions:
1. ✅ `customAttributes` (already added)
2. Transaction data (for payment tracking)
3. Refund data (for order management)
4. Additional money fields (tips, current totals after refunds)
5. Channel information (know where order came from)
6. Risk level (fraud detection)
7. More fulfillment details (tracking, delivery dates)
