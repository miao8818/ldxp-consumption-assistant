(function attachLdxpStatsCore(root, factory) {
  "use strict";

  const api = factory();
  root.LdxpStatsCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createLdxpStatsCore() {
  "use strict";

  const DATE_TIME_PATTERN = /(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/;

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function parseMoneyToCents(value) {
    const normalized = String(value ?? "").replace(/,/g, "");
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    return match ? Math.round(Number(match[0]) * 100) : 0;
  }

  function parseQuantity(value) {
    const match = String(value ?? "").match(/(\d+)/);
    return match ? Number(match[1]) : 1;
  }

  function formatMoney(cents) {
    return `￥${(Number(cents || 0) / 100).toFixed(2)}`;
  }

  function isEffectiveStatus(status) {
    const value = normalizeText(status);
    if (!value) {
      return true;
    }
    return !/(待付款|未付款|已退款|退款中|已取消|已关闭|交易关闭|支付失败)/.test(value);
  }

  function extractOrderFromRow(row) {
    const cells = Array.from(row?.querySelectorAll?.("td") || []);
    if (cells.length < 4) {
      return null;
    }

    const firstCell = cells[0];
    const firstText = normalizeText(firstCell.textContent);
    const timeMatch = firstText.match(DATE_TIME_PATTERN);
    const createTime = normalizeText(
      firstCell.querySelector?.(".create-time")?.textContent ||
        (timeMatch ? `${timeMatch[1]} ${timeMatch[2]}` : ""),
    );

    const namedCandidates = Array.from(firstCell.querySelectorAll?.(".goods-name") || []);
    let productName = normalizeText(namedCandidates[0]?.textContent);
    if (!productName && createTime) {
      productName = normalizeText(firstText.replace(createTime, ""));
    }

    const orderNo = normalizeText(
      cells[1].querySelector?.(".goods-name")?.textContent || cells[1].textContent,
    );
    const amountText = normalizeText(
      cells[2].querySelector?.(".total_amount")?.textContent || cells[2].textContent,
    );
    const quantityText = normalizeText(
      cells[2].querySelector?.(".quantity")?.textContent || cells[2].textContent,
    );
    const status = normalizeText(
      cells[3].querySelector?.(".arco-tag")?.textContent || cells[3].textContent,
    );

    if (!orderNo || !productName || !createTime) {
      return null;
    }

    return {
      orderNo,
      productName,
      createTime,
      date: createTime.slice(0, 10),
      amountCents: parseMoneyToCents(amountText),
      quantity: parseQuantity(quantityText),
      status,
    };
  }

  function extractOrders(documentRoot) {
    const tables = Array.from(documentRoot?.querySelectorAll?.("table") || []);
    const orderTable = tables.find((table) => {
      const headers = normalizeText(table.querySelector?.("thead")?.textContent);
      return headers.includes("商品名") && headers.includes("订单号") && headers.includes("金额");
    });

    if (!orderTable) {
      return [];
    }

    return Array.from(orderTable.querySelectorAll("tbody tr"))
      .map(extractOrderFromRow)
      .filter(Boolean);
  }

  function getRangeStart(range, now = new Date()) {
    if (!range || range === "all") {
      return null;
    }

    const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === "today") {
      return current;
    }

    const days = Number(range);
    if (!Number.isFinite(days) || days <= 0) {
      return null;
    }
    current.setDate(current.getDate() - (days - 1));
    return current;
  }

  function applyFilters(orders, filters = {}, now = new Date()) {
    const keyword = normalizeText(filters.keyword).toLocaleLowerCase("zh-CN");
    const minCents = filters.minAmount === "" || filters.minAmount == null
      ? null
      : Math.round(Number(filters.minAmount) * 100);
    const maxCents = filters.maxAmount === "" || filters.maxAmount == null
      ? null
      : Math.round(Number(filters.maxAmount) * 100);
    const rangeStart = getRangeStart(filters.range, now);
    const rangeStartKey = rangeStart
      ? `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, "0")}-${String(rangeStart.getDate()).padStart(2, "0")}`
      : null;

    return orders.filter((order) => {
      if (keyword) {
        const haystack = `${order.productName} ${order.orderNo} ${order.status} ${order.createTime}`
          .toLocaleLowerCase("zh-CN");
        if (!haystack.includes(keyword)) {
          return false;
        }
      }
      if (Number.isFinite(minCents) && order.amountCents < minCents) {
        return false;
      }
      if (Number.isFinite(maxCents) && order.amountCents > maxCents) {
        return false;
      }
      if (rangeStartKey && order.date < rangeStartKey) {
        return false;
      }
      if (filters.status === "effective" && !isEffectiveStatus(order.status)) {
        return false;
      }
      if (filters.status && !["all", "effective"].includes(filters.status) && order.status !== filters.status) {
        return false;
      }
      return true;
    });
  }

  function sortOrders(orders, sort = "newest") {
    const copy = [...orders];
    const comparators = {
      newest: (a, b) => b.createTime.localeCompare(a.createTime),
      oldest: (a, b) => a.createTime.localeCompare(b.createTime),
      amountDesc: (a, b) => b.amountCents - a.amountCents || b.createTime.localeCompare(a.createTime),
      amountAsc: (a, b) => a.amountCents - b.amountCents || b.createTime.localeCompare(a.createTime),
    };
    return copy.sort(comparators[sort] || comparators.newest);
  }

  function summarize(orders) {
    const effective = orders.filter((order) => isEffectiveStatus(order.status));
    const totalCents = effective.reduce((sum, order) => sum + order.amountCents, 0);
    const dates = new Set(effective.map((order) => order.date));
    return {
      totalCents,
      orderCount: orders.length,
      effectiveCount: effective.length,
      averageCents: effective.length ? Math.round(totalCents / effective.length) : 0,
      activeDays: dates.size,
    };
  }

  function groupByDay(orders) {
    const groups = new Map();
    orders.forEach((order) => {
      const current = groups.get(order.date) || {
        date: order.date,
        totalCents: 0,
        orderCount: 0,
        effectiveCount: 0,
      };
      current.orderCount += 1;
      if (isEffectiveStatus(order.status)) {
        current.effectiveCount += 1;
        current.totalCents += order.amountCents;
      }
      groups.set(order.date, current);
    });
    return Array.from(groups.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  function mergeOrders(existing, incoming) {
    const byOrderNo = new Map(existing.map((order) => [order.orderNo, order]));
    incoming.forEach((order) => {
      const previous = byOrderNo.get(order.orderNo) || {};
      byOrderNo.set(order.orderNo, {
        ...previous,
        ...order,
        productUrl: order.productUrl || previous.productUrl || "",
      });
    });
    return sortOrders(Array.from(byOrderNo.values()), "newest");
  }

  return {
    applyFilters,
    extractOrderFromRow,
    extractOrders,
    formatMoney,
    groupByDay,
    isEffectiveStatus,
    mergeOrders,
    normalizeText,
    parseMoneyToCents,
    parseQuantity,
    sortOrders,
    summarize,
  };
});
