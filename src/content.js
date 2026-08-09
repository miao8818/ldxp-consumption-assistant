(async function initializeLdxpConsumptionAssistant() {
  "use strict";

  const isDemo = document.documentElement.dataset.ldxpDemo === "true";
  const isOrderPage = location.hostname === "pay.ldxp.cn" && location.pathname.startsWith("/order");
  if ((!isOrderPage && !isDemo) || document.getElementById("ldxp-consumption-assistant-root")) {
    return;
  }

  const core = globalThis.LdxpStatsCore;
  if (!core) {
    return;
  }

  const hasChromeStorage = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  const hasChromeRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.getURL);
  const settingsStorageKey = "ldxp-consumption-assistant-settings-v1";
  const orderStorageKey = await buildOrderStorageKey();
  const productLinks = new Map();
  const communityImageUrl = hasChromeRuntime
    ? chrome.runtime.getURL("assets/qq-group.jpg")
    : "assets/qq-group.jpg";

  const state = {
    orders: [],
    mode: isDemo ? "panel" : "orb",
    view: "overview",
    sort: "newest",
    scanning: false,
    scanCancelled: false,
    scanPage: 0,
    scanTotal: 0,
    lastDragAt: 0,
    clearArmed: false,
    filters: {
      keyword: "",
      minAmount: "",
      maxAmount: "",
      range: "all",
      status: "effective",
    },
    positions: {
      orb: null,
      panel: null,
    },
    panelSize: null,
  };
  let persistTimer = null;
  let toastTimer = null;

  await restoreState();

  document.addEventListener("ldxp:product-links", handleProductLinks);

  const host = document.createElement("div");
  host.id = "ldxp-consumption-assistant-root";
  host.setAttribute("data-ldxp-assistant", "true");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = await loadStyles();
  shadow.append(style);
  shadow.append(buildInterface());
  document.documentElement.append(host);

  const refs = collectRefs();
  attachEvents();
  applyMode();
  applyPanelSize();
  applyPositions();
  observePanelResize();
  document.dispatchEvent(new CustomEvent("ldxp:request-product-links"));
  captureCurrentPage({ notify: false });
  renderAll();
  observeOrderTable();

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "LDXP_OPEN_ASSISTANT") {
        return;
      }
      setMode(state.mode === "panel" ? "orb" : "panel");
    });
  }

  async function buildOrderStorageKey() {
    const identifier = new URL(location.href).searchParams.get("keywords") || (isDemo ? "demo" : "default");
    try {
      const bytes = new TextEncoder().encode(identifier);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 20);
      return `ldxp-consumption-orders-v1-${hash}`;
    } catch {
      return "ldxp-consumption-orders-v1-local";
    }
  }

  async function storageGet(key) {
    if (hasChromeStorage) {
      const result = await chrome.storage.local.get(key);
      return result[key];
    }
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  async function storageSet(key, value) {
    if (hasChromeStorage) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  async function storageRemove(key) {
    if (hasChromeStorage) {
      await chrome.storage.local.remove(key);
      return;
    }
    localStorage.removeItem(key);
  }

  async function restoreState() {
    const [savedOrders, savedSettings] = await Promise.all([
      storageGet(orderStorageKey),
      storageGet(settingsStorageKey),
    ]);

    if (Array.isArray(savedOrders?.orders)) {
      state.orders = savedOrders.orders.filter(isValidOrder);
    }
    if (savedSettings?.positions) {
      state.positions = { ...state.positions, ...savedSettings.positions };
    }
    if (savedSettings?.panelSize) {
      state.panelSize = savedSettings.panelSize;
    }
    if (["orb", "panel", "hidden"].includes(savedSettings?.mode) && !isDemo) {
      state.mode = savedSettings.mode;
    }
  }

  function isValidOrder(order) {
    return Boolean(
      order &&
        typeof order.orderNo === "string" &&
        typeof order.productName === "string" &&
        typeof order.createTime === "string" &&
        Number.isFinite(order.amountCents),
    );
  }

  function handleProductLinks(event) {
    try {
      const links = JSON.parse(event.detail || "{}");
      let changed = false;
      Object.entries(links).forEach(([orderNo, productUrl]) => {
        if (!isSafeProductUrl(productUrl)) {
          return;
        }
        productLinks.set(orderNo, productUrl);
        const order = state.orders.find((item) => item.orderNo === orderNo);
        if (order && order.productUrl !== productUrl) {
          order.productUrl = productUrl;
          changed = true;
        }
      });
      if (changed) {
        persistOrders();
        renderData();
      }
    } catch {
      // Ignore malformed bridge events.
    }
  }

  function isSafeProductUrl(value) {
    try {
      const url = new URL(value, location.origin);
      const expectedOrigin = isDemo ? "https://pay.ldxp.cn" : location.origin;
      return url.origin === expectedOrigin && url.pathname.startsWith("/item/");
    } catch {
      return false;
    }
  }

  async function loadStyles() {
    const url = hasChromeRuntime ? chrome.runtime.getURL("src/panel.css") : "src/panel.css";
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Stylesheet request failed: ${response.status}`);
      }
      return await response.text();
    } catch {
      return `
        :host{all:initial}
        .ldxp-app [hidden],.ldxp-panel,.ldxp-orb-hide,.ldxp-toast{display:none!important}
        .ldxp-orb-shell{position:fixed;right:20px;top:50%;z-index:2147483647;width:60px;height:60px}
        .ldxp-orb-main{display:grid;place-items:center;width:56px;height:56px;padding:0;color:#fff;background:#ff4e09;border:2px solid #fff;border-radius:50%;box-shadow:0 8px 24px rgba(255,78,9,.3);cursor:pointer}
        .ldxp-orb-count{position:absolute;right:0;bottom:0;min-width:20px;padding:1px 4px;color:#fff;font:10px sans-serif;text-align:center;background:#292d2c;border:2px solid #fff;border-radius:10px}
      `;
    }
  }

  function icon(name, size = 18) {
    const paths = {
      chart: '<path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V7"/><path d="M17 16v-8"/>',
      search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
      refresh: '<path d="M21 12a9 9 0 0 1-15.2 6.5L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.2 5.5L21 8"/><path d="M21 3v5h-5"/>',
      minimize: '<path d="M5 12h14"/>',
      eyeOff: '<path d="m2 2 20 20"/><path d="M6.7 6.7C4.6 8.1 3.1 10 2 12c2 3.6 5.6 6 10 6 1.5 0 2.8-.3 4-.8"/><path d="M10.7 10.7a2 2 0 0 0 2.6 2.6"/><path d="M14.7 5.2A11 11 0 0 0 12 4C7.6 4 4 6.4 2 10"/><path d="M18.3 8.3A12 12 0 0 1 22 12a12 12 0 0 1-2.1 2.9"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
      trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
      calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
      wallet: '<path d="M20 7V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10H5a3 3 0 0 1-3-3V7"/><path d="M16 15h.01"/>',
      receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6"/><path d="M16 12h-6"/><path d="M13 16h-3"/>',
      trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
      list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    };
    return `<svg class="ldxp-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chart}</svg>`;
  }

  function buildInterface() {
    const container = document.createElement("div");
    container.className = "ldxp-app";
    container.innerHTML = `
      <div class="ldxp-orb-shell" data-ref="orbShell" data-action="open-panel">
        <button class="ldxp-orb-main" data-action="open-panel" aria-label="打开消费统计" title="打开消费统计">
          ${icon("chart", 25)}
          <span class="ldxp-orb-count" data-ref="orbCount">0</span>
        </button>
        <button class="ldxp-orb-hide" data-action="hide-all" aria-label="隐藏悬浮球" title="隐藏悬浮球，点击浏览器工具栏图标可恢复">
          ${icon("x", 12)}
        </button>
      </div>

      <section class="ldxp-panel" data-ref="panel" aria-label="链动小铺消费统计面板">
        <header class="ldxp-header" data-drag-handle="panel">
          <div class="ldxp-brand-mark">${icon("chart", 19)}</div>
          <div class="ldxp-title-block">
            <div class="ldxp-title">消费账本</div>
            <div class="ldxp-subtitle" data-ref="coverage">正在读取订单...</div>
          </div>
          <div class="ldxp-header-actions">
            <button class="ldxp-icon-button" data-action="capture" aria-label="同步当前页" title="同步当前页">${icon("refresh", 17)}</button>
            <button class="ldxp-icon-button" data-action="toggle-menu" aria-label="更多操作" title="更多操作">${icon("more", 18)}</button>
            <button class="ldxp-icon-button" data-action="minimize" aria-label="收起面板" title="收起面板">${icon("minimize", 18)}</button>
          </div>
          <div class="ldxp-menu" data-ref="menu" hidden>
            <button data-action="community">${icon("users", 16)} 交流群 · 613550608</button>
            <button data-action="export">${icon("download", 16)} 导出筛选结果</button>
            <button data-action="clear">${icon("trash", 16)} <span data-ref="clearLabel">清空本地数据</span></button>
            <button data-action="hide-all">${icon("eyeOff", 16)} 隐藏悬浮工具</button>
          </div>
        </header>

        <div class="ldxp-sync-band">
          <div class="ldxp-sync-state">
            <span class="ldxp-status-dot"></span>
            <span data-ref="syncMeta">等待同步</span>
          </div>
          <button class="ldxp-command-button" data-action="scan" data-ref="scanButton">
            ${icon("refresh", 16)} <span data-ref="scanLabel">读取全部订单</span>
          </button>
        </div>

        <nav class="ldxp-tabs" aria-label="统计视图">
          <button class="is-active" data-view="overview">概览</button>
          <button data-view="details">明细 <span data-ref="detailCount">0</span></button>
        </nav>

        <div class="ldxp-filters">
          <label class="ldxp-search-field">
            ${icon("search", 16)}
            <input data-filter="keyword" type="search" placeholder="搜索商品名或订单号" autocomplete="off">
          </label>
          <div class="ldxp-filter-grid">
            <label class="ldxp-select-field">
              <span>日期</span>
              <select data-filter="range">
                <option value="all">全部日期</option>
                <option value="today">今天</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
                <option value="90">近 90 天</option>
              </select>
            </label>
            <label class="ldxp-select-field">
              <span>状态</span>
              <select data-filter="status" data-ref="statusSelect">
                <option value="effective">有效消费</option>
                <option value="all">全部状态</option>
              </select>
            </label>
            <div class="ldxp-amount-field">
              <span>金额区间</span>
              <div>
                <input data-filter="minAmount" type="number" min="0" step="0.01" placeholder="最低">
                <i></i>
                <input data-filter="maxAmount" type="number" min="0" step="0.01" placeholder="最高">
              </div>
            </div>
          </div>
        </div>

        <main class="ldxp-content">
          <div class="ldxp-overview" data-ref="overviewView">
            <section class="ldxp-stat-grid" aria-label="消费摘要">
              <article class="ldxp-stat is-primary">
                <div class="ldxp-stat-icon">${icon("wallet", 17)}</div>
                <span>有效消费</span>
                <strong data-ref="totalAmount">￥0.00</strong>
              </article>
              <article class="ldxp-stat">
                <div class="ldxp-stat-icon">${icon("receipt", 17)}</div>
                <span>订单笔数</span>
                <strong data-ref="orderCount">0</strong>
              </article>
              <article class="ldxp-stat">
                <div class="ldxp-stat-icon">${icon("trend", 17)}</div>
                <span>笔均消费</span>
                <strong data-ref="averageAmount">￥0.00</strong>
              </article>
            </section>

            <section class="ldxp-section ldxp-chart-section">
              <div class="ldxp-section-heading">
                <div>
                  <h2>每日消费</h2>
                  <p data-ref="activeDays">0 个消费日</p>
                </div>
                <span class="ldxp-legend"><i></i> 有效消费</span>
              </div>
              <div class="ldxp-chart" data-ref="chart"></div>
            </section>

            <section class="ldxp-section ldxp-daily-section">
              <div class="ldxp-section-heading">
                <h2>按日汇总</h2>
                <span data-ref="dailyCount">0 天</span>
              </div>
              <div class="ldxp-daily-list" data-ref="dailyList"></div>
            </section>
          </div>

          <div class="ldxp-details" data-ref="detailsView" hidden>
            <div class="ldxp-details-toolbar">
              <span data-ref="resultLabel">0 条结果</span>
              <select data-ref="sortSelect" aria-label="明细排序">
                <option value="newest">时间从新到旧</option>
                <option value="oldest">时间从旧到新</option>
                <option value="amountDesc">金额从高到低</option>
                <option value="amountAsc">金额从低到高</option>
              </select>
            </div>
            <div class="ldxp-order-list" data-ref="orderList"></div>
          </div>
        </main>

        <footer class="ldxp-footer">
          <span>永久免费 · 非官方 · 本机数据</span>
          <div class="ldxp-footer-actions">
            <button data-action="community">${icon("users", 14)} 交流群</button>
            <button data-action="export">${icon("download", 14)} 导出 CSV</button>
          </div>
        </footer>
        <div class="ldxp-community-backdrop" data-ref="communityDialog" hidden>
          <section class="ldxp-community-dialog" role="dialog" aria-modal="true" aria-labelledby="ldxp-community-title">
            <header class="ldxp-community-header">
              <div>
                <h2 id="ldxp-community-title">消费助手交流群（非官方）</h2>
                <p>QQ 群 <strong>613550608</strong></p>
              </div>
              <button class="ldxp-icon-button" data-action="community-close" aria-label="关闭交流群" title="关闭">${icon("x", 18)}</button>
            </header>
            <a class="ldxp-community-qr" href="${escapeHtml(communityImageUrl)}" target="_blank" rel="noopener noreferrer" title="查看交流群二维码大图">
              <img src="${escapeHtml(communityImageUrl)}" alt="链动消费助手 QQ 群二维码，群号 613550608" loading="lazy">
              <span>点击二维码查看大图</span>
            </a>
            <div class="ldxp-disclaimer">
              <strong>本插件永久免费</strong>
              <p>本项目为非官方工具，仅供个人订单统计使用，不提供任何付费服务。如涉及侵权，请通过交流群联系作者，核实后将立即删除相关内容。</p>
            </div>
          </section>
        </div>
        <div class="ldxp-resize-grip" aria-hidden="true"></div>
      </section>
      <div class="ldxp-toast" data-ref="toast" role="status" aria-live="polite"></div>
    `;
    return container;
  }

  function collectRefs() {
    return Object.fromEntries(
      Array.from(shadow.querySelectorAll("[data-ref]")).map((element) => [element.dataset.ref, element]),
    );
  }

  function attachEvents() {
    shadow.addEventListener("click", handleClick);
    shadow.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        renderView();
      });
    });
    shadow.querySelectorAll("[data-filter]").forEach((control) => {
      const eventName = control.tagName === "SELECT" ? "change" : "input";
      control.addEventListener(eventName, () => {
        state.filters[control.dataset.filter] = control.value;
        renderData();
      });
    });
    refs.sortSelect.addEventListener("change", () => {
      state.sort = refs.sortSelect.value;
      renderData();
    });
    attachDrag(refs.orbShell, refs.orbShell, "orb");
    attachDrag(shadow.querySelector("[data-drag-handle='panel']"), refs.panel, "panel");
    window.addEventListener("resize", () => {
      applyPanelSize();
      applyPositions();
    }, { passive: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !refs.communityDialog.hidden) {
        refs.communityDialog.hidden = true;
        return;
      }
      if (event.key === "Escape" && state.mode === "panel") {
        setMode("orb");
      }
    });
    refs.communityDialog.addEventListener("click", (event) => {
      if (event.target === refs.communityDialog) {
        refs.communityDialog.hidden = true;
      }
    });
  }

  function handleClick(event) {
    const actionElement = event.target.closest?.("[data-action]");
    if (!actionElement) {
      if (!event.target.closest?.(".ldxp-menu")) {
        refs.menu.hidden = true;
      }
      return;
    }
    const action = actionElement.dataset.action;
    if (action === "open-panel" && Date.now() - state.lastDragAt > 250) {
      setMode("panel");
    } else if (action === "minimize") {
      setMode("orb");
    } else if (action === "hide-all") {
      refs.menu.hidden = true;
      setMode("hidden");
    } else if (action === "toggle-menu") {
      refs.menu.hidden = !refs.menu.hidden;
    } else if (action === "community") {
      refs.menu.hidden = true;
      refs.communityDialog.hidden = false;
    } else if (action === "community-close") {
      refs.communityDialog.hidden = true;
    } else if (action === "capture") {
      const added = captureCurrentPage({ notify: true });
      if (!added) {
        showToast("当前页没有发现新的订单");
      }
    } else if (action === "scan") {
      if (state.scanning) {
        state.scanCancelled = true;
        renderScanState();
      } else {
        scanAllPages();
      }
    } else if (action === "export") {
      refs.menu.hidden = true;
      exportCsv();
    } else if (action === "clear") {
      handleClearData();
    }
  }

  function attachDrag(handle, target, positionKey) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest?.("button:not(.ldxp-orb-main), select, input")) {
        return;
      }
      const rect = target.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      handle.setPointerCapture?.(event.pointerId);
      target.classList.add("is-dragging");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 4) {
        drag.moved = true;
      }
      if (!drag.moved) {
        return;
      }
      const point = clampPosition(target, drag.left + dx, drag.top + dy);
      target.style.left = `${point.x}px`;
      target.style.top = `${point.y}px`;
      target.style.right = "auto";
      target.style.bottom = "auto";
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      target.classList.remove("is-dragging");
      if (drag.moved) {
        const rect = target.getBoundingClientRect();
        state.positions[positionKey] = { x: Math.round(rect.left), y: Math.round(rect.top) };
        state.lastDragAt = Date.now();
        persistSettings();
      }
      drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function clampPosition(element, x, y) {
    const margin = 10;
    const isPanel = element === refs.panel;
    const width = element.offsetWidth || (isPanel ? state.panelSize?.width || 428 : 58);
    const height = element.offsetHeight || (isPanel ? state.panelSize?.height || 760 : 58);
    return {
      x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    };
  }

  function applyPositions() {
    const defaults = {
      orb: { x: window.innerWidth - 78, y: Math.round(window.innerHeight * 0.56) },
      panel: { x: window.innerWidth - Math.min(444, window.innerWidth - 20) - 16, y: 16 },
    };
    [[refs.orbShell, "orb"], [refs.panel, "panel"]].forEach(([element, key]) => {
      const stored = state.positions[key] || defaults[key];
      const point = clampPosition(element, stored.x, stored.y);
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
    });
  }

  function applyPanelSize() {
    if (!state.panelSize) {
      return;
    }
    const maxWidth = Math.max(320, window.innerWidth - 20);
    const maxHeight = Math.max(460, window.innerHeight - 20);
    const minWidth = Math.min(360, maxWidth);
    const minHeight = Math.min(520, maxHeight);
    const width = Math.max(minWidth, Math.min(Number(state.panelSize.width) || 428, maxWidth));
    const height = Math.max(minHeight, Math.min(Number(state.panelSize.height) || 760, maxHeight));
    refs.panel.style.width = `${Math.round(width)}px`;
    refs.panel.style.height = `${Math.round(height)}px`;
  }

  function observePanelResize() {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    let resizeTimer = null;
    const observer = new ResizeObserver(() => {
      if (refs.panel.hidden) {
        return;
      }
      const rect = refs.panel.getBoundingClientRect();
      if (rect.width < 300 || rect.height < 400) {
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        state.panelSize = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        applyPositions();
        persistSettings();
      }, 180);
    });
    observer.observe(refs.panel);
  }

  function setMode(mode) {
    state.mode = mode;
    applyMode();
    persistSettings();
  }

  function applyMode() {
    refs.orbShell.hidden = state.mode !== "orb";
    refs.panel.hidden = state.mode !== "panel";
    if (state.mode === "panel") {
      applyPanelSize();
      applyPositions();
      renderAll();
    }
  }

  function persistSettings() {
    storageSet(settingsStorageKey, {
      mode: state.mode,
      positions: state.positions,
      panelSize: state.panelSize,
    });
  }

  function persistOrders() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      storageSet(orderStorageKey, {
        updatedAt: new Date().toISOString(),
        orders: state.orders,
      });
    }, 150);
  }

  function captureCurrentPage({ notify = false } = {}) {
    const incoming = core.extractOrders(document).map((order) => ({
      ...order,
      productUrl: productLinks.get(order.orderNo) || "",
    }));
    if (!incoming.length) {
      return 0;
    }
    const before = new Map(state.orders.map((order) => [order.orderNo, order]));
    const changed = incoming.filter((order) => {
      const previous = before.get(order.orderNo) || {};
      const candidate = {
        ...previous,
        ...order,
        productUrl: order.productUrl || previous.productUrl || "",
      };
      return JSON.stringify(previous) !== JSON.stringify(candidate);
    }).length;
    if (changed) {
      state.orders = core.mergeOrders(state.orders, incoming);
      persistOrders();
      renderAll();
    }
    if (notify && changed) {
      showToast(`已同步 ${changed} 笔订单`);
    }
    return changed;
  }

  function observeOrderTable() {
    let timer = null;
    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.target.closest?.("table, .arco-table"))) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => captureCurrentPage({ notify: false }), 280);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function getCurrentPage() {
    return Number(document.querySelector(".arco-pagination-item-active")?.textContent?.trim()) || 1;
  }

  function getTotalPages() {
    const pagesAttributes = Array.from(document.querySelectorAll(".arco-pagination-item[pages]"))
      .map((element) => Number(element.getAttribute("pages")))
      .filter(Number.isFinite);
    if (pagesAttributes.length) {
      return Math.max(...pagesAttributes);
    }
    const pageNumbers = Array.from(document.querySelectorAll(".arco-pagination-list li"))
      .map((element) => Number(element.textContent?.trim()))
      .filter(Number.isFinite);
    return pageNumbers.length ? Math.max(...pageNumbers) : 1;
  }

  function tableSignature() {
    return core.extractOrders(document).map((order) => order.orderNo).join("|");
  }

  async function changePage(direction) {
    const selector = direction === "next"
      ? ".arco-pagination-item-next"
      : ".arco-pagination-item-previous";
    const control = document.querySelector(selector);
    if (!control || control.classList.contains("arco-pagination-item-disabled")) {
      return false;
    }
    const previousPage = getCurrentPage();
    const previousSignature = tableSignature();
    control.click();
    const changed = await waitUntil(() => {
      const currentPage = getCurrentPage();
      return currentPage !== previousPage && tableSignature() !== previousSignature;
    }, 9000);
    if (changed) {
      await delay(120);
    }
    return changed;
  }

  async function moveToPage(targetPage) {
    let guard = Math.max(getTotalPages() + 2, 4);
    while (getCurrentPage() !== targetPage && guard > 0 && !state.scanCancelled) {
      const direction = getCurrentPage() < targetPage ? "next" : "previous";
      if (!(await changePage(direction))) {
        return false;
      }
      guard -= 1;
    }
    return getCurrentPage() === targetPage;
  }

  async function scanAllPages() {
    if (isDemo || !isOrderPage) {
      return scanWithVisiblePagination();
    }

    state.scanning = true;
    state.scanCancelled = false;
    state.scanPage = 0;
    state.scanTotal = 1;
    renderScanState();

    try {
      const requestedPageSize = 100;
      const firstBatch = await requestOrderBatch(1, requestedPageSize);
      if (!firstBatch.orders.length && firstBatch.total > 0) {
        throw new Error("订单接口没有返回列表数据");
      }

      mergeOrderBatch(firstBatch.orders);
      const effectivePageSize = Math.max(1, firstBatch.orders.length || requestedPageSize);
      const totalBatches = Math.max(1, Math.ceil(firstBatch.total / effectivePageSize));
      state.scanPage = 1;
      state.scanTotal = totalBatches;
      renderScanState();

      const remaining = Array.from({ length: Math.max(0, totalBatches - 1) }, (_, index) => index + 2);
      for (let index = 0; index < remaining.length && !state.scanCancelled; index += 4) {
        const group = remaining.slice(index, index + 4);
        const results = await Promise.all(group.map((page) => requestOrderBatch(page, effectivePageSize)));
        results.forEach((result) => mergeOrderBatch(result.orders));
        state.scanPage += results.length;
        renderScanState();
      }

      if (state.scanCancelled) {
        showToast(`读取已停止，已保留 ${state.orders.length} 笔订单`);
      } else {
        showToast(`读取完成，共收集 ${state.orders.length} 笔订单`);
      }
    } catch (error) {
      showToast(error.message || "订单读取失败，请重新查询后再试");
    } finally {
      state.scanCancelled = false;
      state.scanning = false;
      state.scanPage = 0;
      persistOrders();
      renderAll();
    }
  }

  function requestOrderBatch(current, pageSize) {
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      let timeoutId = null;
      const handleResult = (event) => {
        try {
          const result = JSON.parse(event.detail || "{}");
          if (result.requestId !== requestId) {
            return;
          }
          document.removeEventListener("ldxp:order-batch-result", handleResult);
          clearTimeout(timeoutId);
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          resolve({
            total: Number(result.total) || 0,
            orders: Array.isArray(result.orders) ? result.orders : [],
          });
        } catch {
          // Ignore unrelated or malformed bridge events until timeout.
        }
      };
      document.addEventListener("ldxp:order-batch-result", handleResult);
      timeoutId = setTimeout(() => {
        document.removeEventListener("ldxp:order-batch-result", handleResult);
        reject(new Error("订单接口响应超时，请刷新页面后重试"));
      }, 15000);
      document.dispatchEvent(new CustomEvent("ldxp:fetch-order-batch", {
        detail: JSON.stringify({ requestId, current, pageSize }),
      }));
    });
  }

  function mergeOrderBatch(records) {
    const statusLabels = {
      0: "待付款",
      1: "已付款",
      2: "已退款",
      3: "已关闭",
    };
    const orders = records.map((record) => {
      const timestamp = Number(record.createTimestamp) * 1000;
      const date = new Date(timestamp);
      const createTime = Number.isFinite(timestamp) && timestamp > 0
        ? formatLocalDateTime(date)
        : "";
      if (record.productUrl && isSafeProductUrl(record.productUrl)) {
        productLinks.set(record.orderNo, record.productUrl);
      }
      return {
        orderNo: String(record.orderNo || "").trim(),
        productName: String(record.productName || "").trim(),
        createTime,
        date: createTime.slice(0, 10),
        amountCents: core.parseMoneyToCents(record.totalAmount),
        quantity: Number(record.quantity) || 1,
        status: statusLabels[record.status] || `状态 ${record.status}`,
        productUrl: isSafeProductUrl(record.productUrl) ? record.productUrl : "",
      };
    }).filter((order) => order.orderNo && order.productName && order.createTime);
    state.orders = core.mergeOrders(state.orders, orders);
    persistOrders();
    renderAll();
  }

  function formatLocalDateTime(date) {
    const parts = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ];
    const time = [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ];
    return `${parts.join("-")} ${time.join(":")}`;
  }

  async function scanWithVisiblePagination() {
    const total = getTotalPages();
    if (total <= 1) {
      const changed = captureCurrentPage({ notify: true });
      if (!changed) {
        showToast("当前列表已经是最新数据");
      }
      return;
    }

    const originalPage = getCurrentPage();
    state.scanning = true;
    state.scanCancelled = false;
    state.scanPage = 0;
    state.scanTotal = total;
    renderScanState();

    try {
      const atFirstPage = await moveToPage(1);
      if (!atFirstPage && !state.scanCancelled) {
        throw new Error("无法回到第一页");
      }

      while (!state.scanCancelled) {
        const current = getCurrentPage();
        captureCurrentPage({ notify: false });
        state.scanPage = current;
        renderScanState();
        if (current >= total) {
          break;
        }
        if (!(await changePage("next"))) {
          throw new Error(`第 ${current + 1} 页加载超时`);
        }
      }

      if (state.scanCancelled) {
        showToast(`扫描已停止，已保留 ${state.orders.length} 笔订单`);
      } else {
        showToast(`扫描完成，共收集 ${state.orders.length} 笔订单`);
      }
    } catch (error) {
      showToast(error.message || "扫描中断，请稍后重试");
    } finally {
      state.scanCancelled = false;
      if (originalPage !== getCurrentPage()) {
        await moveToPage(originalPage);
      }
      state.scanning = false;
      state.scanPage = 0;
      persistOrders();
      renderAll();
    }
  }

  function waitUntil(predicate, timeout) {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (predicate()) {
          resolve(true);
        } else if (Date.now() - started >= timeout) {
          resolve(false);
        } else {
          setTimeout(check, 80);
        }
      };
      check();
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function renderAll() {
    if (!refs) {
      return;
    }
    updateStatusOptions();
    renderData();
    renderScanState();
    renderView();
    refs.orbCount.textContent = state.orders.length > 99 ? "99+" : String(state.orders.length);

    const dates = state.orders.map((order) => order.date).filter(Boolean).sort();
    refs.coverage.textContent = dates.length
      ? `${dates[0]} 至 ${dates.at(-1)}`
      : "尚未收集订单";
  }

  function renderData() {
    const filtered = core.applyFilters(state.orders, state.filters);
    const sorted = core.sortOrders(filtered, state.sort);
    const summary = core.summarize(filtered);
    const daily = core.groupByDay(filtered);

    refs.totalAmount.textContent = core.formatMoney(summary.totalCents);
    refs.orderCount.textContent = String(summary.orderCount);
    refs.averageAmount.textContent = core.formatMoney(summary.averageCents);
    refs.activeDays.textContent = `${summary.activeDays} 个消费日`;
    refs.detailCount.textContent = String(filtered.length);
    refs.resultLabel.textContent = `${filtered.length} 条结果`;
    refs.dailyCount.textContent = `${daily.length} 天`;

    renderChart(daily);
    renderDailyList(daily);
    renderOrderList(sorted);
  }

  function updateStatusOptions() {
    const select = refs.statusSelect;
    const previous = state.filters.status;
    const statuses = Array.from(new Set(state.orders.map((order) => order.status).filter(Boolean))).sort();
    const desired = [
      { value: "effective", label: "有效消费" },
      { value: "all", label: "全部状态" },
      ...statuses.map((status) => ({ value: status, label: status })),
    ];
    const currentSignature = Array.from(select.options).map((option) => option.value).join("|");
    const nextSignature = desired.map((option) => option.value).join("|");
    if (currentSignature !== nextSignature) {
      select.replaceChildren(...desired.map(({ value, label }) => new Option(label, value)));
    }
    select.value = desired.some((option) => option.value === previous) ? previous : "effective";
    state.filters.status = select.value;
  }

  function renderChart(daily) {
    if (!daily.length) {
      refs.chart.innerHTML = emptyState("chart", "没有符合条件的消费记录");
      return;
    }
    const points = daily.slice(0, 12).reverse();
    const max = Math.max(...points.map((item) => item.totalCents), 1);
    refs.chart.innerHTML = `
      <div class="ldxp-chart-bars">
        ${points.map((item) => {
          const height = item.totalCents ? Math.max(8, Math.round((item.totalCents / max) * 100)) : 3;
          return `<div class="ldxp-chart-column" title="${escapeHtml(item.date)} ${escapeHtml(core.formatMoney(item.totalCents))}">
            <div class="ldxp-chart-value">${escapeHtml(shortMoney(item.totalCents))}</div>
            <div class="ldxp-chart-track"><i style="height:${height}%"></i></div>
            <span>${escapeHtml(item.date.slice(5))}</span>
          </div>`;
        }).join("")}
      </div>
    `;
  }

  function renderDailyList(daily) {
    if (!daily.length) {
      refs.dailyList.innerHTML = emptyState("calendar", "暂无每日汇总");
      return;
    }
    const max = Math.max(...daily.map((item) => item.totalCents), 1);
    refs.dailyList.innerHTML = daily.map((item) => `
      <div class="ldxp-daily-row">
        <time datetime="${escapeHtml(item.date)}">${escapeHtml(formatDateLabel(item.date))}</time>
        <div class="ldxp-daily-meter"><i style="width:${Math.max(2, Math.round((item.totalCents / max) * 100))}%"></i></div>
        <span>${item.orderCount} 笔</span>
        <strong>${escapeHtml(core.formatMoney(item.totalCents))}</strong>
      </div>
    `).join("");
  }

  function renderOrderList(orders) {
    if (!orders.length) {
      refs.orderList.innerHTML = emptyState("list", "没有符合条件的订单");
      return;
    }
    refs.orderList.innerHTML = orders.map((order) => {
      const statusClass = getStatusClass(order.status);
      const productTitle = order.productUrl && isSafeProductUrl(order.productUrl)
        ? `<a href="${escapeHtml(order.productUrl)}" target="_blank" rel="noopener noreferrer" title="在新标签页打开商品">${escapeHtml(order.productName)} ${icon("chevron", 14)}</a>`
        : `<span title="当前缓存中没有商品链接">${escapeHtml(order.productName)}</span>`;
      return `
        <article class="ldxp-order-row">
          <div class="ldxp-order-main">
            <h3>${productTitle}</h3>
            <div class="ldxp-order-meta">
              <code>${escapeHtml(order.orderNo)}</code>
              <span>${escapeHtml(order.createTime)}</span>
              <span>${order.quantity} 件</span>
            </div>
          </div>
          <div class="ldxp-order-side">
            <strong>${escapeHtml(core.formatMoney(order.amountCents))}</strong>
            <span class="ldxp-status ${statusClass}">${escapeHtml(order.status || "未知")}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderScanState() {
    if (state.scanning) {
      refs.scanButton.classList.add("is-scanning");
      refs.scanLabel.textContent = state.scanCancelled
        ? "正在停止..."
        : state.scanPage
          ? `停止读取 ${state.scanPage}/${state.scanTotal}`
          : "停止读取";
      refs.syncMeta.textContent = state.scanPage
        ? `后台读取第 ${state.scanPage} / ${state.scanTotal} 批`
        : "正在连接订单列表";
      return;
    }
    refs.scanButton.classList.remove("is-scanning");
    refs.scanLabel.textContent = isDemo ? "扫描演示数据" : "读取全部订单";
    refs.syncMeta.textContent = state.orders.length
      ? `已收集 ${state.orders.length} 笔订单`
      : "当前页尚无订单数据";
  }

  function renderView() {
    const isOverview = state.view === "overview";
    refs.overviewView.hidden = !isOverview;
    refs.detailsView.hidden = isOverview;
    shadow.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === state.view);
    });
  }

  function getStatusClass(status) {
    if (/退款|取消|关闭/.test(status)) {
      return "is-muted";
    }
    if (/待|未付款/.test(status)) {
      return "is-pending";
    }
    return "is-paid";
  }

  function emptyState(iconName, message) {
    return `<div class="ldxp-empty">${icon(iconName, 20)}<span>${escapeHtml(message)}</span></div>`;
  }

  function shortMoney(cents) {
    const amount = cents / 100;
    if (amount >= 10000) {
      return `￥${(amount / 10000).toFixed(1)}万`;
    }
    if (amount >= 1000) {
      return `￥${(amount / 1000).toFixed(1)}k`;
    }
    return `￥${amount.toFixed(amount >= 100 ? 0 : 1)}`;
  }

  function formatDateLabel(date) {
    const [year, month, day] = date.split("-");
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return date === todayKey ? `今天 · ${month}/${day}` : `${year}/${month}/${day}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function exportCsv() {
    const orders = core.sortOrders(core.applyFilters(state.orders, state.filters), state.sort);
    if (!orders.length) {
      showToast("当前筛选条件下没有可导出的订单");
      return;
    }
    const headers = ["商品名", "订单号", "金额", "数量", "状态", "下单时间"];
    const rows = orders.map((order) => [
      order.productName,
      order.orderNo,
      (order.amountCents / 100).toFixed(2),
      order.quantity,
      order.status,
      order.createTime,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `链动小铺消费明细-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${orders.length} 笔订单`);
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function handleClearData() {
    if (!state.clearArmed) {
      state.clearArmed = true;
      refs.clearLabel.textContent = "再次点击确认清空";
      setTimeout(() => {
        state.clearArmed = false;
        refs.clearLabel.textContent = "清空本地数据";
      }, 3500);
      return;
    }
    state.clearArmed = false;
    state.orders = [];
    refs.clearLabel.textContent = "清空本地数据";
    refs.menu.hidden = true;
    storageRemove(orderStorageKey);
    captureCurrentPage({ notify: false });
    renderAll();
    showToast("本地历史数据已清空，保留当前页订单");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    refs.toast.textContent = message;
    refs.toast.classList.add("is-visible");
    toastTimer = setTimeout(() => refs.toast.classList.remove("is-visible"), 2600);
  }
})();
