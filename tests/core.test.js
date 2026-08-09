"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core.js");

const orders = [
  {
    orderNo: "LD003",
    productName: "Plus 高级套餐",
    createTime: "2026-08-10 10:00:00",
    date: "2026-08-10",
    amountCents: 1299,
    quantity: 1,
    status: "已付款",
    productUrl: "https://pay.ldxp.cn/item/goods-3",
  },
  {
    orderNo: "LD002",
    productName: "短信验证服务",
    createTime: "2026-08-09 08:30:00",
    date: "2026-08-09",
    amountCents: 155,
    quantity: 2,
    status: "已退款",
  },
  {
    orderNo: "LD001",
    productName: "Codex 接码",
    createTime: "2026-08-08 20:15:00",
    date: "2026-08-08",
    amountCents: 250,
    quantity: 1,
    status: "已付款",
  },
];

test("金额解析与格式化保持分精度", () => {
  assert.equal(core.parseMoneyToCents("￥1,234.56 共1件"), 123456);
  assert.equal(core.parseMoneyToCents("18"), 1800);
  assert.equal(core.formatMoney(125), "￥1.25");
});

test("有效消费排除未付款、退款和关闭订单", () => {
  assert.equal(core.isEffectiveStatus("已付款"), true);
  assert.equal(core.isEffectiveStatus("已退款"), false);
  assert.equal(core.isEffectiveStatus("待付款"), false);
  assert.equal(core.isEffectiveStatus("交易关闭"), false);
});

test("支持商品名和订单号关键字筛选", () => {
  assert.deepEqual(core.applyFilters(orders, { keyword: "plus", status: "all" }).map((item) => item.orderNo), ["LD003"]);
  assert.deepEqual(core.applyFilters(orders, { keyword: "LD001", status: "all" }).map((item) => item.orderNo), ["LD001"]);
});

test("金额区间筛选包含边界", () => {
  const result = core.applyFilters(orders, {
    minAmount: "2.50",
    maxAmount: "12.99",
    status: "all",
  });
  assert.deepEqual(result.map((item) => item.orderNo), ["LD003", "LD001"]);
});

test("日期范围按本地自然日计算", () => {
  const now = new Date(2026, 7, 10, 21, 0, 0);
  const result = core.applyFilters(orders, { range: "today", status: "all" }, now);
  assert.deepEqual(result.map((item) => item.orderNo), ["LD003"]);
});

test("时间和金额均支持升降序", () => {
  assert.deepEqual(core.sortOrders(orders, "newest").map((item) => item.orderNo), ["LD003", "LD002", "LD001"]);
  assert.deepEqual(core.sortOrders(orders, "oldest").map((item) => item.orderNo), ["LD001", "LD002", "LD003"]);
  assert.deepEqual(core.sortOrders(orders, "amountDesc").map((item) => item.orderNo), ["LD003", "LD001", "LD002"]);
  assert.deepEqual(core.sortOrders(orders, "amountAsc").map((item) => item.orderNo), ["LD002", "LD001", "LD003"]);
});

test("摘要只把有效订单计入消费金额和笔均", () => {
  assert.deepEqual(core.summarize(orders), {
    totalCents: 1549,
    orderCount: 3,
    effectiveCount: 2,
    averageCents: 775,
    activeDays: 2,
  });
});

test("每日统计保留筛选结果笔数但不累计退款金额", () => {
  const daily = core.groupByDay(orders);
  assert.equal(daily[1].date, "2026-08-09");
  assert.equal(daily[1].orderCount, 1);
  assert.equal(daily[1].totalCents, 0);
});

test("分页合并按订单号去重并保留商品链接", () => {
  const merged = core.mergeOrders(orders, [{
    ...orders[0],
    productName: "Plus 高级套餐（更新）",
    productUrl: "",
  }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].productName, "Plus 高级套餐（更新）");
  assert.equal(merged[0].productUrl, "https://pay.ldxp.cn/item/goods-3");
});
