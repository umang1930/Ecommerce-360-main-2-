import type { CatalogProduct, OrderFact } from "./demo-source";
import { fetchFlipkartDeliveredOrders, fetchFlipkartOrders } from "./flipkart-seller-api.server";
import { fetchAmazonOrders } from "./amazon-sp-api.server";
import { canonicalFlipkartSku, inferFlipkartBrand, canonicalBrand } from "./brands";
import {
  eachDay,
  formatDayLabel,
  formatRangeLabel,
  previousRange,
  resolveRange,
  type DateRange,
} from "./dates";
import { safeDivide } from "./format";
import type {
  DashboardData,
  DashboardFilters,
  MarketplacePerformance,
  MetricTotals,
  SalesTrendPoint,
  TopProduct,
} from "./types";

function matches(fact: OrderFact, filters: DashboardFilters, range: DateRange) {
  if (fact.date < range.start || fact.date > range.end) return false;
  if (filters.brand !== "all" && fact.brand !== filters.brand) return false;
  if (filters.marketplace !== "all" && fact.marketplace !== filters.marketplace) return false;
  if (filters.product !== "all" && fact.sku !== filters.product) return false;
  return true;
}

function totals(facts: OrderFact[]): MetricTotals {
  const orders =
    new Set(facts.filter((fact) => fact.orderId).map((fact) => fact.orderId)).size +
    facts.filter((fact) => !fact.orderId).reduce((sum, f) => sum + f.orders, 0);
  const grossSales = facts.reduce((sum, f) => sum + f.grossSales, 0);
  const unitsSold = facts.reduce((sum, f) => sum + f.unitsSold, 0);
  return { orders, grossSales, unitsSold, averageOrderValue: safeDivide(grossSales, orders) };
}

function buildTrend(facts: OrderFact[], range: DateRange): SalesTrendPoint[] {
  const byDate = new Map<string, SalesTrendPoint>();
  const orderIdsByDate = new Map<string, Set<string>>();
  for (const date of eachDay(range.start, range.end)) {
    byDate.set(date, {
      date,
      label: formatDayLabel(date),
      grossSales: 0,
      orders: 0,
      unitsSold: 0,
    });
  }
  for (const fact of facts) {
    const point = byDate.get(fact.date);
    if (!point) continue;
    point.grossSales += fact.grossSales;
    if (fact.orderId) {
      const ids = orderIdsByDate.get(fact.date) ?? new Set<string>();
      ids.add(fact.orderId);
      orderIdsByDate.set(fact.date, ids);
      point.orders = ids.size;
    } else point.orders += fact.orders;
    point.unitsSold += fact.unitsSold;
  }
  return [...byDate.values()];
}

function buildMarketplaces(facts: OrderFact[]): MarketplacePerformance[] {
  const totalSales = facts.reduce((sum, f) => sum + f.grossSales, 0);
  const map = new Map<string, MarketplacePerformance>();
  const orderIds = new Map<string, Set<string>>();
  for (const fact of facts) {
    const entry = map.get(fact.marketplace) ?? {
      marketplace: fact.marketplace,
      grossSales: 0,
      orders: 0,
      unitsSold: 0,
      share: 0,
    };
    entry.grossSales += fact.grossSales;
    if (fact.orderId) {
      const ids = orderIds.get(fact.marketplace) ?? new Set<string>();
      ids.add(fact.orderId);
      orderIds.set(fact.marketplace, ids);
      entry.orders = ids.size;
    } else entry.orders += fact.orders;
    entry.unitsSold += fact.unitsSold;
    map.set(fact.marketplace, entry);
  }
  return [...map.values()]
    .map((entry) => ({
      ...entry,
      share: totalSales ? (entry.grossSales / totalSales) * 100 : 0,
    }))
    .sort((a, b) => b.grossSales - a.grossSales);
}

function buildTopProducts(facts: OrderFact[], catalog: CatalogProduct[]): TopProduct[] {
  const totalSales = facts.reduce((sum, f) => sum + f.grossSales, 0);
  const map = new Map<string, TopProduct>();
  for (const fact of facts) {
    const meta = catalog.find((p) => p.sku === fact.sku);
    if (!meta) continue;
    const entry = map.get(fact.sku) ?? {
      sku: meta.sku,
      name: meta.name,
      brand: meta.brand,
      orders: 0,
      unitsSold: 0,
      grossSales: 0,
      contribution: 0,
    };
    entry.orders += fact.orders;
    entry.unitsSold += fact.unitsSold;
    entry.grossSales += fact.grossSales;
    map.set(fact.sku, entry);
  }
  return [...map.values()].map((entry) => ({
    ...entry,
    contribution: totalSales ? (entry.grossSales / totalSales) * 100 : 0,
  }));
}

export async function fetchDashboardDataOnServer(
  filters: DashboardFilters,
  includePreviousPeriod = true,
): Promise<DashboardData> {
  const range = resolveRange(filters);
  const prev = previousRange(range);
  const fetchStart = includePreviousPeriod ? prev.start : range.start;
  const amazonDateRange = {
    createdAfter: `${fetchStart}T00:00:00+05:30`,
    createdBefore: new Date(
      // Leave time for the LWA token exchange and network latency;
      // Amazon requires createdBefore to be at least two minutes old
      // when the Orders request reaches their server.
      Math.min(Date.now() - 5 * 60_000, Date.parse(`${range.end}T23:59:59+05:30`)),
    ).toISOString(),
  };
  const [flipkartClaspo, flipkartMonkeyman, amazonClaspo, amazonMonkeyman, deliveredClaspo, deliveredMonkeyman] = await Promise.all([
    filters.marketplace !== "Amazon" && filters.brand !== "MONKEYMAN"
      ? fetchFlipkartOrders({
          data: {
            fromDate: `${fetchStart}T00:00:00`,
            toDate: `${range.end}T23:59:59`,
            seller: "claspo",
          },
        })
      : Promise.resolve(null),
    filters.marketplace !== "Amazon" && filters.brand !== "CLASPO"
      ? fetchFlipkartOrders({
          data: {
            fromDate: `${fetchStart}T00:00:00`,
            toDate: `${range.end}T23:59:59`,
            seller: "monkeyman",
          },
        })
      : Promise.resolve(null),
    filters.marketplace !== "Flipkart" && filters.brand !== "MONKEYMAN"
      ? fetchAmazonOrders({
          data: { ...amazonDateRange, seller: "claspo" },
        })
      : Promise.resolve(null),
    filters.marketplace !== "Flipkart" && filters.brand !== "CLASPO"
      ? fetchAmazonOrders({
          data: { ...amazonDateRange, seller: "monkeyman" },
        })
      : Promise.resolve(null),
    filters.marketplace !== "Amazon" && filters.brand !== "MONKEYMAN"
      ? fetchFlipkartDeliveredOrders({
          data: { fromDate: `${fetchStart}T00:00:00`, toDate: `${range.end}T23:59:59`, seller: "claspo" },
        })
      : Promise.resolve(null),
    filters.marketplace !== "Amazon" && filters.brand !== "CLASPO"
      ? fetchFlipkartDeliveredOrders({
          data: { fromDate: `${fetchStart}T00:00:00`, toDate: `${range.end}T23:59:59`, seller: "monkeyman" },
        })
      : Promise.resolve(null),
  ]);
  const amazonResults = [amazonClaspo, amazonMonkeyman].filter((result) => result !== null);
  const amazonOrdersConfigured = amazonResults.some((result) => result?.configured);
  if (
    filters.marketplace === "Amazon" &&
    filters.brand === "CLASPO" &&
    amazonClaspo &&
    !amazonClaspo.configured
  )
    throw new Error(
      "Claspo Amazon SP-API is not configured on the server. Add AMAZON_SP_API_* production credentials to the server .env (or deployment secrets), then restart the server.",
    );
  if (
    filters.marketplace === "Amazon" &&
    filters.brand === "MONKEYMAN" &&
    amazonMonkeyman &&
    !amazonMonkeyman.configured
  )
    throw new Error(
      "Monkeyman Amazon SP-API is not configured on the server. Add AMAZON_SP_API_MONKEYMAN_* production credentials to the server .env (or deployment secrets), then restart the server.",
    );
  if (filters.marketplace === "Amazon" && filters.brand === "all" && !amazonOrdersConfigured)
    throw new Error(
      "Amazon SP-API is not configured on the server. Add production credentials to the server .env (or deployment secrets), then restart the server.",
    );
  if (
    filters.marketplace !== "Amazon" &&
    filters.brand === "CLASPO" &&
    flipkartClaspo &&
    !flipkartClaspo.configured
  )
    throw new Error(
      "Flipkart Seller API is not configured on the server. Add its credentials to the server environment.",
    );
  if (
    filters.marketplace !== "Amazon" &&
    filters.brand === "MONKEYMAN" &&
    flipkartMonkeyman &&
    !flipkartMonkeyman.configured
  )
    throw new Error(
      "Monkeyman Flipkart Seller API is not configured on the server. Add FLIPKART_MONKEYMAN_APP_ID and FLIPKART_MONKEYMAN_APP_SECRET to the server environment.",
    );
  if (!flipkartClaspo?.configured && !flipkartMonkeyman?.configured && !amazonOrdersConfigured)
    throw new Error(
      "No marketplace API is configured. Add Amazon SP-API or Flipkart Seller API credentials to the server environment.",
    );
  const flipkartErrors = [flipkartClaspo?.message, flipkartMonkeyman?.message].filter(
    (message): message is string => Boolean(message),
  );
  const flipkartWarnings = [
    flipkartClaspo?.warning && { brand: "CLASPO", message: flipkartClaspo.warning },
    flipkartMonkeyman?.warning && { brand: "MONKEYMAN", message: flipkartMonkeyman.warning },
  ].filter((warning): warning is { brand: string; message: string } => Boolean(warning));
  if (filters.marketplace !== "Amazon" && filters.brand === "CLASPO" && flipkartClaspo?.message)
    throw new Error(flipkartClaspo.message);
  if (
    filters.marketplace !== "Amazon" &&
    filters.brand === "MONKEYMAN" &&
    flipkartMonkeyman?.message
  )
    throw new Error(flipkartMonkeyman.message);
  if (
    filters.marketplace === "Flipkart" &&
    flipkartErrors.length > 0 &&
    ![flipkartClaspo, flipkartMonkeyman].some((result) => result?.configured && !result.message)
  )
    throw new Error(flipkartErrors.join(" "));
  const amazonErrors = amazonResults
    .filter((result) => result?.message)
    .map((result) => result!.message!);
  if (
    filters.marketplace === "Amazon" &&
    filters.brand !== "all" &&
    amazonResults.length === 1 &&
    amazonResults[0]?.message
  )
    throw new Error(amazonResults[0].message);
  if (
    filters.marketplace === "Amazon" &&
    amazonErrors.length > 0 &&
    !amazonResults.some((result) => result?.configured && !result.message)
  )
    throw new Error(amazonErrors.join(" "));

  const deliveredFlipkartItems = [
    ...(deliveredClaspo?.orders ?? []),
    ...(deliveredMonkeyman?.orders ?? []),
  ].filter((order) => order.orderDate && order.orderItemId);
  const allOrders = [
    ...(flipkartClaspo?.orders ?? []),
    ...(flipkartMonkeyman?.orders ?? []),
    ...deliveredFlipkartItems,
  ].filter((order) =>
    order.orderDate &&
    order.orderItemId,
  );
  // Orders search omits delivered shipments on some Seller API accounts.
  // Merge its results with the delivered shipments feed, then dedupe items.
  const uniqueFlipkartItems = [
    ...new Map(
      allOrders.map((order) => {
        const brand = order.brand ?? inferFlipkartBrand(order.sku, order.title);
        return [`${brand}:${order.orderItemId}`, order] as const;
      }),
    ).values(),
  ];
  const amazonOrderItems = [
    ...(amazonClaspo?.orders ?? []),
    ...(amazonMonkeyman?.orders ?? []),
  ].filter((order) => order.orderDate && order.orderId);
  const seenAmazonItems = new Set<string>();
  const liveAmazonOrders = amazonOrderItems.filter((order) => {
    if (!order.orderItemId) return true;
    const itemKey = `${canonicalBrand(order.brand)}:${order.orderItemId}`;
    if (seenAmazonItems.has(itemKey)) return false;
    seenAmazonItems.add(itemKey);
    return true;
  });
  const facts: OrderFact[] = uniqueFlipkartItems
    .map((order) => ({
      orderId: order.orderId,
      date: order.orderDate.slice(0, 10),
      brand: order.brand ?? inferFlipkartBrand(order.sku, order.title),
      marketplace: "Flipkart",
      sku: canonicalFlipkartSku(order.sku, order.title) || order.orderItemId,
      orders: 1,
      unitsSold: order.quantity,
      grossSales: order.customerPrice,
    }));
  facts.push(
    ...liveAmazonOrders
      .map((order) => ({
        orderId: order.orderId,
        date: order.orderDate.slice(0, 10),
        brand: canonicalBrand(order.brand),
        marketplace: "Amazon",
        sku: order.sku || order.title,
        orders: 0,
        unitsSold: order.quantity,
        grossSales: order.itemPrice,
      })),
  );
  const catalogEntries: [string, CatalogProduct][] = [
    ...uniqueFlipkartItems.map((order): [string, CatalogProduct] => {
      const sku = canonicalFlipkartSku(order.sku, order.title) || order.orderItemId;
      return [
        sku,
        {
          sku,
          name: order.title || sku,
          brand: order.brand ?? inferFlipkartBrand(order.sku, order.title),
          price: order.quantity ? order.customerPrice / order.quantity : 0,
          weight: 1,
        } satisfies CatalogProduct,
      ];
    }),
    ...liveAmazonOrders.map((order) => {
      const sku = order.sku || order.title;
      const brand = canonicalBrand(order.brand);
      return [
        sku,
        {
          sku,
          name: order.title || sku,
          brand,
          price: order.quantity ? order.itemPrice / order.quantity : 0,
          weight: 1,
        } satisfies CatalogProduct,
      ] as [string, CatalogProduct];
    }),
  ];
  const catalog: CatalogProduct[] = [...new Map(catalogEntries).values()];
  const current = facts.filter((f) => matches(f, filters, range));
  const previous = facts.filter((f) => matches(f, filters, prev));
  const exceptions = flipkartWarnings
    .filter(({ brand }) => filters.brand === "all" || filters.brand === brand)
    .map(({ brand, message }, index) => ({
      id: `flipkart-pagination-${brand.toLowerCase()}-${index}`,
      title: `${brand} Flipkart orders are incomplete`,
      description: message,
      severity: "warning" as const,
    }));
  const deliveredWarnings = [
    deliveredClaspo?.warning && { brand: "CLASPO", message: deliveredClaspo.warning },
    deliveredMonkeyman?.warning && { brand: "MONKEYMAN", message: deliveredMonkeyman.warning },
    deliveredClaspo?.message && { brand: "CLASPO", message: deliveredClaspo.message },
    deliveredMonkeyman?.message && { brand: "MONKEYMAN", message: deliveredMonkeyman.message },
  ].filter((warning): warning is { brand: string; message: string } => Boolean(warning));
  for (const [index, { brand, message }] of deliveredWarnings.entries()) {
    if (filters.brand !== "all" && filters.brand !== brand) continue;
    exceptions.push({
      id: `flipkart-delivered-${brand.toLowerCase()}-${index}`,
      title: `${brand} Flipkart completed orders may be incomplete`,
      description: message,
      severity: "warning",
    });
  }
  if (filters.brand === "all") {
    for (const [index, message] of flipkartErrors.entries()) {
      exceptions.push({
        id: `flipkart-connection-${index}`,
        title: "Flipkart account connection issue",
        description: message,
        severity: "warning" as const,
      });
    }
  }
  const missingProductCount =
    uniqueFlipkartItems.filter((order) => !order.sku?.trim() && !order.title?.trim()).length +
    liveAmazonOrders.filter((order) => !order.sku?.trim() && !order.title?.trim()).length;
  const invalidSalesCount =
    uniqueFlipkartItems.filter((order) => !Number.isFinite(order.customerPrice) || order.customerPrice <= 0)
      .length +
    liveAmazonOrders.filter((order) => !Number.isFinite(order.itemPrice) || order.itemPrice <= 0)
      .length;

  if (missingProductCount > 0) {
    exceptions.push({
      id: "orders-missing-product",
      title: "Product details missing",
      description: `${missingProductCount} order${missingProductCount === 1 ? "" : "s"} missing both SKU and title.`,
      severity: "warning" as const,
    });
  }
  if (invalidSalesCount > 0) {
    exceptions.push({
      id: "orders-invalid-sales",
      title: "Sales value needs review",
      description: `${invalidSalesCount} order${invalidSalesCount === 1 ? "" : "s"} with missing or zero sales value.`,
      severity: "warning" as const,
    });
  }

  return {
    metrics: { ...totals(current), previousPeriod: totals(previous) },
    trend: buildTrend(current, range),
    marketplaces: buildMarketplaces(current),
    topProducts: buildTopProducts(current, catalog),
    exceptions,
    rangeLabel: `${formatRangeLabel(range)} · ${[amazonOrdersConfigured && "Amazon", (flipkartClaspo?.configured || flipkartMonkeyman?.configured) && "Flipkart"].filter(Boolean).join(" + ")}`,
    catalog: catalog.map(({ sku, name, brand }) => ({ sku, name, brand })),
    sourceLabel: [
      amazonOrdersConfigured && "Amazon SP-API",
      (flipkartClaspo?.configured || flipkartMonkeyman?.configured) && "Flipkart Seller API",
    ]
      .filter(Boolean)
      .join(" + "),
    flipkartOrders: uniqueFlipkartItems.filter((order) => {
      const date = order.orderDate.slice(0, 10);
      return date >= range.start && date <= range.end;
    }).map((order) => ({ ...order, brand: order.brand ?? inferFlipkartBrand(order.sku, order.title) as "CLASPO" | "MONKEYMAN" })),
    deliveredFlipkartOrders: deliveredFlipkartItems
      .filter((order) => {
        const date = order.orderDate.slice(0, 10);
        return date >= range.start && date <= range.end;
      })
      .map((order) => ({
        brand: order.brand ?? inferFlipkartBrand(order.sku, order.title) as "CLASPO" | "MONKEYMAN",
        orderId: order.orderId,
        orderItemId: order.orderItemId,
        shipmentId: order.shipmentId,
        status: order.status,
        title: order.title,
        sku: order.sku,
        orderDate: order.orderDate,
      })),
    amazonOrders: liveAmazonOrders.filter((order) => {
      const date = order.orderDate.slice(0, 10);
      return date >= range.start && date <= range.end;
    }),
  };
}
