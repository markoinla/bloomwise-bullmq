/**
 * Enhanced Orders Query - Comprehensive field collection
 * This is the most complete version of the order query
 */

export const ENHANCED_ORDERS_QUERY = `
  query getOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          email
          phone
          processedAt
          createdAt
          updatedAt
          cancelledAt
          cancelReason
          edited
          test

          # Financial info - comprehensive with presentment currency
          totalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          subtotalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalTaxSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalDiscountsSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalShippingPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalTipReceivedSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          currentTotalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          currentSubtotalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          currentTotalTaxSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          currentTotalDiscountsSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          cartDiscountAmountSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }

          # Status fields
          displayFulfillmentStatus
          displayFinancialStatus
          confirmed
          closed
          fullyPaid
          unpaid
          restockable

          # Additional metadata
          riskLevel
          clientIp
          customerLocale
          merchantEditable
          poNumber
          sourceIdentifier
          sourceName
          statusPageUrl
          subtotalLineItemsQuantity

          # Channel info
          channelInformation {
            channelId
            channelDefinition {
              channelName
              handle
            }
          }

          # Customer info
          customer {
            id
            legacyResourceId
            firstName
            lastName
            email
            phone
            createdAt
            updatedAt
          }

          # Customer journey
          customerJourneySummary {
            momentsCount {
              count
            }
            ready
          }

          # Shipping address - enhanced
          shippingAddress {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            countryCodeV2
            zip
            phone
            latitude
            longitude
          }

          # Billing address - enhanced
          billingAddress {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            countryCodeV2
            zip
            phone
            latitude
            longitude
          }

          # Line items - comprehensive
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                name
                quantity
                requiresShipping
                fulfillableQuantity
                fulfillmentStatus
                taxable
                vendor
                variantTitle

                variant {
                  id
                  legacyResourceId
                  title
                  sku
                  barcode
                  price
                  product {
                    id
                    legacyResourceId
                    title
                    productType
                    vendor
                  }
                }

                # Pricing - comprehensive
                originalUnitPriceSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }
                discountedUnitPriceSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }
                discountedTotalSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }
                originalTotalSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }

                # Tax lines
                taxLines {
                  title
                  rate
                  ratePercentage
                  priceSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                }

                # Discount allocations
                discountAllocations {
                  allocatedAmountSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  discountApplication {
                    ... on DiscountCodeApplication {
                      code
                      value {
                        ... on MoneyV2 { amount currencyCode }
                        ... on PricingPercentageValue { percentage }
                      }
                    }
                    ... on ManualDiscountApplication {
                      title
                      description
                      value {
                        ... on MoneyV2 { amount currencyCode }
                        ... on PricingPercentageValue { percentage }
                      }
                    }
                    ... on ScriptDiscountApplication {
                      title
                      description
                    }
                    ... on AutomaticDiscountApplication {
                      title
                    }
                  }
                }

                customAttributes {
                  key
                  value
                }

                # Duties (international orders)
                duties {
                  id
                  harmonizedSystemCode
                  countryCodeOfOrigin
                  price {
                    shopMoney { amount currencyCode }
                  }
                  taxLines {
                    title
                    priceSet {
                      shopMoney { amount currencyCode }
                    }
                  }
                }
              }
            }
          }

          # Fulfillments - enhanced
          fulfillments {
            id
            legacyResourceId
            status
            createdAt
            updatedAt
            deliveredAt
            displayStatus
            estimatedDeliveryAt
            inTransitAt
            name
            requiresShipping

            trackingInfo {
              company
              number
              url
            }

            fulfillmentLineItems(first: 100) {
              edges {
                node {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
            }

            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }

          # Shipping lines - enhanced
          shippingLines(first: 10) {
            edges {
              node {
                id
                title
                code
                source
                phone
                deliveryCategory
                carrierIdentifier

                requestedFulfillmentService {
                  serviceName
                  type
                }

                originalPriceSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }

                discountedPriceSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }

                taxLines {
                  title
                  rate
                  priceSet {
                    shopMoney { amount currencyCode }
                  }
                }
              }
            }
          }

          # Transactions - payment details
          transactions(first: 50) {
            edges {
              node {
                id
                kind
                status
                processedAt
                gateway
                test
                errorCode

                paymentIcon {
                  url
                }

                paymentDetails {
                  ... on CardPaymentDetails {
                    avsResultCode
                    bin
                    company
                    cvvResultCode
                    expirationMonth
                    expirationYear
                    name
                    number
                    wallet
                  }
                }

                amountSet {
                  shopMoney { amount currencyCode }
                  presentmentMoney { amount currencyCode }
                }

                totalUnsettledSet {
                  shopMoney { amount currencyCode }
                }
              }
            }
          }

          # Refunds
          refunds {
            id
            createdAt
            note

            totalRefundedSet {
              shopMoney { amount currencyCode }
              presentmentMoney { amount currencyCode }
            }

            refundLineItems(first: 100) {
              edges {
                node {
                  quantity
                  restockType
                  restocked

                  lineItem {
                    id
                  }

                  subtotalSet {
                    shopMoney { amount currencyCode }
                  }

                  totalTaxSet {
                    shopMoney { amount currencyCode }
                  }
                }
              }
            }

            transactions(first: 10) {
              edges {
                node {
                  id
                  kind
                  status
                  amountSet {
                    shopMoney { amount currencyCode }
                  }
                }
              }
            }
          }

          # Note
          note

          # Custom attributes (order-level form fields)
          customAttributes {
            key
            value
          }

          # Tags
          tags

          # Metafields
          metafields(first: 50) {
            edges {
              node {
                id
                namespace
                key
                value
                type
                description
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;
