(function observeOrderListResponses() {
  "use strict";

  const productLinks = new Map();

  function capturePayload(payload) {
    const list = payload?.data?.list;
    if (!Array.isArray(list)) {
      return;
    }

    let changed = false;
    list.forEach((order) => {
      const orderNo = String(order?.trade_no || "").trim();
      const goodsKey = String(order?.goods?.goods_key || "").trim();
      if (!orderNo || !goodsKey) {
        return;
      }
      const productUrl = `${location.origin}/item/${encodeURIComponent(goodsKey)}`;
      if (productLinks.get(orderNo) !== productUrl) {
        productLinks.set(orderNo, productUrl);
        changed = true;
      }
    });

    if (changed) {
      publish();
    }
  }

  function publish() {
    document.dispatchEvent(new CustomEvent("ldxp:product-links", {
      detail: JSON.stringify(Object.fromEntries(productLinks)),
    }));
  }

  function isOrderListUrl(url) {
    return String(url || "").includes("/shopApi/Order/list");
  }

  function sanitizeOrder(order) {
    const goodsKey = String(order?.goods?.goods_key || "").trim();
    return {
      orderNo: String(order?.trade_no || "").trim(),
      productName: String(order?.goods_name || "").trim(),
      createTimestamp: Number(order?.create_time) || 0,
      totalAmount: String(order?.total_amount ?? "0"),
      quantity: Number(order?.quantity) || 1,
      status: Number(order?.status),
      productUrl: goodsKey ? `${location.origin}/item/${encodeURIComponent(goodsKey)}` : "",
    };
  }

  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function patchedFetch(...args) {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      const promise = nativeFetch.apply(this, args);
      if (isOrderListUrl(requestUrl)) {
        promise.then((response) => response.clone().json()).then(capturePayload).catch(() => {});
      }
      return promise;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    requestUrls.set(this, url);
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    if (isOrderListUrl(requestUrls.get(this))) {
      this.addEventListener("loadend", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          capturePayload(payload);
        } catch {
          // Ignore non-JSON and failed responses without changing page behavior.
        }
      }, { once: true });
    }
    return nativeSend.apply(this, args);
  };

  document.addEventListener("ldxp:fetch-order-batch", async (event) => {
    let request = null;
    try {
      request = JSON.parse(event.detail || "{}");
      const current = Math.max(1, Math.floor(Number(request.current) || 1));
      const pageSize = Math.max(1, Math.min(100, Math.floor(Number(request.pageSize) || 100)));
      const query = new URL(location.href).searchParams;
      const keywords = query.get("keywords") || "";
      const ticket = query.get("ticket") || "";
      if (!request.requestId || !keywords || !ticket || !nativeFetch) {
        throw new Error("当前订单查询凭证不可用，请重新查询订单");
      }

      const response = await nativeFetch.call(window, "/shopApi/Order/list", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: 999, current, pageSize, total: 0, keywords, ticket }),
      });
      if (!response.ok) {
        throw new Error(`订单接口返回 ${response.status}`);
      }
      const payload = await response.json();
      if (Number(payload?.code) !== 1 || !Array.isArray(payload?.data?.list)) {
        throw new Error(String(payload?.msg || "订单读取失败"));
      }
      capturePayload(payload);
      document.dispatchEvent(new CustomEvent("ldxp:order-batch-result", {
        detail: JSON.stringify({
          requestId: request.requestId,
          total: Number(payload.data.total) || payload.data.list.length,
          orders: payload.data.list.map(sanitizeOrder).filter((order) => order.orderNo),
        }),
      }));
    } catch (error) {
      document.dispatchEvent(new CustomEvent("ldxp:order-batch-result", {
        detail: JSON.stringify({
          requestId: request?.requestId || "",
          error: error?.message || "订单读取失败",
        }),
      }));
    }
  });

  document.addEventListener("ldxp:request-product-links", publish);
})();
