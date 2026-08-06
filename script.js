/**
 * script.js — 下单主页前端核心逻辑
 * 对应页面：index.html
 *
 * 功能模块：
 *   1. 登录态管理        从 localStorage 恢复 order_user，多客户切换
 *   2. 货品列表          从后端拉取协议价货品（Oracle），按分类树展示，支持搜索过滤
 *   3. 购物车 / 下单     选品、填数量、校验、提交订单（POST /receive_data）
 *   4. 历史订单          分页查询 /api/orders，可查询 ERP 订单行状态
 *   5. 货品资料下载      调用 /api/product-files/* 下载证照 ZIP
 *
 * 关键约定：
 *   - 货品数据来自 Oracle 协议价视图，Oracle 不通时显示本地缓存货品
 *   - 订单提交后同步转发到内网 ERP，失败时在本地仍留存订单记录
 *   - 用户信息（customerId / supplierId / inputManId）全部来自 order_user（登录后写入 localStorage）
 */
// 获取当前登录用户（来自登录页保存的 order_user）
function getStoredUser() {
    try {
        const raw = localStorage.getItem('order_user');
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/** 多客户条目唯一键（与 userResolve.buildCustomerEntryKey 规则一致） */
function buildCustomerEntryKey(c, index) {
    var id = String(c.id != null ? c.id : c.customerId || '').trim();
    var sid = String(c.supplierId || c.supplier_id || '').trim();
    var mid = String(c.inputManId || c.input_man_id || '').trim();
    var aid = String(
        c.assessCustomerId != null ? c.assessCustomerId : c.assess_customer_id || ''
    ).trim();
    if (id) {
        return [id, sid, mid, aid].join('::');
    }
    return 'entry_' + String(index != null ? index : 0);
}

/** 从 entryKey（id::supplierId::inputManId::assessCustomerId）补全缺失字段 */
function applyEntryKeyParts(c) {
    if (!c || !c.entryKey || String(c.entryKey).indexOf('::') < 0) return;
    var parts = String(c.entryKey).split('::');
    if (parts.length >= 2 && !String(c.supplierId || c.supplier_id || '').trim() && parts[1]) {
        c.supplierId = String(parts[1]).trim();
    }
    if (parts.length >= 3 && !String(c.inputManId || c.input_man_id || '').trim() && parts[2]) {
        c.inputManId = String(parts[2]).trim();
    }
    if (parts.length >= 4 && !String(c.assessCustomerId || c.assess_customer_id || '').trim() && parts[3]) {
        c.assessCustomerId = String(parts[3]).trim();
    }
}

function enrichCustomerEntry(c, index) {
    if (!c || typeof c !== 'object') return c;
    var copy = {};
    for (var p in c) {
        if (Object.prototype.hasOwnProperty.call(c, p)) copy[p] = c[p];
    }
    copy.supplierId = String(copy.supplierId || copy.supplier_id || '').trim();
    copy.inputManId = String(copy.inputManId || copy.input_man_id || '').trim();
    copy.assessCustomerId = String(
        copy.assessCustomerId != null ? copy.assessCustomerId : copy.assess_customer_id || ''
    ).trim();
    copy.priceCustomerId = String(
        copy.priceCustomerId != null
            ? copy.priceCustomerId
            : copy.oracleCustomerId || copy.price_customer_id || ''
    ).trim();
    copy.mergePrice =
        copy.mergePrice === true ||
        copy.mergePrice === 1 ||
        String(copy.mergePrice || '').trim() === '1';
    copy.mergePriceCustomerId = String(
        copy.mergePriceCustomerId != null ? copy.mergePriceCustomerId : ''
    ).trim();
    copy.entryKey = buildCustomerEntryKey(copy, index);
    applyEntryKeyParts(copy);
    return copy;
}

function customerEntryStorageSuffix(c) {
    if (!c) return '';
    var key = c.entryKey || buildCustomerEntryKey(c, 0);
    return String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// 获取该用户可选的客户列表（支持单客户 customer 或多客户 customers 数组）
function getCustomersList(user) {
    if (!user) return [];
    var raw = [];
    if (user.customers && Array.isArray(user.customers) && user.customers.length) {
        raw = user.customers;
    } else if (user.customer) {
        raw = [user.customer];
    }
    return raw.map(function (c, i) {
        return enrichCustomerEntry(c, i);
    });
}

/** 根据 localStorage 保存值解析当前选中的客户条目 */
function resolveCustomerFromSaved(saved, list) {
    if (!saved || !list.length) return null;
    var s = String(saved).trim();
    var byKey = list.find(function (c) {
        return String(c.entryKey) === s;
    });
    if (byKey) return byKey;
    if (s.indexOf('::') >= 0) {
        var legacy = list.filter(function (c) {
            return String(c.entryKey) === s || String(c.entryKey).indexOf(s + '::') === 0;
        });
        if (legacy.length === 1) return legacy[0];
    }
    var matches = list.filter(function (c) {
        return String(c.id) === s;
    });
    if (matches.length === 1) return matches[0];
    return null;
}

/** 多客户时：订单是否属于当前选中的客户条目（供应商/考核客户） */
function orderBelongsToCurrentCustomerEntry(order) {
    if (!hasMultipleCustomers()) return true;
    var c = getCurrentCustomer();
    if (!c || !order) return true;
    var sid = String(c.supplierId || '').trim();
    var aid = String(c.assessCustomerId || '').trim();
    if (!sid && !aid) return true;

    var orderSid = order.supplierId != null ? String(order.supplierId).trim() : '';
    var orderAid = '';
    var erp = order.erpData;
    if (erp) {
        if (!orderSid && erp.entryid != null) orderSid = String(erp.entryid).trim();
        if (erp.assesscustomid != null) orderAid = String(erp.assesscustomid).trim();
        var snap = erp.orderHistorySnapshot;
        if (snap) {
            if (!orderSid && snap.supplierId != null) orderSid = String(snap.supplierId).trim();
        }
    }
    if (sid && orderSid && orderSid !== sid) return false;
    if (aid && orderAid && orderAid !== aid) return false;
    if (sid && !orderSid) {
        var list = getCustomersList(getStoredUser());
        var sameId = list.filter(function (x) {
            return String(x.id) === String(c.id);
        });
        if (sameId.length > 1) return false;
    }
    return true;
}

/** 当前客户条目下的本地历史（不合并其它条目） */
function getLocalOrderHistoryCurrent() {
    try {
        var list = JSON.parse(localStorage.getItem(getOrderHistoryKey()) || '[]');
        if (!Array.isArray(list)) return [];
        return list.slice().sort(function (a, b) {
            return new Date(b.date) - new Date(a.date);
        });
    } catch (e) {
        console.warn('读取本地历史订单失败:', e);
        return [];
    }
}

/** 单客户用户：合并各 legacy key；多客户：仅当前条目 key */
function getLocalOrderHistoryForDisplay() {
    if (hasMultipleCustomers()) return getLocalOrderHistoryCurrent();
    return getLocalOrderHistoryMerged();
}

// 当前要下单的客户（多客户时 localStorage 存 entryKey，兼容旧版仅存客户 id）
function getCurrentCustomer() {
    var user = getStoredUser();
    var list = getCustomersList(user);
    if (!list.length) return null;
    try {
        var saved = localStorage.getItem('order_current_customer');
        var found = resolveCustomerFromSaved(saved, list);
        if (found) return found;
    } catch (e) {}
    return list[0];
}

// 是否多客户用户（需要显示“当前下单客户”选择框）
function hasMultipleCustomers() {
    var list = getCustomersList(getStoredUser());
    return list.length > 1;
}

/** 仅 1 条可见客户时用 users 表默认；多条时用 customers_json 当前选中条 */
function usesMultiCustomerEntries() {
    return hasMultipleCustomers();
}

/**
 * 货品 Oracle（ZX_dhGDPRICE_V）与抛单主单：客户ID + 供应商ID
 * - 单条：user.customer.id、user.supplier.id
 * - 多条：当前 customers 条目的 id、supplierId
 */
function getActiveCustomerSupplierIds() {
    var user = getStoredUser();
    var fallbackCid = '7522';
    var fallbackSid = '2';
    if (!user) {
        return { customerId: fallbackCid, supplierId: fallbackSid };
    }

    var defaultCid =
        user.customer && user.customer.id ? String(user.customer.id).trim() : '';
    var defaultSid =
        user.supplier && user.supplier.id ? String(user.supplier.id).trim() : fallbackSid;

    if (!usesMultiCustomerEntries()) {
        var list = getCustomersList(user);
        return {
            customerId: defaultCid || (list[0] && list[0].id ? String(list[0].id) : fallbackCid),
            supplierId: defaultSid || fallbackSid
        };
    }

    var c = getCurrentCustomer();
    var customerId = c && c.id ? String(c.id).trim() : defaultCid || fallbackCid;
    var supplierId = getSupplierIdForCurrentCustomer();
    return { customerId: customerId, supplierId: supplierId };
}

/**
 * Oracle 协议价 / 伙伴云资料：视图「客户ID」
 * mergePrice+mergePriceCustomerId → priceCustomerId（历史）→ 抛单 id
 */
function getOraclePriceCustomerId() {
    var c = getCurrentCustomer();
    var fallback = getActiveCustomerSupplierIds().customerId;
    if (!c) return fallback;
    if (
        c.mergePrice &&
        String(c.mergePriceCustomerId || '').trim()
    ) {
        return String(c.mergePriceCustomerId).trim();
    }
    if (String(c.priceCustomerId || '').trim()) {
        return String(c.priceCustomerId).trim();
    }
    return fallback;
}

function isMergePriceMode() {
    var c = getCurrentCustomer();
    return !!(
        c &&
        c.mergePrice &&
        String(c.mergePriceCustomerId || '').trim()
    );
}

/** /api/products 查询参数（含可选 priceCustomerId） */
function buildProductsApiQuery(extraParams) {
    var ids = getActiveCustomerSupplierIds();
    var priceId = getOraclePriceCustomerId();
    var q =
        'customerId=' +
        encodeURIComponent(ids.customerId) +
        '&supplierId=' +
        encodeURIComponent(ids.supplierId);
    if (priceId && priceId !== ids.customerId) {
        q += '&priceCustomerId=' + encodeURIComponent(priceId);
    }
    if (isMergePriceMode()) {
        q += '&mergePrice=1';
    }
    if (extraParams) {
        q += extraParams;
    }
    return q;
}

/** 当前上下文应使用的制单人 ID：无/单客户用 user.inputManId；多客户用当前条目的 inputManId */
function getInputManIdForCurrentCustomer() {
    var user = getStoredUser();
    var defaultMid =
        user && user.inputManId != null ? String(user.inputManId).trim() : '';
    if (!user) return defaultMid || 'system';
    var customer = getCurrentCustomer();
    var list = getCustomersList(user);
    if (!list.length) return defaultMid || 'system';
    if (!usesMultiCustomerEntries()) {
        return defaultMid || 'system';
    }
    if (customer) {
        var mid2 = String(customer.inputManId || customer.input_man_id || '').trim();
        if (!mid2) {
            applyEntryKeyParts(customer);
            mid2 = String(customer.inputManId || '').trim();
        }
        if (mid2) return mid2;
    }
    return defaultMid || 'system';
}

/** 当前上下文应使用的供应商 ID：无 customers_json 或单客户用 user.supplier；多客户用当前条目的 supplierId */
function getSupplierIdForCurrentCustomer() {
    var user = getStoredUser();
    var defaultSid =
        user && user.supplier && user.supplier.id ? String(user.supplier.id).trim() : '';
    if (!user) return defaultSid || '2';
    var customer = getCurrentCustomer();
    var list = getCustomersList(user);
    if (!list.length) return defaultSid || '2';
    if (!usesMultiCustomerEntries()) {
        return defaultSid || '2';
    }
    if (customer) {
        var sid2 = String(customer.supplierId || customer.supplier_id || '').trim();
        if (!sid2) {
            applyEntryKeyParts(customer);
            sid2 = String(customer.supplierId || '').trim();
        }
        if (sid2) return sid2;
    }
    return defaultSid || '2';
}

function getSupplierForCurrentCustomer() {
    var user = getStoredUser();
    var id = getSupplierIdForCurrentCustomer();
    var name = user && user.supplier && user.supplier.name ? user.supplier.name : '';
    var customer = getCurrentCustomer();
    if (customer && (customer.supplierName || customer.supplier_name)) {
        name = customer.supplierName || customer.supplier_name;
    }
    return { id: id, name: name };
}

/**
 * 抛送 ERP 订单主单字段（供应商/制单人解析规则一致）
 * - 无/单客户：user 表 supplier_id、input_man_id
 * - 多客户：当前 customers 条目中的 supplierId、inputManId，否则回退用户表默认值
 */
function getOrderErpDefaults() {
    var user = getStoredUser();
    var customer = usesMultiCustomerEntries() ? getCurrentCustomer() : null;
    var ids = getActiveCustomerSupplierIds();
    var inputManId = getInputManIdForCurrentCustomer();
    var erpAssessCustomerId = '858';

    if (customer && customer.id) {
        erpAssessCustomerId = String(
            customer.assessCustomerId != null ? customer.assessCustomerId : customer.assess_customer_id || '858'
        ).trim() || '858';
    } else if (user && user.customer) {
        erpAssessCustomerId = String(user.customer.assessCustomerId || '858');
    }

    return {
        businessType: 'DS01',
        supplierId: ids.supplierId,
        inputManId: inputManId,
        erpCustomerId: ids.customerId,
        erpAssessCustomerId: erpAssessCustomerId
    };
}

// 根据登录用户及当前选中客户覆盖配置
function applyUserConfig() {
    var user = getStoredUser();
    if (user) {
        var erp = getOrderErpDefaults();
        var supplier = getSupplierForCurrentCustomer();
        var customer = usesMultiCustomerEntries()
            ? getCurrentCustomer()
            : user.customer || getCurrentCustomer();
        window.CUSTOMER_CONFIG = {
            customer: customer || window.CUSTOMER_CONFIG?.customer,
            supplier: supplier,
            inputManId: erp.inputManId
        };
        API_CONFIG.defaultValues = {
            businessType: erp.businessType,
            supplierId: erp.supplierId,
            inputManId: erp.inputManId,
            erpCustomerId: erp.erpCustomerId,
            erpAssessCustomerId: erp.erpAssessCustomerId
        };
    }
}

// API配置
const API_CONFIG = {
    // 基础URL（用于获取产品、分类等数据）
    baseUrl: (() => {
        const isLocal = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' || 
                       window.location.hostname === '';
        return isLocal ? 'http://localhost:3330' : window.location.origin;
    })(),
    
    // 同步接口地址（用于提交订单）
    // 注意：应该发送到本地服务器，由服务器转发到ERP
    syncUrl: (() => {
        // 优先级1: 从 window.API_CONFIG_OVERRIDE 读取（如果存在）
        if (window.API_CONFIG_OVERRIDE && window.API_CONFIG_OVERRIDE.syncUrl) {
            console.log('使用配置覆盖:', window.API_CONFIG_OVERRIDE.syncUrl);
            return window.API_CONFIG_OVERRIDE.syncUrl;
        }
        
        // 优先级2: 从 localStorage 读取配置
        const savedUrl = localStorage.getItem('api_sync_url');
        if (savedUrl) {
            console.log('使用保存的配置:', savedUrl);
            return savedUrl;
        }
        
        // 优先级3: 自动检测环境 - 统一发送到当前服务器
        const isLocal = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname === '';
        
        // 统一使用当前服务器的 receive_data 接口，由服务器转发到ERP
        const defaultUrl = isLocal 
            ? 'http://localhost:3330/receive_data'  // 本地开发
            : window.location.origin + '/receive_data';  // 生产环境：使用当前域名
        
        console.log('使用默认配置:', defaultUrl, isLocal ? '(本地开发)' : '(生产环境)');
        return defaultUrl;
    })(),
    
    // 默认值（从window.CUSTOMER_CONFIG读取，如果没有则使用默认值）
    defaultValues: (() => {
        const customerConfig = window.CUSTOMER_CONFIG || {};
        return {
            businessType: 'DS01',
            supplierId: customerConfig.supplier?.id || '2',
            inputManId: customerConfig.inputManId || 'system', // 现在允许'system'或数字字符串
            erpCustomerId: customerConfig.customer?.id || '7522',
            erpAssessCustomerId: customerConfig.customer?.assessCustomerId || '858'
        };
    })(),
    
    // 请求超时时间（毫秒）- 增加到30秒，因为需要服务器转发到ERP
    timeout: 30000
};

applyUserConfig();

console.warn('[海尔施下单] script.js 已加载, 货品接口:', API_CONFIG.baseUrl);

// 产品数据（从API加载）
let productsData = [];
let categoriesData = [];
const UNCATEGORIZED_LABEL = '无分类';

/** 无分类、空字符串、「未分类」统一归到「无分类」 */
function normalizeProductCategory(category) {
    if (category === null || category === undefined) return UNCATEGORIZED_LABEL;
    const s = String(category).trim();
    if (!s || s === '未分类') return UNCATEGORIZED_LABEL;
    return s;
}

function applyCategoryNormalization(products) {
    return products.map((p) => ({ ...p, category: normalizeProductCategory(p.category) }));
}

/** 内联 onclick 用：字符串 id（如 ora:客户:货品:协议价）须 JSON 引号包裹 */
function idForOnclick(id) {
    return typeof id === 'string' ? JSON.stringify(id) : id;
}

// 购物车按用户隔离；多客户时按“当前客户”再隔离（key: cart_用户名 或 cart_用户名_客户id）
function getCartStorageKey() {
    var u = getStoredUser();
    if (!u) return 'cart';
    var base = 'cart_' + (u.username || u.id);
    if (hasMultipleCustomers()) {
        var c = getCurrentCustomer();
        if (c) return base + '_' + customerEntryStorageSuffix(c);
    }
    return base;
}

function getCartMemoStorageKey() {
    return getCartStorageKey() + '_memo';
}

function getCartOrderMemo() {
    var el = document.getElementById('cartOrderMemo');
    if (el) return String(el.value || '').trim();
    try {
        return String(localStorage.getItem(getCartMemoStorageKey()) || '').trim();
    } catch (e) {
        return '';
    }
}

function loadCartOrderMemoToUI() {
    var el = document.getElementById('cartOrderMemo');
    if (!el) return;
    try {
        el.value = localStorage.getItem(getCartMemoStorageKey()) || '';
    } catch (e) {
        el.value = '';
    }
}

function saveCartOrderMemo() {
    var el = document.getElementById('cartOrderMemo');
    if (!el) return;
    try {
        localStorage.setItem(getCartMemoStorageKey(), String(el.value || ''));
    } catch (e) {}
}

function clearCartOrderMemo() {
    try {
        localStorage.removeItem(getCartMemoStorageKey());
    } catch (e) {}
    var el = document.getElementById('cartOrderMemo');
    if (el) el.value = '';
}

// 历史订单按用户隔离；多客户时按“当前客户条目”再隔离
function getOrderHistoryKey() {
    var u = getStoredUser();
    if (!u) return 'orderHistory';
    var base = 'orderHistory_' + (u.username || u.id);
    if (hasMultipleCustomers()) {
        var c = getCurrentCustomer();
        if (c) return base + '_' + customerEntryStorageSuffix(c);
    }
    return base;
}

/** 当前用户可能用过的全部 localStorage 历史 key（含未分客户的旧 key） */
function getOrderHistoryStorageKeys() {
    var keys = new Set();
    var u = getStoredUser();
    if (!u) {
        keys.add('orderHistory');
        return Array.from(keys);
    }
    var base = 'orderHistory_' + (u.username || u.id);
    keys.add(base);
    keys.add(getOrderHistoryKey());
    getCustomersList(u).forEach(function (c) {
        if (c) keys.add(base + '_' + customerEntryStorageSuffix(c));
        if (c && c.id) keys.add(base + '_' + String(c.id));
    });
    return Array.from(keys);
}

/** 合并本地各 key 下的历史订单（按订单号去重，新的优先） */
function getLocalOrderHistoryMerged() {
    var byOrderNo = new Map();
    getOrderHistoryStorageKeys().forEach(function (key) {
        try {
            var list = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(list)) return;
            list.forEach(function (order) {
                if (!order || !order.orderNo) return;
                var existing = byOrderNo.get(order.orderNo);
                if (!existing || new Date(order.date) > new Date(existing.date)) {
                    byOrderNo.set(order.orderNo, order);
                }
            });
        } catch (e) {
            console.warn('读取历史订单 key 失败:', key, e);
        }
    });
    return Array.from(byOrderNo.values()).sort(function (a, b) {
        return new Date(b.date) - new Date(a.date);
    });
}

function mergeOrdersByOrderNo(localOrders, serverOrders) {
    var map = new Map();
    (serverOrders || []).forEach(function (o) {
        if (o && o.orderNo) map.set(o.orderNo, o);
    });
    (localOrders || []).forEach(function (o) {
        if (!o || !o.orderNo) return;
        var existing = map.get(o.orderNo);
        var localRicher =
            Array.isArray(o.items) &&
            o.items.length &&
            (!existing || !Array.isArray(existing.items) || !existing.items.length || o.items[0].name);
        if (!existing || localRicher) {
            var merged = localRicher && existing ? Object.assign({}, existing, o) : o;
            if (existing) {
                if (!merged.orderPlacerName && existing.orderPlacerName) {
                    merged.orderPlacerName = existing.orderPlacerName;
                }
                if (!merged.orderPlacedAt && existing.orderPlacedAt) {
                    merged.orderPlacedAt = existing.orderPlacedAt;
                }
            }
            map.set(o.orderNo, merged);
        }
    });
    return Array.from(map.values()).sort(function (a, b) {
        return new Date(b.date) - new Date(a.date);
    });
}

async function fetchServerOrderHistory() {
    var customer = getCurrentCustomer();
    var cid =
        (customer && customer.id) ||
        (API_CONFIG.defaultValues && API_CONFIG.defaultValues.erpCustomerId) ||
        '';
    if (!cid) return [];
    var url = API_CONFIG.baseUrl + '/api/orders?customerId=' + encodeURIComponent(String(cid)) + '&limit=100';
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    return data.success && Array.isArray(data.orders) ? data.orders : [];
}

async function loadAllOrderHistory() {
    var local = getLocalOrderHistoryForDisplay();
    try {
        var server = (await fetchServerOrderHistory()).filter(orderBelongsToCurrentCustomerEntry);
        return mergeOrdersByOrderNo(local, server);
    } catch (e) {
        console.warn('从服务器加载历史订单失败，仅显示本地记录:', e.message);
        return local;
    }
}

var _displayOrderHistory = [];

/** 历史订单明细：每单分页（每页条数） */
var ORDER_DETAIL_PAGE_SIZE = 10;
var _orderDetailPageByOrderId = {};
/** 明细 ERP 状态缓存：conno:goodsid → { status, alreqty, waitstqty } */
var _erpLineStatusCache = {};

/**
 * 历史订单明细行 ERP 货品 ID（与抛单 detailList 一致，优先于快照里可能过期的 id/ora）
 */
function resolveOrderLineGoodsid(item, order, lineIndex) {
    if (!item) return '';
    if (order && order.erpData && Array.isArray(order.erpData.detailList) && lineIndex >= 0) {
        var d = order.erpData.detailList[lineIndex];
        if (d && d.goodsid != null) {
            var fromErp = String(d.goodsid).trim();
            if (fromErp) return fromErp;
        }
    }
    var erpOnItem = String(item.erpGoodsId != null ? item.erpGoodsId : '').trim();
    if (erpOnItem && /^\d+$/.test(erpOnItem)) return erpOnItem;
    return resolveOrderGoodsid(item);
}

function getOrderItemGoodsid(item, order, lineIndex) {
    return resolveOrderLineGoodsid(item, order, lineIndex);
}

function erpLineCacheKey(conno, goodsid) {
    return String(conno || '').trim() + ':' + String(goodsid || '').trim();
}

/** 单条明细向 ERP 查询 status、alreqty、waitstqty（逐条请求，减轻单次 SQL 压力） */
async function fetchErpLineStatus(conno, goodsid) {
    var key = erpLineCacheKey(conno, goodsid);
    if (_erpLineStatusCache[key]) {
        return _erpLineStatusCache[key];
    }
    try {
        var res = await fetch(API_CONFIG.baseUrl + '/api/order-erp-line-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ conno: String(conno).trim(), goodsid: String(goodsid).trim() })
        });
        var data = await res.json();
        var row = {
            status: data.success ? data.status || '—' : data.message || '—',
            alreqty: data.success && data.alreqty != null ? String(data.alreqty) : '—',
            waitstqty: data.success && data.waitstqty != null ? String(data.waitstqty) : '—'
        };
        _erpLineStatusCache[key] = row;
        return row;
    } catch (e) {
        console.warn('明细ERP状态查询失败:', conno, goodsid, e.message);
        var errRow = { status: '—', alreqty: '—', waitstqty: '—' };
        _erpLineStatusCache[key] = errRow;
        return errRow;
    }
}

function updateOrderDetailErpCell(orderId, lineIndex, row) {
    var stEl = document.getElementById('erp-line-status-' + orderId + '-' + lineIndex);
    var aqEl = document.getElementById('erp-line-alreqty-' + orderId + '-' + lineIndex);
    var wqEl = document.getElementById('erp-line-waitstqty-' + orderId + '-' + lineIndex);
    if (stEl) stEl.textContent = row.status != null ? row.status : '—';
    if (aqEl) aqEl.textContent = row.alreqty != null ? row.alreqty : '—';
    if (wqEl) wqEl.textContent = row.waitstqty != null ? row.waitstqty : '—';
}

/** 为当前页的每条明细逐条查询 ERP 并刷新单元格 */
async function loadErpStatusForOrderDetailPage(order) {
    if (!order || !order.orderNo) return;
    var orderId = order.id;
    var page = _orderDetailPageByOrderId[orderId] || 1;
    var items = getOrderItemsForPrint(order);
    var start = (page - 1) * ORDER_DETAIL_PAGE_SIZE;
    var pageItems = items.slice(start, start + ORDER_DETAIL_PAGE_SIZE);
    var conno = String(order.orderNo).trim();

    for (var i = 0; i < pageItems.length; i++) {
        var lineIndex = start + i;
        var goodsid = getOrderItemGoodsid(pageItems[i], order, lineIndex);
        updateOrderDetailErpCell(orderId, lineIndex, {
            status: '查询中…',
            alreqty: '…',
            waitstqty: '…'
        });
        if (!goodsid) {
            updateOrderDetailErpCell(orderId, lineIndex, { status: '—', alreqty: '—', waitstqty: '—' });
            continue;
        }
        var row = await fetchErpLineStatus(conno, goodsid);
        updateOrderDetailErpCell(orderId, lineIndex, row);
    }
}

function buildOrderDetailSectionHtml(order) {
    var orderId = order.id;
    var items = getOrderItemsForPrint(order);
    var page = _orderDetailPageByOrderId[orderId] || 1;
    var totalPages = Math.max(1, Math.ceil(items.length / ORDER_DETAIL_PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    _orderDetailPageByOrderId[orderId] = page;
    var start = (page - 1) * ORDER_DETAIL_PAGE_SIZE;
    var pageItems = items.slice(start, start + ORDER_DETAIL_PAGE_SIZE);

    var rowsHtml = '';
    if (!pageItems.length) {
        rowsHtml =
            '<p style="padding:0.5rem;color:var(--text-secondary);font-size:0.9rem;">无明细</p>';
    } else {
        rowsHtml = pageItems
            .map(function (item, idx) {
                var lineIndex = start + idx;
                var goodsid = getOrderItemGoodsid(item, order, lineIndex);
                var gidLabel = goodsid ? escapeHtml(goodsid) : '—';
                var opLabel = resolveOrderItemOperationCode(item, order, lineIndex) || '—';
                return (
                    '<div class="order-detail-line" style="padding:0.5rem;background:white;margin-bottom:0.35rem;border-radius:var(--radius);font-size:0.9rem;">' +
                    '<div>' +
                    escapeHtml(item.name || '货品') +
                    (item.spec ? ' <span style="color:var(--text-secondary);">(' + escapeHtml(item.spec) + ')</span>' : '') +
                    '</div>' +
                    '<div style="color:var(--text-secondary);margin-top:0.2rem;">' +
                    '货品操作码: ' +
                    escapeHtml(opLabel) +
                    ' · ERP货品ID: ' +
                    gidLabel +
                    ' · 数量 ' +
                    escapeHtml(item.quantity) +
                    ' × ¥' +
                    (Number(item.price || 0) * item.quantity).toFixed(2) +
                    '</div>' +
                    '<div style="margin-top:0.35rem;color:#4338ca;">' +
                    '<strong>ERP状态</strong>: <span id="erp-line-status-' +
                    orderId +
                    '-' +
                    lineIndex +
                    '">…</span>' +
                    ' &nbsp; <strong>发货数量</strong>: <span id="erp-line-alreqty-' +
                    orderId +
                    '-' +
                    lineIndex +
                    '">…</span>' +
                    ' &nbsp; <strong>未发货明细</strong>: <span id="erp-line-waitstqty-' +
                    orderId +
                    '-' +
                    lineIndex +
                    '">…</span>' +
                    '</div></div>'
                );
            })
            .join('');
    }

    var pagerHtml = '';
    if (items.length > ORDER_DETAIL_PAGE_SIZE) {
        pagerHtml =
            '<div class="order-detail-pager" style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;">' +
            (page > 1
                ? '<button type="button" class="btn-secondary btn-sm" onclick="changeOrderDetailPage(' +
                  orderId +
                  ',' +
                  (page - 1) +
                  ')">上一页</button>'
                : '') +
            '<span style="font-size:0.85rem;color:var(--text-secondary);">明细第 ' +
            page +
            ' / ' +
            totalPages +
            ' 页（每页 ' +
            ORDER_DETAIL_PAGE_SIZE +
            ' 条）</span>' +
            (page < totalPages
                ? '<button type="button" class="btn-secondary btn-sm" onclick="changeOrderDetailPage(' +
                  orderId +
                  ',' +
                  (page + 1) +
                  ')">下一页</button>'
                : '') +
            '</div>';
    }

    return (
        '<strong>订单明细 (' +
        items.length +
        '项)</strong>' +
        pagerHtml +
        '<div style="margin-top:0.5rem;" id="order-items-' +
        orderId +
        '">' +
        rowsHtml +
        '</div>'
    );
}

window.changeOrderDetailPage = function (orderId, page) {
    var order = findOrderInHistory(orderId);
    if (!order) return;
    _orderDetailPageByOrderId[orderId] = Math.max(1, parseInt(page, 10) || 1);
    var wrap = document.getElementById('order-detail-wrap-' + orderId);
    if (wrap) {
        wrap.innerHTML = buildOrderDetailSectionHtml(order);
        loadErpStatusForOrderDetailPage(order);
    }
};

function escapeHtml(text) {
    const s = String(text == null ? '' : text);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 货品卡片「最近下单」用的订单列表缓存（含服务端合并），saveOrderToHistory 后清空 */
var _hintOrderHistoryCache = null;
var _hintOrderHistoryPromise = null;

function invalidateProductHintHistoryCache() {
    _hintOrderHistoryCache = null;
    _hintOrderHistoryPromise = null;
}

/** 供 renderProducts 使用：合并本地 + 服务端历史（与历史订单弹窗一致） */
function getOrderHistoryForProductHints() {
    if (_hintOrderHistoryCache) {
        return Promise.resolve(_hintOrderHistoryCache);
    }
    if (_hintOrderHistoryPromise) {
        return _hintOrderHistoryPromise;
    }
    _hintOrderHistoryPromise = loadAllOrderHistory()
        .then(function (h) {
            _hintOrderHistoryCache = h;
            _hintOrderHistoryPromise = null;
            return h;
        })
        .catch(function () {
            _hintOrderHistoryPromise = null;
            _hintOrderHistoryCache = getLocalOrderHistoryForDisplay();
            return _hintOrderHistoryCache;
        });
    return _hintOrderHistoryPromise;
}

// 购物车数据（从当前用户的 key 读取）
let cart = (function () {
    try {
        return JSON.parse(localStorage.getItem(getCartStorageKey()) || '[]');
    } catch (e) {
        return [];
    }
})();
let filteredProducts = [];
let productListPage = 1;
const PRODUCT_PAGE_SIZE = 30;
/** 资料下载：当前勾选的货品 id（Set 存字符串） */
let productDownloadSelectedIds = new Set();
let currentCategory = 'all';
let currentSort = 'default';

// 厂家名称过长时缩写（第四级显示用）
const MANUFACTURER_ABBR_LEN = 12;
function abbreviateManufacturer(name) {
    if (!name || typeof name !== 'string') return name || '';
    const t = name.trim();
    return t.length > MANUFACTURER_ABBR_LEN ? t.slice(0, MANUFACTURER_ABBR_LEN) + '…' : t;
}

// 计算分类商品数量（包含子级；includeManufacturer 为 true 时第四级为厂家）
function buildCategoryCounts(products, includeManufacturer) {
    const counts = {};
    products.forEach(p => {
        const cat = normalizeProductCategory(p.category);
        const parts = cat.split(' > ').map(s => s.trim()).filter(Boolean);
        if (includeManufacturer) {
            const mfr = String(p.manufacturer || '').trim();
            const brand = String(p.brand || '').trim();
            if (mfr) parts.push(mfr);
            else if (brand) parts.push(brand);
        }
        let path = '';
        parts.forEach((part, idx) => {
            path = idx === 0 ? part : path + ' > ' + part;
            counts[path] = (counts[path] || 0) + 1;
        });
    });
    return counts;
}

/** 拉取当前客户可见货品档案（与下单列表同源，供历史订单操作码解析） */
async function fetchProductsCatalog() {
    applyUserConfig();
    const productsUrl = API_CONFIG.baseUrl + '/api/products?' + buildProductsApiQuery('');
    const response = await fetch(productsUrl);
    if (response.status === 401) {
        try {
            localStorage.removeItem('order_user');
            localStorage.removeItem('order_api_token');
        } catch (e) {}
        showToast('登录已过期，请重新登录', 'error');
        window.location.href = 'login.html';
        return null;
    }
    if (!response.ok) {
        throw new Error('HTTP ' + response.status);
    }
    const result = await response.json();
    if (!result.success) {
        throw new Error(result.message || '加载产品数据失败');
    }
    if (result.mode || result.sources) {
        console.log('[货品] 数据源:', result.mode || '-', result.sources || {});
    }
    var list = applyCategoryNormalization(result.data || []);
    return list.filter(function (p) {
        return p.status !== 0;
    });
}

/** 历史订单展示前确保货品档案已加载（否则无法按 ERP 货品 ID 解析操作码） */
async function ensureProductsCatalogLoaded() {
    if (productsData && productsData.length > 0) return;
    try {
        var list = await fetchProductsCatalog();
        if (list && list.length) {
            productsData = list;
            filteredProducts = productsData.slice();
            var oracleCount = productsData.filter(function (p) {
                return p.source === 'oracle';
            }).length;
            var sqliteCount = productsData.length - oracleCount;
            console.warn(
                '[历史订单] 已加载货品档案: 协议价 ' + oracleCount + ' 条, 配套 ' + sqliteCount + ' 条'
            );
        }
    } catch (e) {
        console.warn('[历史订单] 货品档案加载失败，操作码无法解析（仅来自可见货品菜单）:', e.message);
    }
}

// 加载产品数据
async function loadProducts() {
    console.warn('[货品] loadProducts 开始');
    applyUserConfig();

    const loading = document.getElementById('loading');
    const grid = document.getElementById('productsGrid');
    const noResults = document.getElementById('noResults');
    if (!loading || !grid) {
        console.error('[货品] 页面元素缺失 loading/productsGrid，请通过 http://localhost:3330/index.html 打开');
        return;
    }

    try {
        loading.style.display = 'block';
        grid.style.display = 'none';
        noResults.style.display = 'none';

        var queryIds = getActiveCustomerSupplierIds();
        var queryIds = getActiveCustomerSupplierIds();
        console.warn(
            '[货品] Oracle协议价 视图客户ID=',
            getOraclePriceCustomerId(),
            '抛单客户ID=',
            queryIds.customerId,
            '供应商ID=',
            queryIds.supplierId,
            usesMultiCustomerEntries() ? '(customers_json当前条)' : '(users表默认)'
        );
        var list = await fetchProductsCatalog();
        if (!list) return;
        productsData = list;
        const oracleCount = productsData.filter((p) => p.source === 'oracle').length;
        const sqliteCount = productsData.filter((p) => p.source === 'sqlite').length;
        console.warn(
            `[货品] 协议价(Oracle) ${oracleCount} 条, 配套提供(SQLite) ${sqliteCount} 条, 合计 ${productsData.length} 条`
        );
        filteredProducts = [...productsData];

        await initCategoriesFromProducts();
        filterByCategory(currentCategory);
        renderProducts();
    } catch (error) {
        console.error('加载产品数据失败:', error);
        showToast('加载产品数据失败: ' + error.message, 'error');
        noResults.style.display = 'block';
        noResults.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <p>加载产品数据失败</p>
            <p style="font-size: 12px; color: #999; margin-top: 10px;">${error.message}</p>
            <button onclick="loadProducts()" style="margin-top: 10px; padding: 8px 16px; background: var(--primary-color); color: white; border: none; border-radius: 4px; cursor: pointer;">
                重试
            </button>
        `;
    } finally {
        loading.style.display = 'none';
    }
}

// 加载分类数据
async function loadCategories() {
    try {
        const response = await fetch(`${API_CONFIG.baseUrl}/api/categories`);
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.success) {
            categoriesData = result.data || [];
            initCategories();
        }
    } catch (error) {
        console.error('加载分类数据失败:', error);
        // 如果加载分类失败，从产品数据中提取分类
        initCategoriesFromProducts();
    }
}

// 获取分类自定义显示顺序（用于产品分类下拉的先后顺序，按当前客户）
async function getCategoryOrder() {
    try {
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        var r = await fetch(API_CONFIG.baseUrl + '/api/category-order?customerId=' + encodeURIComponent(customerId));
        if (!r.ok) return [];
        var data = await r.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

// 按自定义顺序排序分类路径（order 中出现的优先且按 order 顺序，其余按拼音）
function sortPathListByOrder(pathList, order) {
    if (!order || !order.length) return pathList.slice().sort(function(a, b) { return a.localeCompare(b, 'zh-CN'); });
    var orderMap = {};
    order.forEach(function(p, i) { orderMap[p] = i; });
    return pathList.slice().sort(function(a, b) {
        var ia = orderMap[a];
        var ib = orderMap[b];
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.localeCompare(b, 'zh-CN');
    });
}

// 从产品数据中提取分类（仅保留下拉框；第四级为厂家，按 data/categoryOrder.json 自定义顺序排序）
async function initCategoriesFromProducts() {
    const extended = new Set();
    productsData.forEach(p => {
        const cat = normalizeProductCategory(p.category);
        extended.add(cat);
        if (cat !== UNCATEGORIZED_LABEL) {
            const mfr = String(p.manufacturer || '').trim();
            const brand = String(p.brand || '').trim();
            if (mfr) extended.add(cat + ' > ' + mfr);
            else if (brand) extended.add(cat + ' > ' + brand);
        }
    });
    const categories = Array.from(extended);
    const counts = buildCategoryCounts(productsData, true);
    const categoryTree = buildCategoryTree(categories);
    const pathList = [];
    buildCategoryPathList(categoryTree, pathList);
    var order = await getCategoryOrder();
    var sorted = sortPathListByOrder(pathList, order);
    fillCategoryQuickSelect(sorted, counts);
    
    const quickSel = document.getElementById('categoryQuickSelect');
    if (quickSel && !quickSel._bound) {
        quickSel._bound = true;
        quickSel.addEventListener('change', function() {
            filterByCategory(this.value);
        });
    }
}

// 初始化页面
// 退出登录：清除用户信息并跳转登录页
function logout() {
    closeHeaderHelpMenu();
    try {
        localStorage.removeItem('order_user');
        localStorage.removeItem('order_api_token');
    } catch (e) {}
    window.location.href = 'login.html';
}

function closeHeaderHelpMenu() {
    var wrap = document.querySelector('.header-help-wrap');
    var btn = document.getElementById('headerHelpBtn');
    if (wrap) wrap.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleHeaderHelpMenu(event) {
    if (event) event.stopPropagation();
    var wrap = document.querySelector('.header-help-wrap');
    var btn = document.getElementById('headerHelpBtn');
    if (!wrap || !btn) return;
    var willOpen = !wrap.classList.contains('open');
    closeHeaderHelpMenu();
    if (willOpen) {
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
    }
}

document.addEventListener('click', function (event) {
    var wrap = document.querySelector('.header-help-wrap');
    if (!wrap || !wrap.classList.contains('open')) return;
    if (wrap.contains(event.target)) return;
    closeHeaderHelpMenu();
});

document.addEventListener('DOMContentLoaded', function() {
    console.warn('[海尔施下单] DOMContentLoaded，开始初始化');
    var user = getStoredUser();
    if (!user) {
        console.warn('[海尔施下单] 未登录，将跳转 login.html');
    } else {
        try {
            if (!localStorage.getItem('order_api_token')) {
                localStorage.removeItem('order_user');
                window.location.replace('login.html');
                return;
            }
        } catch (e) {}
    }
    var curCustomer = usesMultiCustomerEntries()
        ? getCurrentCustomer()
        : (user && user.customer) || getCurrentCustomer();
    var headerUser = document.getElementById('headerUserInfo');
    var wrap = document.getElementById('currentCustomerWrap');
    var sel = document.getElementById('currentCustomerSelect');
    var isMulti = hasMultipleCustomers() && wrap && sel;

    if (isMulti) {
        wrap.style.display = 'flex';
        if (headerUser) {
            headerUser.style.display = 'none';
            headerUser.textContent = '';
        }
    } else if (headerUser && curCustomer) {
        headerUser.style.display = '';
        headerUser.textContent = curCustomer.name || (user && user.username) || '';
        var sup = getSupplierForCurrentCustomer();
        headerUser.title =
            '当前下单客户: ' +
            (curCustomer.name || '') +
            (sup && sup.id ? ' | 供应商ID: ' + sup.id + (sup.name ? ' ' + sup.name : '') : '');
    }

    if (isMulti) {
        var list = getCustomersList(user);
        try {
            var savedKey = localStorage.getItem('order_current_customer');
            if (savedKey && !resolveCustomerFromSaved(savedKey, list)) {
                var bare = String(savedKey).trim();
                var ambiguous = list.filter(function (c) {
                    return String(c.id) === bare;
                });
                if (ambiguous.length > 1) {
                    localStorage.setItem('order_current_customer', String(ambiguous[0].entryKey));
                    curCustomer = ambiguous[0];
                    console.warn(
                        '[多客户] 旧版仅存客户ID「' +
                            bare +
                            '」，已绑定到: ' +
                            (ambiguous[0].name || ambiguous[0].entryKey)
                    );
                }
            }
        } catch (e) {}
        sel.innerHTML = list
            .map(function (c) {
                return (
                    '<option value="' +
                    escapeHtml(String(c.entryKey || c.id)) +
                    '">' +
                    escapeHtml(c.name || c.id) +
                    '</option>'
                );
            })
            .join('');
        sel.value = curCustomer && curCustomer.entryKey ? String(curCustomer.entryKey) : '';
        sel.addEventListener('change', function () {
            var key = this.value;
            if (key) {
                try {
                    localStorage.setItem('order_current_customer', key);
                } catch (e) {}
                window.location.reload();
            }
        });
    }
    
    loadProducts().catch(function (err) {
        console.error('[货品] loadProducts 未捕获异常:', err);
    });
    initProductFilesBar();
    loadCartOrderMemoToUI();
    updateCartUI();

    // 进销存管理入口（仅 canInventory 或管理员可见）
    var invBtn = document.getElementById('invManagementBtn');
    if (invBtn && user) {
        var showInv = user.canInventory === true ||
            user.isAdmin === true ||
            String(user.username || '').trim().toLowerCase() === 'admin';
        if (showInv) invBtn.style.display = '';
    }

    var searchInput = document.getElementById('searchInput');
    if (!searchInput) {
        console.error('[海尔施下单] 未找到 searchInput，请确认在 index.html 下单页');
        return;
    }

    // 搜索框回车事件
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });
    
    // 实时搜索
    searchInput.addEventListener('input', function(e) {
        if (e.target.value.trim() === '') {
            filteredProducts = [...productsData];
            filterByCategory(currentCategory);
            renderProducts();
        }
    });
    
    var menuImportInput = document.getElementById('menuQtyImportFile');
    if (menuImportInput && !menuImportInput._boundMenuImport) {
        menuImportInput._boundMenuImport = true;
        menuImportInput.addEventListener('change', function () {
            importMenuQtyFromExcel(this);
        });
    }

    // 初始化模态框事件监听（防止意外关闭）
    initModalEvents();
});

// 初始化模态框事件
function initModalEvents() {
    // 点击模态框外部关闭（阻止事件冒泡）
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', function(e) {
            // 只有当点击的是 overlay 本身（不是 modal-content）时才关闭
            if (e.target === this) {
                closeModal();
            }
        });
        
        // 阻止模态框内容区域的点击事件冒泡到 overlay
        const modalContent = modalOverlay.querySelector('.modal-content');
        if (modalContent) {
            modalContent.addEventListener('click', function(e) {
                e.stopPropagation();
            });
        }
    }
    
    // 阻止表单提交的默认行为
    const orderForm = document.getElementById('orderForm');
    if (orderForm) {
        orderForm.addEventListener('submit', function(e) {
            e.preventDefault();
            e.stopPropagation();
            submitOrder(e);
            return false;
        });
    }
}

// 构建分类树结构
function buildCategoryTree(categories) {
    const tree = {};
    
    categories.forEach(category => {
        if (!category) return;
        
        // 解析分类层级（格式：一级 > 二级 > 三级）
        const parts = category.split(' > ').map(p => p.trim()).filter(p => p);
        
        let current = tree;
        parts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = {
                    name: part,
                    fullPath: parts.slice(0, index + 1).join(' > '),
                    level: index,
                    children: {},
                    isLeaf: index === parts.length - 1
                };
            }
            current = current[part].children;
        });
    });
    
    return tree;
}

// 从树中收集所有分类路径（一级、二级、三级均包含），用于下拉快速选择
function buildCategoryPathList(node, out) {
    if (!node || typeof node !== 'object') return;
    const sorted = Object.values(node).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    sorted.forEach(categoryNode => {
        out.push(categoryNode.fullPath);
        buildCategoryPathList(categoryNode.children, out);
    });
}

// 填充分类快速下拉框（第四级厂家过长时缩写显示）
function fillCategoryQuickSelect(pathList, counts) {
    const sel = document.getElementById('categoryQuickSelect');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="all">全部产品</option>';
    pathList.forEach(fullPath => {
        const opt = document.createElement('option');
        opt.value = fullPath;
        const parts = fullPath.split(' > ').map(p => p.trim()).filter(Boolean);
        const displayPath = parts.length === 4
            ? parts[0] + ' > ' + parts[1] + ' > ' + parts[2] + ' > ' + abbreviateManufacturer(parts[3])
            : fullPath;
        const count = counts[fullPath] || 0;
        opt.textContent = displayPath + (count ? ' (' + count + ')' : '');
        sel.appendChild(opt);
    });
    if (current && (current === 'all' || pathList.indexOf(current) !== -1)) {
        sel.value = current;
    }
}

// 递归渲染分类树（counts 为各路径商品数，默认全部折叠）
function renderCategoryTree(node, parentElement, counts, level = 0) {
    if (!counts) counts = {};
    const sortedNodes = Object.values(node)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    
    sortedNodes.forEach(categoryNode => {
            const li = document.createElement('li');
            li.className = 'category-item';
        li.dataset.category = categoryNode.fullPath;
        li.dataset.level = categoryNode.level;
        
        const hasChildren = Object.keys(categoryNode.children).length > 0;
        const isExpanded = false; // 默认全部折叠，点开再展开
        
        let html = '';
        html += '<span class="category-indent" style="display: inline-block; width: ' + (level * 14) + 'px;"></span>';
        if (hasChildren) {
            html += `<i class="fas fa-chevron-right category-toggle" style="font-size: 10px; margin-right: 4px; cursor: pointer;"></i>`;
        } else {
            html += '<span style="display: inline-block; width: 14px; margin-right: 4px;"></span>';
        }
        const count = counts[categoryNode.fullPath] || 0;
        html += `<i class="fas fa-${hasChildren ? 'folder' : 'tag'}" style="margin-right: 6px;"></i>`;
        html += `<span class="category-name">${categoryNode.name}</span>`;
        html += `<span class="category-count">${count ? count : ''}</span>`;
        li.innerHTML = html;
        
        const toggleIcon = li.querySelector('.category-toggle');
        if (toggleIcon) {
            toggleIcon.onclick = (e) => {
                e.stopPropagation();
                const childrenList = li.querySelector('.category-children');
                if (childrenList) {
                    const expanded = childrenList.style.display !== 'none';
                    childrenList.style.display = expanded ? 'none' : 'block';
                    toggleIcon.className = 'fas fa-chevron-' + (expanded ? 'right' : 'down') + ' category-toggle';
                }
            };
        }
        
        li.onclick = (e) => {
            if (e.target.classList.contains('category-toggle')) return;
            filterByCategory(categoryNode.fullPath);
        };
        
        parentElement.appendChild(li);
        
        if (hasChildren) {
            const childrenList = document.createElement('ul');
            childrenList.className = 'category-children';
            childrenList.style.display = 'none';
            li.appendChild(childrenList);
            renderCategoryTree(categoryNode.children, childrenList, counts, level + 1);
        }
    });
}

// 初始化分类（仅保留下拉框，含第四级厂家）
function initCategories() {
    const extended = new Set();
    productsData.forEach(p => {
        const cat = normalizeProductCategory(p.category);
        extended.add(cat);
        if (cat !== UNCATEGORIZED_LABEL) {
            const mfr = String(p.manufacturer || '').trim();
            const brand = String(p.brand || '').trim();
            if (mfr) extended.add(cat + ' > ' + mfr);
            else if (brand) extended.add(cat + ' > ' + brand);
        }
    });
    const categories = Array.from(extended);
    const counts = buildCategoryCounts(productsData, true);
    const categoryTree = buildCategoryTree(categories);
    const pathList = [];
    buildCategoryPathList(categoryTree, pathList);
    pathList.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    fillCategoryQuickSelect(pathList, counts);
    
    const quickSel = document.getElementById('categoryQuickSelect');
    if (quickSel && !quickSel._bound) {
        quickSel._bound = true;
        quickSel.addEventListener('change', function() {
            filterByCategory(this.value);
        });
    }
}

// 按分类筛选（支持一级/二级/三级/四级厂家任选，显示该分类及其下所有货品）
// 说明：下拉中“一级>二级>厂家”为 3 段（第3段是厂家），“一级>二级>三级>厂家”为 4 段，均需正确匹配
function filterByCategory(category) {
    currentCategory = category;
    const parts = category.split(' > ').map(p => p.trim()).filter(Boolean);
    if (category === 'all') {
        filteredProducts = [...productsData];
    } else if (category === UNCATEGORIZED_LABEL) {
        filteredProducts = productsData.filter(
            (p) => normalizeProductCategory(p.category) === UNCATEGORIZED_LABEL
        );
    } else if (parts.length === 4) {
        const cat3 = parts[0] + ' > ' + parts[1] + ' > ' + parts[2];
        const manufacturer = parts[3];
        filteredProducts = productsData.filter(p => {
            const cat = normalizeProductCategory(p.category);
            const label = String(p.manufacturer || p.brand || '').trim();
            return (cat === cat3 || cat.startsWith(cat3 + ' >')) && label === manufacturer;
        });
    } else if (parts.length === 3) {
        // 3 段可能是：纯三级分类，或 二级分类+厂家（扩展树里厂家作为第3段）
        const cat2 = parts[0] + ' > ' + parts[1];
        const third = parts[2];
        filteredProducts = productsData.filter(p => {
            const cat = normalizeProductCategory(p.category);
            const thirdLabel = String(p.manufacturer || p.brand || '').trim();
            return cat === category || cat.startsWith(category + ' >') ||
                   (cat === cat2 && thirdLabel === third);
        });
    } else {
        filteredProducts = productsData.filter(p => {
            const cat = normalizeProductCategory(p.category);
            return cat === category || cat.startsWith(category + ' >');
        });
    }
    
    const quickSel = document.getElementById('categoryQuickSelect');
    if (quickSel) quickSel.value = category;
    
    const displayTitle = parts.length === 4
        ? parts[0] + ' > ' + parts[1] + ' > ' + parts[2] + ' > ' + abbreviateManufacturer(parts[3])
        : category;
    document.getElementById('sectionTitle').textContent = category === 'all' ? '全部产品' : displayTitle;
    
    applySort();
    resetProductListPage();
    renderProducts();
}

// 执行搜索
async function performSearch() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    
    if (!searchTerm) {
        filteredProducts = [...productsData];
        filterByCategory(currentCategory);
        return;
    }
    
    try {
        const loading = document.getElementById('loading');
        loading.style.display = 'block';
        
        const response = await fetch(
            API_CONFIG.baseUrl +
                '/api/products?' +
                buildProductsApiQuery('&search=' + encodeURIComponent(searchTerm))
        );
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.success) {
            filteredProducts = applyCategoryNormalization(result.data || []).filter(p => p.status !== 0);
            document.getElementById('sectionTitle').textContent = `搜索结果: "${searchTerm}" (${filteredProducts.length}个)`;
            applySort();
            resetProductListPage();
            renderProducts();
        } else {
            throw new Error(result.message || '搜索失败');
        }
    } catch (error) {
        console.error('搜索失败:', error);
        showToast('搜索失败: ' + error.message, 'error');
        // 降级到本地搜索（包括操作码搜索）
        const searchLower = searchTerm.toLowerCase();
    filteredProducts = productsData.filter(product => 
            product.name.toLowerCase().includes(searchLower) ||
            (product.category && product.category.toLowerCase().includes(searchLower)) ||
            (product.spec && product.spec.toLowerCase().includes(searchLower)) ||
            (product.manufacturer && product.manufacturer.toLowerCase().includes(searchLower)) ||
            (product.operationCode && product.operationCode.toLowerCase().includes(searchLower)) ||
            (product.erpGoodsId && product.erpGoodsId.toLowerCase().includes(searchLower))
        );
        document.getElementById('sectionTitle').textContent = `搜索结果: "${searchTerm}" (${filteredProducts.length}个)`;
    applySort();
    resetProductListPage();
    renderProducts();
    } finally {
        document.getElementById('loading').style.display = 'none';
    }
}

// 排序产品
function sortProducts() {
    currentSort = document.getElementById('sortSelect').value;
    applySort();
    resetProductListPage();
    renderProducts();
}

// 应用排序
function applySort() {
    switch(currentSort) {
        case 'name':
            filteredProducts.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            break;
        case 'price-asc':
            filteredProducts.sort((a, b) => a.price - b.price);
            break;
        case 'price-desc':
            filteredProducts.sort((a, b) => b.price - a.price);
            break;
        default:
            // 保持原始顺序
            break;
    }
}

/** 订单行中的货品是否与当前 product.id 对应（兼容 ora:客户:ERP货品ID:价类 与纯数字 ERP id） */
function orderItemMatchesProduct(productId, item) {
    if (!item) return false;
    const pid = String(productId ?? '');
    if (item.id === productId || item.id == productId) {
        const itemId = String(item.id ?? '').trim();
        // 服务端/ERP 明细行 id 常为 goodsid（纯数字），不得与 SQLite 自增主键同号误匹配
        if (/^\d+$/.test(itemId) && /^\d+$/.test(pid)) {
            const itemErp = String(item.erpGoodsId ?? '').trim();
            if (itemErp && itemErp === itemId) return false;
        }
        return true;
    }
    if (item.erpGoodsId != null && (String(item.erpGoodsId) === pid || item.erpGoodsId == productId)) {
        const itemErp = String(item.erpGoodsId ?? '').trim();
        if (/^\d+$/.test(itemErp) && /^\d+$/.test(pid) && pid.indexOf('ora:') !== 0) {
            return false;
        }
        return true;
    }
    if (pid.startsWith('ora:')) {
        const parts = pid.split(':');
        const erpFromOra = parts.length >= 3 ? String(parts[2]).trim() : '';
        if (erpFromOra && (String(item.id) === erpFromOra || String(item.erpGoodsId) === erpFromOra)) {
            return true;
        }
    }
    return false;
}

// 获取货品最近一次成功下单的数量和日期
function getLastOrderInfo(productId, orderHistory) {
    try {
        const orders = orderHistory || getLocalOrderHistoryForDisplay();

        for (const order of orders) {
            const receiveStatus = order.receiveStatus || {};
            // 只要本系统已接收订单即展示「最近下单」（与是否 ERP 业务成功解耦，避免永远不显示）
            if (!receiveStatus.serverReceived) continue;

            const items = Array.isArray(order.items) ? order.items : [];
            const item = items.find((it) => orderItemMatchesProduct(productId, it));
            if (item) {
                return {
                    quantity: item.quantity,
                    date: order.date,
                    orderNo: order.orderNo
                };
            }
        }
        return null;
    } catch (e) {
        console.error('获取最近下单信息失败:', e);
        return null;
    }
}

function resetProductListPage() {
    productListPage = 1;
}

window.changeProductListPage = function (page) {
    var totalPages = Math.ceil(filteredProducts.length / PRODUCT_PAGE_SIZE) || 1;
    productListPage = Math.max(1, Math.min(parseInt(page, 10) || 1, totalPages));
    renderProducts();
    var grid = document.getElementById('productsGrid');
    if (grid && grid.scrollIntoView) {
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

function renderProductPagination(total, currentPage) {
    var container = document.getElementById('productPagination');
    if (!container) return;
    var totalPages = Math.ceil(total / PRODUCT_PAGE_SIZE) || 1;
    if (total <= PRODUCT_PAGE_SIZE) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '0.5rem';
    container.style.flexWrap = 'wrap';
    container.style.marginTop = '1rem';
    var html =
        '<button type="button" class="btn-secondary btn-sm"' +
        (currentPage <= 1 ? ' disabled' : '') +
        ' onclick="changeProductListPage(' +
        (currentPage - 1) +
        ')">上一页</button>';
    html +=
        '<span style="font-size:0.85rem;color:var(--text-secondary);">共 ' +
        total +
        ' 条，第 ' +
        currentPage +
        ' / ' +
        totalPages +
        ' 页（每页 ' +
        PRODUCT_PAGE_SIZE +
        ' 条）</span>';
    html +=
        '<button type="button" class="btn-secondary btn-sm"' +
        (currentPage >= totalPages ? ' disabled' : '') +
        ' onclick="changeProductListPage(' +
        (currentPage + 1) +
        ')">下一页</button>';
    container.innerHTML = html;
}

// 渲染产品列表
async function renderProducts() {
    const grid = document.getElementById('productsGrid');
    const loading = document.getElementById('loading');
    const noResults = document.getElementById('noResults');
    const paginationEl = document.getElementById('productPagination');

    if (filteredProducts.length === 0) {
        grid.style.display = 'none';
        loading.style.display = 'none';
        noResults.style.display = 'block';
        if (paginationEl) {
            paginationEl.style.display = 'none';
            paginationEl.innerHTML = '';
        }
        return;
    }

    var total = filteredProducts.length;
    var totalPages = Math.ceil(total / PRODUCT_PAGE_SIZE) || 1;
    if (productListPage > totalPages) productListPage = totalPages;
    if (productListPage < 1) productListPage = 1;
    var start = (productListPage - 1) * PRODUCT_PAGE_SIZE;
    var pageProducts = filteredProducts.slice(start, start + PRODUCT_PAGE_SIZE);

    grid.style.display = 'grid';
    loading.style.display = 'none';
    noResults.style.display = 'none';

    const hintOrders = await getOrderHistoryForProductHints();

    grid.innerHTML = pageProducts.map(product => {
        // 获取最近一次成功下单的信息
        const lastOrder = getLastOrderInfo(product.id, hintOrders);
        const lastOrderInfo = lastOrder ? (() => {
            const orderDate = new Date(lastOrder.date);
            const now = new Date();
            const diffMs = now - orderDate;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            
            let dateStr = '';
            if (diffDays === 0) {
                const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                if (diffHours === 0) {
                    const diffMins = Math.floor(diffMs / (1000 * 60));
                    dateStr = diffMins <= 0 ? '刚刚' : `${diffMins}分钟前`;
                } else {
                    dateStr = `${diffHours}小时前`;
                }
            } else if (diffDays === 1) {
                dateStr = '昨天';
            } else if (diffDays < 7) {
                dateStr = `${diffDays}天前`;
            } else {
                dateStr = orderDate.toLocaleDateString('zh-CN', { 
                    month: 'short', 
                    day: 'numeric'
                });
            }
            
            return `
            <div class="product-last-order" style="
                margin-top: 8px;
                padding: 6px 10px;
                background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
                border-left: 3px solid #3b82f6;
                border-radius: 4px;
                font-size: 12px;
                color: #1e40af;
                display: flex;
                align-items: center;
                gap: 6px;
            ">
                <i class="fas fa-history" style="color: #3b82f6;"></i>
                <span><strong>最近下单:</strong> ${lastOrder.quantity} ${product.unit || '件'}</span>
                <span style="margin-left: auto; font-size: 11px; color: #64748b;">${dateStr}</span>
            </div>
        `;
        })() : '';
        
        const maxQty = getProductMaxOrderQty(product);

        const pidKey = String(product.id);
        const erpGoodsIdLabel = getProductExportId(product);
        const canDownloadFile = !!String(product.operationCode || '').trim();
        const checkedForDownload =
            canDownloadFile && productDownloadSelectedIds.has(pidKey);

        return `
        <div class="product-card" data-product-id="${encodeURIComponent(String(product.id))}">
            <label class="product-download-check" onclick="event.stopPropagation()" title="${canDownloadFile ? '勾选以下载资料' : '无操作码，无法下载资料'}">
                <input type="checkbox" class="product-download-cb" data-product-id="${encodeURIComponent(pidKey)}"
                    ${checkedForDownload ? 'checked' : ''} ${canDownloadFile ? '' : 'disabled'}
                    onchange="onProductDownloadCheckChange(this)">
            </label>
            <div class="product-info">
                <span class="product-category">${normalizeProductCategory(product.category)}</span>
                <h3 class="product-name">${product.name}</h3>
                ${erpGoodsIdLabel ? `<p class="product-erp-goods-id" style="font-size: 12px; color: #0f766e; margin-top: 4px;"><i class="fas fa-hashtag"></i> ERP货品ID: ${escapeHtml(erpGoodsIdLabel)}</p>` : ''}
                ${product.operationCode ? `<p class="product-operation-code" style="font-size: 12px; color: #2563eb; margin-top: 4px; font-weight: 600;"><i class="fas fa-barcode"></i> 操作码: ${product.operationCode}</p>` : ''}
                ${product.spec ? `<p class="product-spec">${product.spec}</p>` : ''}
                ${product.manufacturer ? `<p class="product-manufacturer"><i class="fas fa-industry"></i> ${product.manufacturer}</p>` : ''}
                ${product.brand ? `<p class="product-brand" style="font-size: 12px; color: #666; margin-top: 4px;"><i class="fas fa-tag"></i> ${product.brand}</p>` : ''}
                ${lastOrderInfo}
            </div>
            <div class="product-bottom">
                <div class="product-price-wrap">
                    <div class="product-price">¥${(product.price || 0).toFixed(2)}</div>
                    ${product.priceType ? `<span class="product-price-type">${product.priceType}</span>` : ''}
                </div>
                <div class="product-cart-actions">
                    <label class="product-qty-label">下单数量</label>
                    <div class="product-qty-controls">
                        <button type="button" class="quantity-btn" onclick="event.stopPropagation(); adjustProductCardQty(this, -1)">-</button>
                        <input type="number" class="product-qty-input" min="0.01" step="any" max="${maxQty}" value="1"
                               onclick="event.stopPropagation()" onkeydown="event.stopPropagation()"
                               onchange="normalizeProductCardQtyInput(this)" onwheel="this.blur()">
                        <button type="button" class="quantity-btn" onclick="event.stopPropagation(); adjustProductCardQty(this, 1)">+</button>
                    </div>
                    <button type="button" class="add-to-cart-btn" onclick="event.stopPropagation(); addToCartFromCard(this)">
                        <i class="fas fa-cart-plus"></i> 加入购物车
                    </button>
                </div>
            </div>
        </div>
        `;
    }).join('');
    updateProductFilesSelectedCount();
    renderProductPagination(total, productListPage);
}

/** 下单数量：默认 1.00，保留 2 位小数，最小 0.01，最大 120000 */
var ORDER_QTY_DEFAULT = 1;
var ORDER_QTY_MIN = 0.01;
var ORDER_QTY_MAX = 120000;

function getProductMaxOrderQty(product) {
    const stock = product && product.stock != null ? Number(product.stock) : 0;
    if (Number.isFinite(stock) && stock > 0) {
        return Math.min(roundOrderQty(stock), ORDER_QTY_MAX);
    }
    return ORDER_QTY_MAX;
}

function roundOrderQty(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeOrderQuantity(value, maxQty) {
    var q = roundOrderQty(Number(value));
    if (!Number.isFinite(q) || q < ORDER_QTY_MIN) {
        q = ORDER_QTY_DEFAULT;
    }
    var cap = maxQty != null && Number(maxQty) > 0 ? roundOrderQty(maxQty) : ORDER_QTY_MAX;
    q = Math.min(q, cap);
    return q;
}

function formatOrderQtyDisplay(qty) {
    return roundOrderQty(qty).toFixed(2);
}

function formatGoodsqtyForErp(qty) {
    return normalizeOrderQuantity(qty, null).toFixed(2);
}

function adjustProductCardQty(btn, delta) {
    const wrap = btn.closest('.product-qty-controls');
    if (!wrap) return;
    const input = wrap.querySelector('.product-qty-input');
    if (!input) return;
    const card = btn.closest('.product-card');
    const productId = decodeURIComponent((card && card.dataset.productId) || '');
    const product = productsData.find(function (p) {
        return p.id == productId;
    });
    const maxQty = getProductMaxOrderQty(product);
    input.value = formatOrderQtyDisplay(normalizeOrderQuantity(Number(input.value) + delta, maxQty));
}

function normalizeProductCardQtyInput(input) {
    const card = input.closest('.product-card');
    const productId = decodeURIComponent((card && card.dataset.productId) || '');
    const product = productsData.find(function (p) {
        return p.id == productId;
    });
    const maxQty = getProductMaxOrderQty(product);
    input.value = formatOrderQtyDisplay(normalizeOrderQuantity(input.value, maxQty));
}

function addToCartFromCard(btn) {
    const card = btn.closest('.product-card');
    if (!card) return;
    const productId = decodeURIComponent(card.dataset.productId || '');
    const input = card.querySelector('.product-qty-input');
    const qty = input ? normalizeOrderQuantity(input.value, null) : ORDER_QTY_DEFAULT;
    addToCart(productId, qty);
}

// 添加到购物车（quantity 默认 1.00，可从卡片「下单数量」传入，支持小数）
function addToCart(productId, quantity) {
    const product = productsData.find((p) => p.id == productId);
    if (!product) return;

    const maxQty = getProductMaxOrderQty(product);
    let qty = normalizeOrderQuantity(quantity, maxQty);

    const existingItem = cart.find((item) => item.id == productId);

    if (existingItem) {
        showToast('购物车已有该货品，请在购物车内修改数量', 'warning');
        return;
    }

    cart.push({
        ...product,
        erpGoodsId: String(product.erpGoodsId || '').trim(),
        quantity: qty,
        dtlmemo: ''
    });

    saveCart();
    updateCartUI();
    showToast(`${product.name} × ${formatOrderQtyDisplay(qty)} 已加入购物车`);
}

// 更新购物车UI
function updateCartUI() {
    const cartBadge = document.getElementById('cartBadge');
    const cartItems = document.getElementById('cartItems');
    const emptyCart = document.getElementById('emptyCart');
    const totalPrice = document.getElementById('totalPrice');
    const submitBtn = document.getElementById('submitOrderBtn');
    
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    
    cartBadge.textContent = formatOrderQtyDisplay(totalItems);
    totalPrice.textContent = `¥${total.toFixed(2)}`;
    if (submitBtn) submitBtn.disabled = cart.length === 0;
    
    if (cart.length === 0) {
        emptyCart.style.display = 'block';
        cartItems.innerHTML = '';
    } else {
        emptyCart.style.display = 'none';
        cartItems.innerHTML = cart.map(item => {
            const product = productsData.find(p => p.id == item.id);
            const maxQty = getProductMaxOrderQty(product);
            const safeId = typeof item.id === 'string' ? JSON.stringify(item.id) : item.id;
            const memoVal = escapeHtml(String(item.dtlmemo || ''));
            return `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.name}</div>
                    <div class="cart-item-spec">${item.spec}</div>
                    <div class="cart-item-manufacturer"><i class="fas fa-industry"></i> ${item.manufacturer}</div>
                    <input type="text" class="cart-item-memo" placeholder="货品备注 dtlmemo（选填，如批号要求）"
                           value="${memoVal}"
                           onchange='updateCartItemMemo(${safeId}, this.value)'>
                    <div class="cart-item-price">¥${item.price.toFixed(2)} × ${formatOrderQtyDisplay(item.quantity)} = ¥${(item.price * item.quantity).toFixed(2)}</div>
                    <div class="cart-item-controls">
                        <button class="quantity-btn" onclick='updateQuantityByDelta(${safeId}, -1)'>-</button>
                        <input type="number" class="quantity-input" value="${formatOrderQtyDisplay(item.quantity)}"
                               min="0.01" step="any" max="${maxQty}"
                               onchange='updateQuantity(${safeId}, this.value)' onwheel="this.blur()">
                        <button class="quantity-btn" onclick='updateQuantityByDelta(${safeId}, 1)'>+</button>
                        <button class="remove-btn" onclick='removeFromCart(${safeId})'>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        }).join('');
    }
}

// 更新数量（+/- 按钮步进 1；输入框可手工录入小数）
function updateQuantityByDelta(productId, delta) {
    const item = cart.find(function (it) {
        return it.id == productId;
    });
    if (!item) return;
    updateQuantity(productId, Number(item.quantity) + delta);
}

function updateQuantity(productId, newQuantity) {
    const item = cart.find(item => item.id == productId);
    if (!item) return;
    
    const product = productsData.find(p => p.id == productId);
    const maxQty = getProductMaxOrderQty(product);
    newQuantity = normalizeOrderQuantity(newQuantity, maxQty);
    
    item.quantity = newQuantity;
    saveCart();
    updateCartUI();
}

// 更新购物车货品备注 (dtlmemo)
function updateCartItemMemo(productId, memo) {
    const item = cart.find(item => item.id == productId);
    if (!item) return;
    item.dtlmemo = String(memo || '').trim();
    saveCart();
}

// 从购物车移除
function removeFromCart(productId) {
    cart = cart.filter(item => item.id != productId);
    saveCart();
    updateCartUI();
    showToast('已从购物车移除');
}

// 清空购物车
function clearCart() {
    if (cart.length === 0) {
        showToast('购物车已经是空的');
        return;
    }
    
    if (confirm('确定要清空购物车吗？')) {
        cart = [];
        saveCart();
        clearCartOrderMemo();
        updateCartUI();
        showToast('购物车已清空');
    }
}

// 切换购物车显示
function toggleCart() {
    const overlay = document.getElementById('cartOverlay');
    const sidebar = document.getElementById('cartSidebar');
    
    overlay.classList.toggle('show');
    sidebar.classList.toggle('show');
}

// 保存购物车到本地存储（按当前用户 key 保存，各用户购物车相互独立）
function saveCart() {
    try {
        localStorage.setItem(getCartStorageKey(), JSON.stringify(cart));
    } catch (e) {}
}

/**
 * ERP 细单 connodtlid（固定 16 位纯数字）
 * 规则：10 + 11 位毫秒时间戳（取当前毫秒的后 11 位）+ 3 位行号（001 起）
 * 例：10173000000012001
 */
function generateOrderConnodtlid(lineIndex, orderTimeMs) {
    const ms = orderTimeMs != null ? Number(orderTimeMs) : Date.now();
    const ms11 = String(ms).slice(-11).padStart(11, '0');
    const lineNum = (parseInt(lineIndex, 10) || 0) + 1;
    if (lineNum > 999) {
        throw new Error('订单明细超过 999 行，无法生成 connodtlid');
    }
    return '10' + ms11 + String(lineNum).padStart(3, '0');
}

function closeModal() {
    var modal = document.getElementById('modalOverlay');
    if (modal) modal.classList.remove('show');
}

/**
 * 抛 ERP 细单 goodsid：必须为 Oracle/SQLite 档案中的 ERP 货品 ID
 * 禁止使用 SQLite products 表自增主键 id（配套提供常见误用）
 */
function resolveOrderGoodsid(item) {
    if (!item) return '';
    const erp = String(item.erpGoodsId != null ? item.erpGoodsId : '').trim();
    if (erp) {
        if (/^\d+$/.test(erp)) return erp;
        const digits = erp.replace(/[^\d]/g, '');
        if (digits && /^\d+$/.test(digits)) return digits;
    }
    const id = String(item.id != null ? item.id : '').trim();
    if (id.startsWith('ora:')) {
        const parts = id.split(':');
        if (parts.length >= 3) {
            const gid = String(parts[2] || '').trim();
            if (/^\d+$/.test(gid)) return gid;
        }
    }
    return '';
}

/** 提交前用当前货品列表补全购物车行的 erpGoodsId（兼容旧版 localStorage 购物车） */
function enrichCartItemFromCatalog(item) {
    if (!item) return item;
    const p = productsData.find(function (x) {
        return orderItemMatchesProduct(x.id, item);
    });
    if (!p) return item;
    return Object.assign({}, item, {
        id: p.id,
        erpGoodsId: String(item.erpGoodsId || p.erpGoodsId || '').trim(),
        source: item.source || p.source,
        priceType: item.priceType || p.priceType,
        operationCode: String(item.operationCode || p.operationCode || '').trim()
    });
}

// 构造海尔施ERP格式的订单数据
function buildERPOrderData(customerInfo, cartItems) {
    // 生成订单编号：COS-YYMMDDHHMMSSmmm（15 位数字，含毫秒，避免同秒撞号）
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const orderNo = `COS-${year}${month}${day}${hour}${minute}${second}${ms}`;

    if (!/^COS-\d{15}$/.test(orderNo)) {
        console.error('❌ 订单编号格式错误:', orderNo);
        throw new Error(`订单编号格式错误: ${orderNo}，应为 COS-YYMMDDHHMMSSmmm（15位数字）`);
    }
    
    // 订单日期格式：YYYY-MM-DD HH:mm:ss（包含时间部分，时间设为 00:00:00）
    const orderDate = `${now.getFullYear()}-${month}-${day} 00:00:00`;
    const orderTimeMs = now.getTime();

    // 构造订单细单列表
    const detailList = cartItems.map((item, index) => {
        const connodtlid = generateOrderConnodtlid(index, orderTimeMs);
        const goodsid = resolveOrderGoodsid(item);
        const goodsqty = formatGoodsqtyForErp(item.quantity);
        
        // 验证必填字段
        if (!connodtlid || !goodsid || !goodsqty) {
            throw new Error(`订单明细[${index}]缺少必要字段: connodtlid, goodsid, goodsqty`);
        }
        if (!/^\d+$/.test(connodtlid) || !/^\d+$/.test(goodsid)) {
            throw new Error(
                `订单明细[${index}] connodtlid/goodsid 须为整数，` +
                `当前 connodtlid=${connodtlid}, goodsid=${goodsid}`
            );
        }
        if (!/^\d+(\.\d{1,2})?$/.test(goodsqty) || Number(goodsqty) < ORDER_QTY_MIN) {
            throw new Error(
                `订单明细[${index}] goodsqty 须为不小于 ${ORDER_QTY_MIN} 的数字（最多 2 位小数），当前 goodsqty=${goodsqty}`
            );
        }
        
        return {
            conno: orderNo, // 必须与主单conno一致
            connodtlid: connodtlid, // 细单唯一ID（时间戳生成）
            goodsid: goodsid, // ERP货品ID（优先使用erpGoodsId，如果没有则使用产品ID）
            goodsqty: goodsqty, // 订单细单采购数量
            dtlmemo: String(item.dtlmemo != null ? item.dtlmemo : '').trim() // 货品备注（批号要求等）
        };
    });
    
    // 验证 detailList
    if (!detailList || detailList.length === 0) {
        console.error('❌ 错误: detailList为空，无法提交订单');
        throw new Error('订单明细不能为空');
    }
    const connodtlidSet = new Set(detailList.map((d) => d.connodtlid));
    if (connodtlidSet.size !== detailList.length) {
        throw new Error('本单细单 connodtlid 重复，请重试提交');
    }
    
    const storedUser = getStoredUser();
    const erpDefaults = getOrderErpDefaults();

    // 构造ERP订单数据（entryid=供应商ID，与协议价查询 supplierId 规则一致）
    const erpOrderData = {
        businessType: String(erpDefaults.businessType || 'DS01'),
        conno: orderNo,
        customid: String(erpDefaults.erpCustomerId || ''),
        memo: String(customerInfo.notes || '').trim(), // 订单总单备注
        credate: orderDate,
        entryid: String(erpDefaults.supplierId || ''),
        inputmanid: String(erpDefaults.inputManId || ''),
        assesscustomid: String(erpDefaults.erpAssessCustomerId || ''),
        detailList: detailList, // 订单明细列表（必须包含）
        // 通知用（服务端剥离，不转发 ERP）
        notifyUsername: storedUser && storedUser.username ? String(storedUser.username) : '',
        notifyCustomerName: String(customerInfo.name || '').trim(),
        // 入库 orders 表（服务端剥离，不转发 ERP）
        orderPlacerName: storedUser && storedUser.username ? String(storedUser.username) : '',
        orderPlacedAt: new Date().toISOString(),
        // 历史订单展示快照（服务端剥离，不入 ERP）
        orderHistorySnapshot: {
            customer: customerInfo,
            supplierName: (getSupplierForCurrentCustomer() && getSupplierForCurrentCustomer().name) || '',
            supplierId: (getOrderErpDefaults() && getOrderErpDefaults().supplierId) || '',
            items: cartItems.map(function (item) {
                return {
                    id: item.id,
                    erpGoodsId: resolveOrderGoodsid(item) || item.erpGoodsId || '',
                    operationCode: String(item.operationCode || '').trim(),
                    name: item.name,
                    spec: item.spec || '',
                    dtlmemo: String(item.dtlmemo != null ? item.dtlmemo : '').trim(),
                    price: item.price,
                    quantity: item.quantity,
                    unit: item.unit || '件'
                };
            }),
            total: cartItems.reduce(function (sum, item) {
                return sum + item.price * item.quantity;
            }, 0)
        }
    };
    
    // 验证必填字段
    const requiredFields = ['businessType', 'conno', 'customid', 'credate', 'entryid', 'inputmanid', 'assesscustomid'];
    for (const field of requiredFields) {
        const value = erpOrderData[field];
        if (!value || (typeof value === 'string' && value.trim() === '')) {
            throw new Error(`必填字段 ${field} 不能为空，当前值: ${value}`);
        }
    }
    
    // 验证日期格式（credate是字符串，不需要trim）
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(erpOrderData.credate))) {
        throw new Error(`日期格式错误: ${erpOrderData.credate}，应为 YYYY-MM-DD HH:mm:ss`);
    }
    
    console.log(`✅ 订单数据验证通过，包含 ${detailList.length} 个明细项`);
    console.log(`订单编号: ${orderNo} (格式: COS-YYMMDDHHMMSSmmm)`);
    console.log(`订单日期: ${orderDate}`);
    console.log(
        `ERP主单: customid=${erpDefaults.erpCustomerId}, entryid(供应商)=${erpDefaults.supplierId}, inputmanid(制单人)=${erpDefaults.inputManId}, assesscustomid=${erpDefaults.erpAssessCustomerId}`,
        '当前条目 entryKey=',
        (getCurrentCustomer() && getCurrentCustomer().entryKey) || '(无)',
        'customers_json.supplierId=',
        (getCurrentCustomer() && getCurrentCustomer().supplierId) || '(无)'
    );

    return erpOrderData;
}

// 提交订单（从购物车直接提交）
function submitOrder(event) {
    // 阻止表单默认提交行为和事件冒泡
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    applyUserConfig();

    var customer = getCurrentCustomer();
    var customerName = (customer && customer.name) ? customer.name : '';
    saveCartOrderMemo();
    var notes = getCartOrderMemo();
    var erpPreview = getOrderErpDefaults();
    
    const customerInfo = {
        name: customerName,
        notes: notes
    };
    
    // 验证购物车不为空
    if (!cart || cart.length === 0) {
        showToast('购物车为空，无法提交订单', 'error');
        return;
    }
    
    const cartForSubmit = cart.map(enrichCartItemFromCatalog);
    cart = cartForSubmit;
    saveCart();

    // 验证每个购物车项
    for (const item of cartForSubmit) {
        if (!item.id || !item.name || !item.price || !item.quantity) {
            showToast(`购物车项数据不完整: ${item.name || '未知'}`, 'error');
            return;
        }
        const itemMaxQty = getProductMaxOrderQty(item);
        const itemQty = normalizeOrderQuantity(item.quantity, itemMaxQty);
        if (itemQty < ORDER_QTY_MIN) {
            showToast(`货品数量无效（须 ≥ ${ORDER_QTY_MIN}）: ${item.name}`, 'error');
            return;
        }
        if (itemQty > itemMaxQty) {
            showToast(`货品数量超过上限（最多 ${itemMaxQty}）: ${item.name}`, 'error');
            return;
        }
        if (item.price < 0) {
            showToast(`货品价格无效: ${item.name}`, 'error');
            return;
        }
        const gid = resolveOrderGoodsid(item);
        if (!gid) {
            showToast(
                `货品「${item.name}」缺少 ERP 货品ID，无法抛单。请移除后重新加入购物车，或联系管理员维护 ERP货品ID`,
                'error'
            );
            return;
        }
    }
    
    const submitBtn = document.getElementById('submitOrderBtn');
    if (!submitBtn) {
        console.error('提交按钮未找到 (#submitOrderBtn)');
        showToast('页面元素错误，请 Ctrl+F5 强刷页面后重试', 'error');
        return;
    }
    const originalText = submitBtn.innerHTML;

    const orderData = {
        customer: customerInfo,
        items: cartForSubmit.map(item => ({
            id: item.id,
            erpGoodsId: resolveOrderGoodsid(item) || String(item.erpGoodsId || '').trim(),
            operationCode: String(item.operationCode || '').trim(),
            name: item.name,
            spec: item.spec,
            price: item.price,
            quantity: item.quantity,
            unit: item.unit || '件'
        })),
        total: cartForSubmit.reduce((sum, item) => sum + item.price * item.quantity, 0),
        date: new Date().toISOString()
    };
    
    // 构造ERP格式数据
    let erpOrderData;
    try {
        erpOrderData = buildERPOrderData(customerInfo, cartForSubmit);
    } catch (error) {
        console.error('构造ERP订单数据失败:', error);
        showToast('订单数据验证失败: ' + error.message, 'error');
        return;
    }
    
    console.log('订单数据:', orderData);
    console.log(
        '抛送ERP主单供应商 entryid=',
        erpOrderData.entryid,
        '(解析规则与货品 supplierId 一致, 当前客户',
        erpPreview.erpCustomerId + ')',
        'inputmanid=',
        erpOrderData.inputmanid,
        '(解析规则与 inputManId 一致)'
    );
    console.log('ERP格式数据:', erpOrderData);
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...';
    
    // 发送到同步接口（带超时控制）
    console.log('正在发送到:', API_CONFIG.syncUrl);
    console.log('请求数据大小:', JSON.stringify(erpOrderData).length, '字节');
    console.log('完整请求数据:', JSON.stringify(erpOrderData, null, 2));
    
    // 创建超时Promise
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('请求超时，请检查服务器是否已启动'));
        }, API_CONFIG.timeout);
    });
    
    // 创建请求Promise
    const syncHeaders =
        typeof window.getApiAuthHeaders === 'function'
            ? window.getApiAuthHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
            : { 'Content-Type': 'application/json; charset=utf-8' };

    const fetchPromise = fetch(API_CONFIG.syncUrl, {
        method: 'POST',
        headers: syncHeaders,
        body: JSON.stringify(erpOrderData)
    })
    .then(function (response) {
        if (response.status === 401 && typeof window.handleApiUnauthorized === 'function') {
            window.handleApiUnauthorized(response);
            throw new Error('未登录或会话已过期，请重新登录');
        }
        if (response.status === 403) {
            return response.json().then(function (data) {
                throw new Error(data.message || '无权为该客户下单');
            });
        }
        return response;
    })
    .catch(error => {
        // 捕获网络错误
        console.error('❌ 网络请求失败:', error);
        if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION')) {
            throw new Error('无法连接到服务器。请确保服务器已启动（运行 node server.js）');
        }
        throw error;
    });
    
    // 使用 Promise.race 实现超时控制
    Promise.race([fetchPromise, timeoutPromise])
    .then(response => {
        const httpStatus = response.status;
        if (!response.ok) {
            return response
                .json()
                .catch(function () {
                    return {};
                })
                .then(function (data) {
                    var msg =
                        data && data.message
                            ? data.message
                            : 'HTTP错误! 状态: ' + httpStatus;
                    if (data && data.code === 'DUPLICATE_CONNO') {
                        msg = msg + ' 请再次点击提交。';
                    }
                    throw new Error(msg);
                });
        }
        return response.json().then(data => {
            return { httpStatus, data };
        });
    })
    .then(({ httpStatus, data }) => {
        console.log('同步成功:', data);
        
        // 保存订单到历史记录（包含接收状态）
        saveOrderToHistory(orderData, erpOrderData, {
            success: true,
            httpStatus: httpStatus,
            serverReceived: true,
            serverResponse: data,
            erpSynced: data.success || false,
            erpResult: data.erpResult || null,
            erpError: data.error || null,
            message: data.message || '订单已提交'
        });
        
        // 清空购物车
        cart = [];
        saveCart();
        clearCartOrderMemo();
        updateCartUI();
        
        // 关闭购物车侧栏
        var overlay = document.getElementById('cartOverlay');
        var sidebar = document.getElementById('cartSidebar');
        if (overlay) overlay.classList.remove('show');
        if (sidebar) sidebar.classList.remove('show');
        
        // 刷新产品列表以显示最新的下单信息
        renderProducts();
        
        // 显示成功消息
        if (data.success) {
            showToast('订单提交成功！数据已同步到海尔施ERP并已保存到数据库。', 'success');
        } else {
            showToast('订单已提交，但ERP同步可能存在问题。', 'warning');
        }
        
        // 订单已保存到数据库，不再需要自动导出JSON文件
    })
    .catch(error => {
        console.error('提交订单失败:', error);
        
        // 判断错误类型
        let errorMessage = '订单提交失败';
        let errorType = 'unknown';
        
        if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION')) {
            errorMessage = '无法连接到服务器。请确保：\n1. 服务器已启动（运行 node server.js）\n2. 服务器地址正确\n3. 网络连接正常';
            errorType = 'connection_error';
        } else if (error.message.includes('超时')) {
            errorMessage = '请求超时。服务器可能响应较慢或未启动。';
            errorType = 'timeout';
        } else {
            errorMessage = error.message;
            errorType = 'other';
        }
        
        // 即使接口失败，也保存到历史记录（记录失败状态）
        saveOrderToHistory(orderData, erpOrderData, {
            success: false,
            httpStatus: null,
            serverReceived: false,
            serverResponse: null,
            erpSynced: false,
            erpResult: null,
            erpError: errorMessage,
            errorType: errorType,
            message: '订单提交失败'
        });
        
        // 显示详细错误消息
        alert(errorMessage);
        
        // 询问用户是否继续
        if (confirm('接口调用失败，是否仍要清空购物车？\n注意：订单数据未保存到服务器，请检查网络连接后重试。')) {
            cart = [];
            saveCart();
            clearCartOrderMemo();
            updateCartUI();
        }
    })
    .finally(() => {
        // 恢复按钮状态
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
    });
}

// ---------- 货品资料下载（伙伴云：注册证 / 实物照片 / 说明书） ----------

function updateProductFilesSelectedCount() {
    const el = document.getElementById('productFilesSelectedCount');
    if (!el) return;
    const n = productDownloadSelectedIds.size;
    el.textContent = '已选 ' + n + ' 个货品';
}

function onProductDownloadCheckChange(input) {
    if (!input) return;
    const pid = decodeURIComponent(input.dataset.productId || '');
    if (input.checked) {
        productDownloadSelectedIds.add(pid);
    } else {
        productDownloadSelectedIds.delete(pid);
    }
    updateProductFilesSelectedCount();
}

function selectAllProductsForDownload() {
    filteredProducts.forEach(function (p) {
        if (String(p.operationCode || '').trim()) {
            productDownloadSelectedIds.add(String(p.id));
        }
    });
    renderProducts();
}

function deselectAllProductsForDownload() {
    productDownloadSelectedIds.clear();
    renderProducts();
}

function getSelectedCatalogIdsForDownload() {
    const boxes = document.querySelectorAll('#productFilesCatalogTypes .catalog-type-cb:checked');
    return Array.from(boxes).map(function (el) {
        return String(el.value || '').trim();
    }).filter(Boolean);
}

function resetProductFilesDownloadBtn() {
    var btn = document.getElementById('productFilesDownloadBtn');
    if (!btn) return;
    var stuck = btn.innerHTML && btn.innerHTML.indexOf('fa-spinner') >= 0;
    if (btn.disabled && stuck) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-download"></i> 下载资料';
    }
}

async function initProductFilesBar() {
    resetProductFilesDownloadBtn();
    try {
        const response = await fetch(API_CONFIG.baseUrl + '/api/product-files/config');
        if (window.handleApiUnauthorized && window.handleApiUnauthorized(response)) return;
        const data = await response.json();
        const btn = document.getElementById('productFilesDownloadBtn');
        if (!btn) return;
        if (data && !data.configured) {
            btn.disabled = true;
            btn.title = '服务器未配置 HUOBAN_ACCESS_TOKEN，请联系管理员';
        } else {
            btn.disabled = false;
            btn.title = '';
        }
    } catch (e) {
        var btn2 = document.getElementById('productFilesDownloadBtn');
        if (btn2) {
            btn2.disabled = false;
        }
    }
    updateProductFilesSelectedCount();
}

var _productFilesDownloadBusy = false;

async function downloadSelectedProductFiles() {
    if (_productFilesDownloadBusy) {
        showToast('正在打包，请稍候…', 'warning');
        return;
    }
    applyUserConfig();
    const ids = getActiveCustomerSupplierIds();
    const customerId = ids.customerId;
    const priceCustomerId = getOraclePriceCustomerId();
    const catalogIds = getSelectedCatalogIdsForDownload();

    if (!catalogIds.length) {
        showToast('请至少选择一种资料类型', 'warning');
        return;
    }

    const selectedProducts = filteredProducts.filter(function (p) {
        return productDownloadSelectedIds.has(String(p.id));
    });
    const operationCodes = selectedProducts
        .map(function (p) {
            return String(p.operationCode || '').trim();
        })
        .filter(Boolean);

    if (!operationCodes.length) {
        showToast('请勾选至少一个带操作码的货品', 'warning');
        return;
    }

    const btn = document.getElementById('productFilesDownloadBtn');
    const oldHtml = btn ? btn.innerHTML : '';
    _productFilesDownloadBusy = true;
    if (btn) {
        btn.disabled = true;
        const batchHint =
            operationCodes.length > 100
                ? '（操作码较多，分批查询伙伴云，请稍候）'
                : '';
        btn.innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> 打包中' + batchHint + '…';
    }

    try {
        const response = await fetch(API_CONFIG.baseUrl + '/api/product-files/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerId: customerId,
                priceCustomerId: priceCustomerId,
                operationCodes: operationCodes,
                catalogIds: catalogIds,
                products: selectedProducts.map(function (p) {
                    return {
                        productId: String(p.id),
                        name: p.name || '',
                        spec: p.spec || '',
                        erpGoodsId: getProductExportId(p),
                        operationCode: String(p.operationCode || '').trim()
                    };
                })
            })
        });

        if (window.handleApiUnauthorized && window.handleApiUnauthorized(response)) return;

        const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
        if (!response.ok) {
            let msg = '下载失败';
            if (contentType.indexOf('json') !== -1) {
                const errBody = await response.json();
                msg = (errBody && errBody.message) || msg;
            }
            alert(msg);
            return;
        }

        const blob = await response.blob();
        if (!blob || blob.size < 22) {
            alert('下载失败：服务器返回的文件为空，请重启服务后重试');
            return;
        }
        const date = new Date().toISOString().slice(0, 10);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = '货品资料_' + date + '.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        var hitHdr = response.headers.get('X-Huoban-Hit');
        var zipHdr = response.headers.get('X-Zip-File-Count');
        var tip = 'ZIP 已下载（含「下载报告_日期.xlsx」）';
        if (hitHdr != null && zipHdr != null) {
            tip +=
                '：伙伴云命中 ' +
                hitHdr +
                ' 个附件，打包成功 ' +
                zipHdr +
                ' 个；勾选 ' +
                selectedProducts.length +
                ' 个货品';
        }
        showToast(tip, 'success');
    } catch (err) {
        console.error('[资料下载]', err);
        alert('下载失败: ' + (err.message || '网络错误'));
    } finally {
        _productFilesDownloadBusy = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldHtml || '<i class="fas fa-download"></i> 下载资料';
        }
    }
}

/** 导出/导入菜单用：货品 ID（与抛单 goodsid 一致，优先 ERP 货品 ID） */
function getProductExportId(product) {
    if (!product) return '';
    const gid = resolveOrderGoodsid(product);
    if (gid) return gid;
    const erp = String(product.erpGoodsId || '').trim();
    if (erp) return erp;
    // SQLite 自增 id 不是 ERP 货品号，避免与 goodsid 撞号误匹配
    return '';
}

function findProductsByErpGoodsId(goodsId) {
    const g = String(goodsId || '').trim();
    if (!g || !productsData.length) return [];
    return productsData.filter(function (p) {
        if (getProductExportId(p) === g) return true;
        if (String(p.erpGoodsId || '').trim() === g) return true;
        var pid = String(p.id || '');
        if (pid.startsWith('ora:')) {
            var parts = pid.split(':');
            if (parts.length >= 3 && String(parts[2]).trim() === g) return true;
        }
        return false;
    });
}

function pickBestProductForHistoryLine(matches) {
    if (!matches || !matches.length) return null;
    var withOp = matches.filter(function (p) {
        return String(p.operationCode || '').trim();
    });
    var pool = withOp.length ? withOp : matches;
    var oracle = pool.find(function (p) {
        return p.source === 'oracle';
    });
    return oracle || pool[0];
}

function findProductByExportGoodsId(goodsId) {
    return pickBestProductForHistoryLine(findProductsByErpGoodsId(goodsId));
}

function findProductByOperationCode(opCode) {
    const code = String(opCode || '').trim();
    if (!code) return null;
    const lower = code.toLowerCase();
    return (
        productsData.find(function (p) {
            return String(p.operationCode || '')
                .trim()
                .toLowerCase() === lower;
        }) || null
    );
}

/**
 * 导入菜单数量：按货品ID和/或货品操作码匹配（二者都填时须指向同一货品）
 * @returns {{ product: object|null, error: string|null, label: string }}
 */
function resolveProductForMenuImport(goodsId, opCode) {
    const gid = String(goodsId || '').trim();
    const opc = String(opCode || '').trim();
    if (!gid && !opc) {
        return { product: null, error: '缺少货品ID或货品操作码', label: '' };
    }
    const byId = gid ? findProductByExportGoodsId(gid) : null;
    const byOp = opc ? findProductByOperationCode(opc) : null;
    if (byId && byOp && String(byId.id) !== String(byOp.id)) {
        return {
            product: null,
            error: '货品ID与货品操作码不匹配',
            label: gid + ' / ' + opc
        };
    }
    const product = byId || byOp;
    if (!product) {
        return {
            product: null,
            error: '当前客户档案中未找到',
            label: gid || opc
        };
    }
    const label = gid && opc ? gid + '（' + opc + '）' : gid || opc;
    return { product: product, error: null, label: label };
}

function normalizeMenuImportHeader(cell) {
    return String(cell == null ? '' : cell)
        .trim()
        .replace(/\s+/g, '')
        .toLowerCase();
}

/** 解析表头列索引；须含「数量」及「货品ID」或「货品操作码」之一（「货品单位」可选） */
function mapMenuQtyImportColumns(headerRow) {
    if (!headerRow || !headerRow.length) return null;
    const col = { id: -1, opCode: -1, unit: -1, qty: -1 };
    const idNames = ['货品id', 'erp货品id', 'goodsid', '货品编号'];
    const opCodeNames = ['货品操作码', '操作码', 'operationcode', 'opcode'];
    const unitNames = ['货品单位', '单位', 'unit'];
    const qtyNames = ['数量', '下单数量', 'qty', '订购数量'];
    headerRow.forEach(function (cell, idx) {
        const key = normalizeMenuImportHeader(cell);
        if (idNames.indexOf(key) !== -1) col.id = idx;
        if (opCodeNames.indexOf(key) !== -1) col.opCode = idx;
        if (unitNames.indexOf(key) !== -1) col.unit = idx;
        if (qtyNames.indexOf(key) !== -1) col.qty = idx;
    });
    if (col.qty < 0) return null;
    if (col.id < 0 && col.opCode < 0) return null;
    return col;
}

function parseMenuQtyCell(val) {
    if (val === null || val === undefined) return null;
    const s = String(val).trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < ORDER_QTY_MIN || n > ORDER_QTY_MAX) return null;
    return roundOrderQty(n);
}

/** 导出当前列表显示的货品（filteredProducts），数量列留空 */
function exportCurrentMenuToExcel() {
    if (typeof XLSX === 'undefined') {
        showToast('Excel 组件未加载，请刷新页面后重试', 'error');
        return;
    }
    if (!filteredProducts || !filteredProducts.length) {
        showToast('当前没有可导出的货品', 'warning');
        return;
    }
    const rows = filteredProducts.map(function (p) {
        return {
            货品ID: getProductExportId(p),
            货品操作码: String(p.operationCode || '').trim(),
            货品名称: p.name || '',
            规格: p.spec || '',
            品牌: p.brand || '',
            货品单位: p.unit || '件',
            数量: ''
        };
    });
    const ws = XLSX.utils.json_to_sheet(rows, {
        header: ['货品ID', '货品操作码', '货品名称', '规格', '品牌', '货品单位', '数量']
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '菜单');
    const title =
        document.getElementById('sectionTitle') &&
        document.getElementById('sectionTitle').textContent
            ? document.getElementById('sectionTitle').textContent.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 24)
            : '菜单';
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, '菜单_' + title + '_' + date + '.xlsx');
    showToast(
        '已导出 ' + rows.length + ' 条货品，请填写「数量」列后导入（含货品ID、货品操作码）',
        'success'
    );
}

function triggerMenuQtyImport() {
    const input = document.getElementById('menuQtyImportFile');
    if (!input) return;
    input.value = '';
    input.click();
}

function importMenuQtyFromExcel(inputEl) {
    if (!inputEl || !inputEl.files || !inputEl.files[0]) return;
    if (typeof XLSX === 'undefined') {
        showToast('Excel 组件未加载，请刷新页面后重试', 'error');
        return;
    }
    const file = inputEl.files[0];
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) {
                alert('导入失败：Excel 中没有工作表');
                return;
            }
            const sheet = workbook.Sheets[sheetName];
            const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            if (!matrix.length) {
                alert('导入失败：表格为空');
                return;
            }
            const col = mapMenuQtyImportColumns(matrix[0]);
            if (!col) {
                alert(
                    '格式错误：首行须包含列「数量」，以及「货品ID」或「货品操作码」（至少一列）。\n' +
                        '推荐列顺序：货品ID、货品操作码、货品名称、规格、品牌、货品单位、数量。\n' +
                        '请使用「导出菜单」生成的文件，或保证表头名称一致。'
                );
                return;
            }

            const merged = new Map();
            const errors = [];
            for (let r = 1; r < matrix.length; r++) {
                const row = matrix[r];
                if (!row || !row.length) continue;
                const goodsId = col.id >= 0 ? String(row[col.id] != null ? row[col.id] : '').trim() : '';
                const opCode =
                    col.opCode >= 0 ? String(row[col.opCode] != null ? row[col.opCode] : '').trim() : '';
                const qtyRaw = row[col.qty];
                const qty = parseMenuQtyCell(qtyRaw);
                if (!goodsId && !opCode && (qtyRaw === '' || qtyRaw == null)) continue;
                if (!goodsId && !opCode) {
                    errors.push('第 ' + (r + 1) + ' 行：缺少货品ID或货品操作码');
                    continue;
                }
                if (qty == null) {
                    if (String(qtyRaw || '').trim() !== '') {
                        errors.push(
                            '第 ' +
                                (r + 1) +
                                ' 行：数量无效（须 ' +
                                ORDER_QTY_MIN +
                                '～' +
                                ORDER_QTY_MAX +
                                '，最多 2 位小数）'
                        );
                    }
                    continue;
                }
                const resolved = resolveProductForMenuImport(goodsId, opCode);
                if (resolved.error) {
                    errors.push(
                        '第 ' +
                            (r + 1) +
                            ' 行：' +
                            resolved.error +
                            (resolved.label ? '（' + resolved.label + '）' : '')
                    );
                    continue;
                }
                const pid = String(resolved.product.id);
                merged.set(pid, roundOrderQty((merged.get(pid) || 0) + qty));
            }

            if (errors.length) {
                alert('导入失败，请修正后重试：\n\n' + errors.slice(0, 15).join('\n') +
                    (errors.length > 15 ? '\n…共 ' + errors.length + ' 处错误' : ''));
                return;
            }
            if (!merged.size) {
                alert('未导入任何数据：请至少在「数量」列填写 ≥ ' + ORDER_QTY_MIN + ' 的数量（支持小数）');
                return;
            }

            let added = 0;
            let notFound = [];
            merged.forEach(function (qty, productId) {
                const product = productsData.find(function (p) {
                    return String(p.id) === String(productId);
                });
                if (!product) {
                    notFound.push(productId);
                    return;
                }
                const maxQty = getProductMaxOrderQty(product);
                const finalQty = normalizeOrderQuantity(qty, maxQty);
                const existing = cart.find(function (item) {
                    return item.id == product.id;
                });
                if (existing) {
                    existing.quantity = finalQty;
                } else {
                    cart.push(Object.assign({}, product, { quantity: finalQty }));
                }
                added++;
            });
            if (added > 0) {
                saveCart();
                updateCartUI();
            }

            if (notFound.length) {
                alert(
                    '部分货品未加入购物车（当前客户档案中未找到）：\n' +
                        notFound.slice(0, 20).join('\n') +
                        (notFound.length > 20 ? '\n…共 ' + notFound.length + ' 个' : '') +
                        (added ? '\n\n已成功加入 ' + added + ' 种货品到购物车' : '')
                );
            } else {
                showToast('已导入 ' + added + ' 种货品到购物车', 'success');
            }
            if (added > 0) {
                const sidebar = document.getElementById('cartSidebar');
                if (sidebar && !sidebar.classList.contains('show')) {
                    toggleCart();
                }
            }
        } catch (err) {
            console.error('导入菜单数量失败:', err);
            alert('导入失败：' + (err.message || '无法解析 Excel 文件'));
        }
    };
    reader.onerror = function () {
        alert('读取文件失败');
    };
    reader.readAsArrayBuffer(file);
}

// 导出订单
function exportOrder() {
    if (cart.length === 0) {
        showToast('购物车是空的，无法导出');
        return;
    }
    
    const orderData = {
        items: cart,
        total: cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
        date: new Date().toLocaleString('zh-CN')
    };
    
    exportOrderData(orderData);
    showToast('订单已导出');
}

// 导出订单数据
function exportOrderData(orderData) {
    const dataStr = JSON.stringify(orderData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `订单_${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

// 显示提示消息
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    
    toastMessage.textContent = message;
    
    if (type === 'success') {
        toast.style.background = 'var(--secondary-color)';
    } else if (type === 'warning') {
        toast.style.background = 'var(--warning-color)';
    } else {
        toast.style.background = 'var(--danger-color)';
    }
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 5000); // 延长显示时间到5秒
}

// 点击历史订单模态框外部关闭
document.getElementById('orderHistoryModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeOrderHistory();
    }
});

// 保存订单到历史记录（包含详细的接收状态，按当前用户存储）
function saveOrderToHistory(orderData, erpOrderData, responseData) {
    const orderHistory = JSON.parse(localStorage.getItem(getOrderHistoryKey()) || '[]');
    
    // 确定订单状态
    let status = 'error';
    let statusText = '失败';
    
    if (responseData.serverReceived) {
        if (responseData.erpSynced) {
            status = 'success';
            statusText = '成功';
        } else if (responseData.erpError) {
            status = 'warning';
            statusText = '部分成功';
        } else {
            status = 'warning';
            statusText = '待确认';
        }
    } else {
        status = 'error';
        statusText = '未接收';
    }
    
    var snapSupplier = (erpOrderData.orderHistorySnapshot && erpOrderData.orderHistorySnapshot.supplierName) || '';
    var snapSupplierId = (erpOrderData.orderHistorySnapshot && erpOrderData.orderHistorySnapshot.supplierId) || '';
    var liveSupplier = getSupplierForCurrentCustomer();
    const historyItem = {
        id: Date.now(),
        orderNo: erpOrderData.conno,
        date: new Date().toISOString(),
        orderPlacerName: erpOrderData.orderPlacerName || '',
        orderPlacedAt: erpOrderData.orderPlacedAt || new Date().toISOString(),
        customer: orderData.customer,
        items: orderData.items,
        total: orderData.total,
        supplierName: snapSupplier || (liveSupplier && liveSupplier.name) || '',
        supplierId: snapSupplierId || (getOrderErpDefaults() && getOrderErpDefaults().supplierId) || '',
        erpData: erpOrderData,
        // 接收状态信息
        receiveStatus: {
            // 服务器接收状态
            serverReceived: responseData.serverReceived || false,
            httpStatus: responseData.httpStatus || null,
            serverResponse: responseData.serverResponse || null,
            // ERP同步状态
            erpSynced: responseData.erpSynced || false,
            erpResult: responseData.erpResult || null,
            erpError: responseData.erpError || null,
            // 错误信息
            errorType: responseData.errorType || null,
            message: responseData.message || '未知状态',
            // 时间戳
            receivedAt: new Date().toISOString()
        },
        // 兼容旧格式
        response: responseData,
        status: status,
        statusText: statusText
    };
    
    orderHistory.unshift(historyItem); // 添加到开头
    
    // 只保留最近100条订单
    if (orderHistory.length > 100) {
        orderHistory.splice(100);
    }
    
    localStorage.setItem(getOrderHistoryKey(), JSON.stringify(orderHistory));
    invalidateProductHintHistoryCache();
}

function findOrderInHistory(orderId) {
    var found = _displayOrderHistory.find(function (o) {
        return o.id == orderId;
    });
    if (found) return found;
    return getLocalOrderHistoryForDisplay().find(function (o) {
        return o.id == orderId;
    });
}

// 显示历史订单
function showOrderHistory() {
    const modal = document.getElementById('orderHistoryModal');
    modal.style.display = 'flex';
    modal.classList.add('show');
    loadOrderHistory();
}

// 关闭历史订单
function closeOrderHistory() {
    const modal = document.getElementById('orderHistoryModal');
    modal.style.display = 'none';
    modal.classList.remove('show');
}

// 加载历史订单（本机 localStorage 多 key 合并 + 服务端 SQLite）
async function loadOrderHistory() {
    const historyList = document.getElementById('orderHistoryList');
    if (!historyList) return;
    historyList.innerHTML = `
        <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
            <i class="fas fa-spinner fa-spin" style="font-size: 2rem;"></i>
            <p style="margin-top: 1rem;">正在加载历史订单…</p>
        </div>
    `;
    try {
        await ensureProductsCatalogLoaded();
        _displayOrderHistory = await loadAllOrderHistory();
        _orderDetailPageByOrderId = {};
        _erpLineStatusCache = {};
        renderOrderHistoryList(_displayOrderHistory);
        (_displayOrderHistory || []).forEach(function (order) {
            loadErpStatusForOrderDetailPage(order);
        });
    } catch (e) {
        console.error('加载历史订单失败:', e);
        historyList.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: var(--danger-color);">
                <p>加载失败: ${e.message}</p>
            </div>
        `;
    }
}

function renderOrderHistoryList(orderHistory) {
    const historyList = document.getElementById('orderHistoryList');
    if (!historyList) return;

    if (!orderHistory || orderHistory.length === 0) {
        historyList.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                <i class="fas fa-inbox" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;"></i>
                <p>暂无历史订单</p>
                <p style="font-size: 0.85rem; margin-top: 0.5rem;">请确认顶部「当前客户」与下单时一致。</p>
            </div>
        `;
        return;
    }

    historyList.innerHTML = orderHistory.map(order => {
        const date = new Date(order.date);
        const items = Array.isArray(order.items) ? order.items : [];
        const orderTotal = Number(order.total) || 0;

        // 获取接收状态信息（兼容旧格式）
        const receiveStatus = order.receiveStatus || {
            serverReceived: order.response?.success || false,
            erpSynced: order.response?.erpResult ? true : false,
            erpError: order.response?.error || null,
            message: order.response?.message || '未知状态'
        };
        
        // 确定状态显示
        let statusClass, statusText, statusIcon, statusColor;
        if (receiveStatus.serverReceived) {
            if (receiveStatus.erpSynced) {
                statusClass = 'success';
                statusText = '成功';
                statusIcon = 'check-circle';
                statusColor = 'var(--secondary-color)';
            } else if (receiveStatus.erpError) {
                statusClass = 'warning';
                statusText = '部分成功';
                statusIcon = 'exclamation-triangle';
                statusColor = 'var(--warning-color)';
            } else {
                statusClass = 'warning';
                statusText = '待确认';
                statusIcon = 'clock';
                statusColor = 'var(--warning-color)';
            }
        } else {
            statusClass = 'error';
            statusText = '未接收';
            statusIcon = 'times-circle';
            statusColor = 'var(--danger-color)';
        }
        
        return `
            <div class="order-history-item" data-order-id="${order.id}" style="
                padding: 1.5rem; 
                margin-bottom: 1rem; 
                background: var(--bg-secondary); 
                border-radius: var(--radius); 
                border: 1px solid var(--border-color);
            ">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                    <div>
                        <h4 style="margin-bottom: 0.5rem;">
                            <i class="fas fa-file-invoice"></i> 订单编号: ${order.orderNo}
                        </h4>
                        <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.25rem 0;">
                            <i class="fas fa-calendar"></i> ${date.toLocaleString('zh-CN')}
                        </p>
                        ${order.orderPlacerName || order.orderPlacedAt ? `
                        <p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0.25rem 0;">
                            <i class="fas fa-user"></i> 下单人: ${escapeHtml(order.orderPlacerName || '—')}
                            ${order.orderPlacedAt ? `<span style="margin-left: 0.75rem;"><i class="fas fa-clock"></i> 操作时间: ${escapeHtml(new Date(order.orderPlacedAt).toLocaleString('zh-CN'))}</span>` : ''}
                        </p>
                        ` : ''}
                    </div>
                    <div style="text-align: right;">
                        <span class="order-status status-${statusClass}" style="
                            display: inline-block;
                            padding: 0.25rem 0.75rem;
                            border-radius: 20px;
                            font-size: 0.85rem;
                            background: ${statusColor};
                            color: white;
                            margin-bottom: 0.5rem;
                        ">
                            <i class="fas fa-${statusIcon}"></i> ${statusText}
                        </span>
                        <div style="font-size: 1.2rem; font-weight: 700; color: var(--primary-color);">
                            ¥${orderTotal.toFixed(2)}
                        </div>
                    </div>
                </div>
                
                <!-- 接收状态信息 -->
                <div style="margin-bottom: 1rem; padding: 1rem; background: white; border-radius: var(--radius); border-left: 4px solid ${statusColor};">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.9rem;">
                        <div>
                            <strong>服务器接收:</strong> 
                            <span style="color: ${receiveStatus.serverReceived ? 'var(--secondary-color)' : 'var(--danger-color)'};">
                                <i class="fas fa-${receiveStatus.serverReceived ? 'check' : 'times'}"></i> 
                                ${receiveStatus.serverReceived ? '已接收' : '未接收'}
                            </span>
                        </div>
                        <div>
                            <strong>ERP同步:</strong> 
                            <span style="color: ${receiveStatus.erpSynced ? 'var(--secondary-color)' : (receiveStatus.erpError ? 'var(--warning-color)' : 'var(--text-secondary)')};">
                                <i class="fas fa-${receiveStatus.erpSynced ? 'check' : (receiveStatus.erpError ? 'exclamation-triangle' : 'clock')}"></i> 
                                ${receiveStatus.erpSynced ? '已同步' : (receiveStatus.erpError ? '同步失败' : '待确认')}
                            </span>
                        </div>
                        ${receiveStatus.httpStatus ? `
                        <div>
                            <strong>HTTP状态:</strong> <span>${receiveStatus.httpStatus}</span>
                        </div>
                        ` : ''}
                        ${receiveStatus.erpError ? `
                        <div style="grid-column: 1 / -1;">
                            <strong>错误信息:</strong> 
                            <span style="color: var(--danger-color); font-size: 0.85rem;">${receiveStatus.erpError}</span>
                        </div>
                        ` : ''}
                        <div style="grid-column: 1 / -1; font-size: 0.85rem; color: var(--text-secondary);">
                            <strong>状态说明:</strong> ${receiveStatus.message || '未知状态'}
                        </div>
                    </div>
                </div>
                
                <div style="margin-bottom: 1rem; padding: 1rem; background: white; border-radius: var(--radius);">
                    <p style="margin: 0.25rem 0;"><strong>订单客户:</strong> ${order.customer && order.customer.name ? order.customer.name : '—'}</p>
                    ${order.customer && order.customer.notes ? `<p style="margin: 0.25rem 0;"><strong>备注:</strong> ${order.customer.notes}</p>` : ''}
                </div>
                
                <div style="margin-bottom: 1rem;" id="order-detail-wrap-${order.id}">
                    ${buildOrderDetailSectionHtml(order)}
                </div>
                
                <div style="display: flex; gap: 0.5rem;">
                    <button onclick="exportOrderHistory(${order.id})" style="
                        flex: 1;
                        padding: 0.5rem;
                        background: var(--bg-tertiary);
                        border: 1px solid var(--border-color);
                        border-radius: var(--radius);
                        cursor: pointer;
                    ">
                        <i class="fas fa-download"></i> 导出
                    </button>
                    <button onclick="viewOrderDetail(${order.id})" style="
                        flex: 1;
                        padding: 0.5rem;
                        background: var(--primary-color);
                        color: white;
                        border: none;
                        border-radius: var(--radius);
                        cursor: pointer;
                    ">
                        <i class="fas fa-eye"></i> 详情
                    </button>
                    <button onclick="printOrderHistory(${order.id})" style="
                        flex: 1;
                        padding: 0.5rem;
                        background: #0d9488;
                        color: white;
                        border: none;
                        border-radius: var(--radius);
                        cursor: pointer;
                    ">
                        <i class="fas fa-print"></i> 打印
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// 筛选历史订单
function filterOrderHistory() {
    const searchTerm = document.getElementById('orderSearchInput').value.toLowerCase().trim();
    if (!searchTerm) {
        renderOrderHistoryList(_displayOrderHistory);
        (_displayOrderHistory || []).forEach(function (order) {
            loadErpStatusForOrderDetailPage(order);
        });
        return;
    }
    const filtered = _displayOrderHistory.filter(function (order) {
        return (
            (order.orderNo && order.orderNo.toLowerCase().includes(searchTerm)) ||
            (order.customer && order.customer.name && order.customer.name.toLowerCase().includes(searchTerm)) ||
            (order.customer && order.customer.notes && order.customer.notes.toLowerCase().includes(searchTerm))
        );
    });
    if (filtered.length === 0) {
        const historyList = document.getElementById('orderHistoryList');
        if (historyList) {
            historyList.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-secondary)"><i class="fas fa-search" style="font-size:3rem;margin-bottom:1rem;opacity:.5"></i><p>未找到匹配的订单</p></div>';
        }
        return;
    }
    renderOrderHistoryList(filtered);
    filtered.forEach(function (order) {
        loadErpStatusForOrderDetailPage(order);
    });
}

// 导出单个订单
function exportOrderHistory(orderId) {
    const order = findOrderInHistory(orderId);
    if (!order) {
        showToast('订单不存在', 'error');
        return;
    }
    if (typeof XLSX === 'undefined') {
        showToast('Excel 组件未加载，请刷新页面后重试', 'error');
        return;
    }
    exportOrderAsXlsx(order);
    showToast('订单已导出为 Excel', 'success');
}

function exportOrderAsXlsx(order) {
    var items = getOrderItemsForPrint(order);
    var totalQty = 0;
    var totalAmount = 0;
    var orderDate = formatOrderPrintDate(order);
    var orderNo = order.orderNo || '—';
    var customerName = (order.customer && order.customer.name) || '—';
    var supplierName = resolveOrderSupplierName(order);
    var notes = resolveOrderNotes(order);

    var detailRows = items.map(function (item, idx) {
        var qty = roundOrderQty(item.quantity) || 0;
        var price = Number(item.price) || 0;
        var lineAmt = price * qty;
        var unit = resolveOrderItemUnit(item);
        totalQty += qty;
        totalAmount += lineAmt;
        var opCode = resolveOrderItemOperationCode(item, order, idx) || '—';
        return [idx + 1, opCode, item.name || '—', item.spec || '—', price, unit, qty, lineAmt];
    });

    var upper = amountToRmbUppercase(totalAmount);

    // ── 构建 AOA（行数组）──
    var aoa = [];
    aoa.push(['采购订单']);                                               // R1 标题
    aoa.push([]);
    aoa.push(['订单日期：', orderDate,     '', '订单号：',       orderNo]);
    aoa.push(['客户名称：', customerName,  '', '供应商名称：',   supplierName]);
    aoa.push(['订单总数量：', totalQty,    '', '订单总金额(小写)：', '¥' + totalAmount.toFixed(2)]);
    aoa.push(['总金额(大写)：' + upper]);
    aoa.push(['订单备注：' + notes]);
    aoa.push([]);
    // 表头
    aoa.push(['序号', '货品操作码', '货品名称', '货品规格', '货品价格', '单位', '数量', '金额']);
    // 明细
    detailRows.forEach(function (r) { aoa.push(r); });
    // 合计行
    aoa.push(['', '', '', '', '', '合计', totalQty, '¥' + totalAmount.toFixed(2)]);
    aoa.push([]);
    aoa.push(['导出时间：', new Date().toLocaleString('zh-CN', { hour12: false })]);

    var ws = XLSX.utils.aoa_to_sheet(aoa);

    // 合并标题单元格 A1:H1
    ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },  // 标题
        { s: { r: 5, c: 0 }, e: { r: 5, c: 7 } },  // 大写金额整行
        { s: { r: 6, c: 0 }, e: { r: 6, c: 7 } },  // 备注整行
    ];

    // 列宽
    ws['!cols'] = [
        { wch: 10 },  // 序号
        { wch: 14 },  // 货品操作码（原 16，减 10%）
        { wch: 20 },  // 货品名称（再减 10%）
        { wch: 30 },  // 货品规格（承接名称让出的宽度）
        { wch: 12 },  // 货品价格
        { wch: 8  },  // 单位
        { wch: 10 },  // 数量
        { wch: 14 },  // 金额
    ];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '采购订单');

    var safeNo = String(orderNo).replace(/[\\/:*?"<>|]/g, '_');
    XLSX.writeFile(wb, '采购订单_' + safeNo + '_' + orderDate + '.xlsx');
}

/** 金额转人民币大写（用于打印） */
function amountToRmbUppercase(amount) {
    var n = Math.round(Number(amount) * 100) / 100;
    if (!isFinite(n)) return '—';
    if (n === 0) return '零元整';
    var fraction = ['角', '分'];
    var digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
    var unit = [
        ['元', '万', '亿'],
        ['', '拾', '佰', '仟']
    ];
    var head = n < 0 ? '负' : '';
    n = Math.abs(n);
    var fenDigit = Math.round(n * 100) % 10;
    var s = '';
    for (var i = 0; i < fraction.length; i++) {
        var f = Math.floor(n * 10 * Math.pow(10, i)) % 10;
        s += (f ? digit[f] + fraction[i] : '');
    }
    s = s || '整';
    n = Math.floor(n);
    for (var u = 0; u < unit[0].length && n > 0; u++) {
        var p = '';
        for (var j = 0; j < unit[1].length && n > 0; j++) {
            p = digit[n % 10] + unit[1][j] + p;
            n = Math.floor(n / 10);
        }
        s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][u] + s;
    }
    var result = head + s
        .replace(/(零.)*零元/, '元')
        .replace(/(零.)+/g, '零')
        .replace(/^整$/, '零元整')
        .replace(/元整$/, '元整');
    if (fenDigit === 0 && !/整$/.test(result)) {
        result += '整';
    }
    return result;
}

function resolveOrderSupplierName(order) {
    if (!order) return '—';
    if (order.supplierName) return String(order.supplierName).trim();
    var snap = order.erpData && order.erpData.orderHistorySnapshot;
    if (snap && snap.supplierName) return String(snap.supplierName).trim();
    var user = getStoredUser();
    if (user && user.supplier && user.supplier.name) return String(user.supplier.name).trim();
    var entry = order.erpData && order.erpData.entryid;
    if (entry) return '供应商ID: ' + entry;
    return '—';
}

function resolveOrderNotes(order) {
    if (!order) return '—';
    if (order.customer && order.customer.notes) return String(order.customer.notes).trim();
    if (order.erpData && order.erpData.memo) return String(order.erpData.memo).trim();
    return '—';
}

/** 打印用订单日期（仅日期，不含时分秒） */
function formatOrderPrintDate(order) {
    var raw = order.orderPlacedAt || order.date;
    if (!raw) return '—';
    try {
        var d = new Date(raw);
        if (isNaN(d.getTime())) {
            var s = String(raw).trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
            return s;
        }
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    } catch (e) {
        return String(raw);
    }
}

function resolveOrderItemUnit(item) {
    if (item && item.unit != null && String(item.unit).trim()) {
        return String(item.unit).trim();
    }
    var p = findProductForOrderHistoryItem(item, null, -1);
    if (p && p.unit) return String(p.unit).trim();
    return '件';
}

/** 历史订单明细行匹配当前可见货品档案（与下单页列表同源 productsData） */
function findProductForOrderHistoryItem(item, order, lineIndex) {
    if (!item || !productsData || !productsData.length) return null;
    var gid = resolveOrderLineGoodsid(item, order, lineIndex);
    if (gid) {
        var byErp = findProductByExportGoodsId(gid);
        if (byErp) return byErp;
    }
    var byKey = productsData.find(function (x) {
        return orderItemMatchesProduct(x.id, item);
    });
    if (byKey) return byKey;
    var name = String(item.name || '').trim();
    var spec = String(item.spec || '').trim();
    if (name) {
        var candidates = productsData.filter(function (x) {
            return (
                String(x.name || '').trim() === name &&
                (!spec || String(x.spec || '').trim() === spec)
            );
        });
        if (candidates.length === 1) return candidates[0];
    }
    return null;
}

/**
 * 历史订单操作码：仅来自当前可见货品菜单 productsData（按 ERP 货品 ID 匹配），不用订单快照
 */
function resolveOrderItemOperationCode(item, order, lineIndex) {
    if (!productsData || !productsData.length) return '';
    var p = findProductForOrderHistoryItem(item, order, lineIndex);
    if (p && String(p.operationCode || '').trim()) {
        return String(p.operationCode).trim();
    }
    var gid = resolveOrderLineGoodsid(item, order, lineIndex);
    if (gid) {
        var best = pickBestProductForHistoryLine(findProductsByErpGoodsId(gid));
        if (best && String(best.operationCode || '').trim()) {
            return String(best.operationCode).trim();
        }
    }
    return '';
}

/** 打印/导出取订单明细（合并快照中的名称/规格等；操作码不取自快照，由可见菜单解析） */
function getOrderItemsForPrint(order) {
    var items = Array.isArray(order.items) ? order.items.slice() : [];
    var snapItems =
        order.erpData &&
        order.erpData.orderHistorySnapshot &&
        Array.isArray(order.erpData.orderHistorySnapshot.items)
            ? order.erpData.orderHistorySnapshot.items
            : null;
    var detailList =
        order.erpData && Array.isArray(order.erpData.detailList) ? order.erpData.detailList : null;
    if (!snapItems || !snapItems.length) {
        if (!detailList) return items;
        return items.map(function (item, idx) {
            var d = detailList[idx];
            if (!d || d.goodsid == null) return item;
            var gid = String(d.goodsid).trim();
            return Object.assign({}, item, { erpGoodsId: gid });
        });
    }
    return items.map(function (item, idx) {
        var snap = snapItems[idx];
        var d = detailList && detailList[idx];
        var gidFromErp = d && d.goodsid != null ? String(d.goodsid).trim() : '';
        if (!snap) {
            if (!gidFromErp) return item;
            return Object.assign({}, item, { erpGoodsId: gidFromErp });
        }
        return Object.assign({}, snap, item, {
            id: item.id != null ? item.id : snap.id,
            erpGoodsId: String(gidFromErp || item.erpGoodsId || snap.erpGoodsId || '').trim(),
            name: item.name || snap.name,
            spec: item.spec != null ? item.spec : snap.spec,
            unit: item.unit || snap.unit,
            price: item.price != null ? item.price : snap.price,
            quantity: item.quantity != null ? item.quantity : snap.quantity
        });
    });
}

function buildOrderPrintHtml(order) {
    var items = getOrderItemsForPrint(order);
    var totalQty = 0;
    var totalAmount = Number(order.total) || 0;
    var rowsHtml = '';
    items.forEach(function (item, idx) {
        var qty = roundOrderQty(item.quantity) || 0;
        var price = Number(item.price) || 0;
        var lineAmt = price * qty;
        var unit = resolveOrderItemUnit(item);
        totalQty += qty;
        var opCode = resolveOrderItemOperationCode(item, order, idx) || '—';
        rowsHtml +=
            '<tr>' +
            '<td class="c">' +
            (idx + 1) +
            '</td>' +
            '<td class="c col-op">' +
            escapeHtml(opCode) +
            '</td>' +
            '<td class="col-name">' +
            escapeHtml(item.name || '—') +
            '</td>' +
            '<td class="col-spec">' +
            escapeHtml(item.spec || '—') +
            '</td>' +
            '<td class="r">¥' +
            price.toFixed(2) +
            '</td>' +
            '<td class="c">' +
            escapeHtml(unit) +
            '</td>' +
            '<td class="c">' +
            qty +
            '</td>' +
            '<td class="r">¥' +
            lineAmt.toFixed(2) +
            '</td>' +
            '</tr>';
    });
    if (!items.length) {
        rowsHtml = '<tr><td colspan="8" class="c">无明细</td></tr>';
    } else {
        totalAmount = items.reduce(function (s, it) {
            return s + (Number(it.price) || 0) * (roundOrderQty(it.quantity) || 0);
        }, 0);
    }
    var logoUrl = (window.location.origin || '') + '/logo.png';
    var upper = amountToRmbUppercase(totalAmount);
  return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>订单打印-' +
        escapeHtml(order.orderNo || '') +
        '</title><style>' +
        '@page{size:A4;margin:12mm 14mm;}' +
        'body{font-family:"Microsoft YaHei","SimSun",sans-serif;font-size:12px;color:#111;margin:0;padding:0;}' +
        '.wrap{max-width:210mm;margin:0 auto;}' +
        '.head{position:relative;display:flex;align-items:center;justify-content:center;min-height:56px;margin-bottom:14px;border-bottom:2px solid #1e3a5f;padding-bottom:12px;}' +
        '.logo-box{position:absolute;left:0;top:0;}' +
        '.logo-box img{display:block;height:56px;width:auto;max-width:220px;object-fit:contain;}' +
        '.doc-title{margin:0;font-size:22px;font-weight:700;color:#1e3a5f;text-align:center;width:100%;}' +
        '.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:12px;line-height:1.55;}' +
        '.meta .lbl{color:#555;}' +
        '.meta .val{font-weight:600;}' +
        '.meta .full{grid-column:1/-1;}' +
        'table.order-print-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;table-layout:fixed;}' +
        'table.order-print-table th,table.order-print-table td{border:1px solid #333;box-sizing:border-box;vertical-align:middle;}' +
        'table.order-print-table thead th{height:28px;line-height:1.2;padding:3px 5px;background:#eef2f7;font-weight:600;text-align:center;white-space:nowrap;}' +
        'table.order-print-table tbody td{line-height:1.25;padding:2px 5px;white-space:normal;word-break:break-all;overflow:visible;}' +
        'table.order-print-table tfoot td{padding:2px 5px;}' +
        'th.col-name,td.col-name{width:197px;min-width:197px;max-width:197px;}' +
        'th.col-op,td.col-op{width:79px;min-width:79px;max-width:79px;}' +
        'th.col-spec,td.col-spec{min-width:87px;}' +
        'td.r{text-align:right;}' +
        'td.c{text-align:center;}' +
        'tfoot td{font-weight:700;background:#f8fafc;}' +
        '.foot{margin-top:16px;font-size:11px;color:#444;}' +
        '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
        '</style></head><body><div class="wrap">' +
        '<div class="head"><div class="logo-box"><img src="' +
        logoUrl +
        '" alt="logo"></div>' +
        '<h1 class="doc-title">采购订单</h1></div>' +
        '<div class="meta">' +
        '<div><span class="lbl">订单日期：</span><span class="val">' +
        escapeHtml(formatOrderPrintDate(order)) +
        '</span></div>' +
        '<div><span class="lbl">订单号：</span><span class="val">' +
        escapeHtml(order.orderNo || '—') +
        '</span></div>' +
        '<div><span class="lbl">客户名称：</span><span class="val">' +
        escapeHtml((order.customer && order.customer.name) || '—') +
        '</span></div>' +
        '<div><span class="lbl">供应商名称：</span><span class="val">' +
        escapeHtml(resolveOrderSupplierName(order)) +
        '</span></div>' +
        '<div><span class="lbl">订单总数量：</span><span class="val">' +
        totalQty +
        '</span></div>' +
        '<div><span class="lbl">订单总金额(小写)：</span><span class="val">¥' +
        totalAmount.toFixed(2) +
        '</span></div>' +
        '<div class="full"><span class="lbl">总金额(大写)：</span><span class="val">' +
        escapeHtml(upper) +
        '</span></div>' +
        '<div class="full"><span class="lbl">订单备注：</span><span class="val">' +
        escapeHtml(resolveOrderNotes(order)) +
        '</span></div>' +
        '</div>' +
        '<table class="order-print-table"><thead><tr>' +
        '<th style="width:37px">序号</th>' +
        '<th class="col-op">货品操作码</th>' +
        '<th class="col-name">货品名称</th><th class="col-spec">货品规格</th><th style="width:71px">货品价格</th>' +
        '<th style="width:49px">单位</th>' +
        '<th style="width:44px">数量</th><th style="width:72px">金额</th>' +
        '</tr></thead><tbody>' +
        rowsHtml +
        '</tbody><tfoot><tr>' +
        '<td colspan="6" class="r">合计</td>' +
        '<td class="c">' +
        totalQty +
        '</td>' +
        '<td class="r">¥' +
        totalAmount.toFixed(2) +
        '</td></tr></tfoot></table>' +
        '<div class="foot"><p>打印时间：' +
        escapeHtml(new Date().toLocaleString('zh-CN', { hour12: false })) +
        '</p></div></div></body></html>'
    );
}

/** 打印表：按 tbody 内自然最高的那一行，统一所有数据行高度（不截断，允许换行） */
function syncOrderPrintTableRowHeights(doc) {
    if (!doc) return;
    var tbody = doc.querySelector('table.order-print-table tbody');
    if (!tbody) return;
    var rows = tbody.querySelectorAll('tr');
    if (!rows.length) return;

    rows.forEach(function (tr) {
        tr.style.height = 'auto';
        tr.querySelectorAll('td').forEach(function (td) {
            td.style.height = 'auto';
            td.style.minHeight = '';
        });
    });

    var maxH = 0;
    rows.forEach(function (tr) {
        var h = tr.getBoundingClientRect().height;
        if (h > maxH) maxH = h;
    });
    if (maxH < 24) maxH = 24;

    var hpx = Math.ceil(maxH) + 'px';
    rows.forEach(function (tr) {
        tr.style.height = hpx;
        tr.querySelectorAll('td').forEach(function (td) {
            td.style.height = hpx;
            td.style.minHeight = hpx;
        });
    });
}

function printOrderHistory(orderId) {
    var order = findOrderInHistory(orderId);
    if (!order) {
        showToast('订单不存在', 'error');
        return;
    }
    var html = buildOrderPrintHtml(order);
    var win = window.open('', '_blank');
    if (!win) {
        alert('无法打开打印窗口，请允许浏览器弹出窗口后重试');
        return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    function doPrint() {
        try {
            syncOrderPrintTableRowHeights(win.document);
            win.print();
        } catch (e) {
            console.warn('print failed', e);
        }
    }
    function schedulePrint() {
        syncOrderPrintTableRowHeights(win.document);
        setTimeout(function () {
            syncOrderPrintTableRowHeights(win.document);
            doPrint();
        }, 80);
    }
    var img = win.document.querySelector('.logo-box img');
    if (img && !img.complete) {
        img.onload = function () {
            setTimeout(schedulePrint, 200);
        };
        img.onerror = function () {
            setTimeout(schedulePrint, 200);
        };
        setTimeout(schedulePrint, 1500);
    } else {
        setTimeout(schedulePrint, 400);
    }
}

// 查看订单详情
function viewOrderDetail(orderId) {
    const order = findOrderInHistory(orderId);
    if (!order) {
        showToast('订单不存在', 'error');
        return;
    }
    const items = Array.isArray(order.items) ? order.items : [];
    const total = Number(order.total) || 0;
    const statusLabel =
        order.status === 'success' ? '成功' : order.status === 'error' ? '失败' : '待确认';
    const detail = `
订单编号: ${order.orderNo}
下单时间: ${new Date(order.date).toLocaleString('zh-CN')}
订单状态: ${statusLabel}

订单客户: ${order.customer && order.customer.name ? order.customer.name : '—'}
  备注: ${order.customer && order.customer.notes ? order.customer.notes : '无'}

订单明细:
${items
    .map(
        (item, index) =>
            `  ${index + 1}. ${item.name || '货品'} (${item.spec || ''})
     数量: ${item.quantity} × ¥${Number(item.price || 0).toFixed(2)} = ¥${(Number(item.price || 0) * item.quantity).toFixed(2)}`
    )
    .join('\n')}

订单总额: ¥${total.toFixed(2)}

ERP数据:
${order.erpData ? JSON.stringify(order.erpData, null, 2) : '(无)'}

服务器响应:
${order.response ? JSON.stringify(order.response, null, 2) : order.receiveStatus ? JSON.stringify(order.receiveStatus, null, 2) : '(无)'}
    `;
    alert(detail);
}

// ==================== 显示设置功能 ====================

let allProductsForSettings = []; // 存储所有货品（包括被屏蔽的）
let categoryOrderList = []; // 存储分类顺序列表

// 显示设置模态框
function showSettings() {
    const modal = document.getElementById('settingsModal');
    modal.style.display = 'flex';
    // 默认显示货品屏蔽管理标签页
    switchSettingsTab('products');
}

// 关闭设置模态框
function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

// 切换设置标签页
function switchSettingsTab(tab) {
    // 隐藏所有标签页内容
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.style.display = 'none';
    });
    // 移除所有标签的active类
    document.querySelectorAll('.settings-tab').forEach(t => {
        t.classList.remove('active');
    });
    
    // 显示选中的标签页
    if (tab === 'products') {
        document.getElementById('settings-tab-products').style.display = 'block';
        document.getElementById('tab-products').classList.add('active');
        loadProductsForSettings();
    } else if (tab === 'categories') {
        document.getElementById('settings-tab-categories').style.display = 'block';
        document.getElementById('tab-categories').classList.add('active');
        loadCategoryOrderForSettings();
    }
}

// 加载所有货品（用于设置界面，包括被屏蔽的）
async function loadProductsForSettings() {
    const container = document.getElementById('productsListInSettings');
    container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    
    try {
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        // 获取所有货品，包括被屏蔽的（使用includeHidden参数）
        const response = await fetch(`${API_CONFIG.baseUrl}/api/products?customerId=${encodeURIComponent(customerId)}&includeHidden=true`);
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.success) {
            allProductsForSettings = result.data || [];
            renderProductsInSettings();
        } else {
            throw new Error(result.message || '加载货品数据失败');
        }
    } catch (error) {
        console.error('加载货品数据失败:', error);
        container.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--danger-color);">
                <i class="fas fa-exclamation-triangle"></i>
                <p>加载失败: ${error.message}</p>
            </div>
        `;
    }
}

// 渲染货品列表（设置界面）
function renderProductsInSettings(filtered = null) {
    const container = document.getElementById('productsListInSettings');
    const productsToShow = filtered || allProductsForSettings;
    
    if (productsToShow.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">没有找到货品</div>';
        return;
    }
    
    container.innerHTML = productsToShow.map(product => {
        const isHidden = product.hideInMenu === true;
        return `
            <div class="product-item-setting ${isHidden ? 'hidden' : ''}" data-product-id="${product.id}">
                <input type="checkbox" id="product-${product.id}" ${isHidden ? '' : 'checked'} 
                       onchange="toggleProductVisibility(${product.id}, this.checked)">
                <div class="product-item-info">
                    <div class="product-item-name">${product.name}</div>
                    <div class="product-item-meta">
                        ${product.category ? `<span><i class="fas fa-tag"></i> ${product.category}</span>` : ''}
                        ${product.manufacturer ? `<span><i class="fas fa-industry"></i> ${product.manufacturer}</span>` : ''}
                        ${product.spec ? `<span><i class="fas fa-info-circle"></i> ${product.spec}</span>` : ''}
                    </div>
                </div>
                <div class="product-item-status ${isHidden ? 'hidden' : 'visible'}">
                    ${isHidden ? '<i class="fas fa-eye-slash"></i> 已屏蔽' : '<i class="fas fa-eye"></i> 显示中'}
                </div>
            </div>
        `;
    }).join('');
}

// 筛选货品（设置界面）
function filterProductsInSettings() {
    const searchTerm = document.getElementById('productSearchInput').value.toLowerCase().trim();
    if (!searchTerm) {
        renderProductsInSettings();
        return;
    }
    
    const filtered = allProductsForSettings.filter(p => 
        p.name.toLowerCase().includes(searchTerm) ||
        (p.category && p.category.toLowerCase().includes(searchTerm)) ||
        (p.manufacturer && p.manufacturer.toLowerCase().includes(searchTerm)) ||
        (p.spec && p.spec.toLowerCase().includes(searchTerm))
    );
    renderProductsInSettings(filtered);
}

// 切换单个货品的显示/屏蔽状态
async function toggleProductVisibility(productId, isVisible) {
    try {
        const response = await fetch(`${API_CONFIG.baseUrl}/api/products/${productId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({
                hideInMenu: !isVisible
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.success) {
            // 更新本地数据
            const product = allProductsForSettings.find(p => p.id === productId);
            if (product) {
                product.hideInMenu = !isVisible;
            }
            // 重新渲染
            renderProductsInSettings();
            showToast(isVisible ? '货品已显示' : '货品已屏蔽', isVisible ? 'success' : 'warning');
            // 刷新主页面产品列表
            setTimeout(() => {
                loadProducts();
            }, 500);
        } else {
            throw new Error(result.message || '更新失败');
        }
    } catch (error) {
        console.error('更新货品状态失败:', error);
        showToast('更新失败: ' + error.message, 'error');
        // 恢复复选框状态
        const checkbox = document.getElementById(`product-${productId}`);
        if (checkbox) {
            checkbox.checked = !checkbox.checked;
        }
    }
}

// 全选货品
function selectAllProducts() {
    const checkboxes = document.querySelectorAll('#productsListInSettings input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
}

// 取消全选货品
function deselectAllProducts() {
    const checkboxes = document.querySelectorAll('#productsListInSettings input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
}

// 屏蔽选中的货品
async function hideSelectedProducts() {
    const checkboxes = document.querySelectorAll('#productsListInSettings input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
        showToast('请先选择要屏蔽的货品', 'warning');
        return;
    }
    
    const productIds = Array.from(checkboxes).map(cb => parseInt(cb.id.replace('product-', '')));
    await batchUpdateProductVisibility(productIds, true);
}

// 显示选中的货品
async function showSelectedProducts() {
    const checkboxes = document.querySelectorAll('#productsListInSettings input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
        showToast('请先选择要显示的货品', 'warning');
        return;
    }
    
    const productIds = Array.from(checkboxes).map(cb => parseInt(cb.id.replace('product-', '')));
    await batchUpdateProductVisibility(productIds, false);
}

// 批量更新货品显示状态
async function batchUpdateProductVisibility(productIds, hide) {
    try {
        showToast(`正在${hide ? '屏蔽' : '显示'} ${productIds.length} 个货品...`, 'info');
        
        const promises = productIds.map(id => 
            fetch(`${API_CONFIG.baseUrl}/api/products/${id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify({
                    hideInMenu: hide
                })
            }).then(res => res.json())
        );
        
        const results = await Promise.all(promises);
        const successCount = results.filter(r => r.success).length;
        
        if (successCount === productIds.length) {
            showToast(`成功${hide ? '屏蔽' : '显示'} ${successCount} 个货品`, 'success');
            // 重新加载数据
            await loadProductsForSettings();
            // 刷新主页面产品列表
            setTimeout(() => {
                loadProducts();
            }, 500);
        } else {
            showToast(`部分成功：${successCount}/${productIds.length}`, 'warning');
        }
    } catch (error) {
        console.error('批量更新失败:', error);
        showToast('批量更新失败: ' + error.message, 'error');
    }
}

// 加载分类顺序（设置界面，按当前客户）
async function loadCategoryOrderForSettings() {
    const container = document.getElementById('categoryOrderList');
    container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    
    // 更新当前客户名称显示
    const customerNameEl = document.getElementById('currentCustomerNameInSettings');
    if (customerNameEl) {
        const user = getStoredUser();
        const customer = getCurrentCustomer();
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        if (customer && customer.name) {
            customerNameEl.textContent = customer.name + ` (ID: ${customerId})`;
        } else {
            customerNameEl.textContent = `客户ID: ${customerId}`;
        }
    }
    
    try {
        // 获取当前客户的分类顺序
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        const orderResponse = await fetch(`${API_CONFIG.baseUrl}/api/category-order?customerId=${encodeURIComponent(customerId)}`);
        if (!orderResponse.ok) {
            throw new Error(`HTTP错误! 状态: ${orderResponse.status}`);
        }
        const order = await orderResponse.json();
        categoryOrderList = Array.isArray(order) ? order : [];
        
        // 获取所有分类（从产品数据中提取，使用当前客户ID）
        const productsResponse = await fetch(`${API_CONFIG.baseUrl}/api/products?customerId=${encodeURIComponent(customerId)}`);
        if (!productsResponse.ok) {
            throw new Error(`HTTP错误! 状态: ${productsResponse.status}`);
        }
        const productsResult = await productsResponse.json();
        const products = productsResult.success ? (productsResult.data || []) : [];
        
        // 提取所有分类路径
        const allCategories = new Set();
        products.forEach(p => {
            if (p.category) {
                allCategories.add(p.category);
                if (p.manufacturer && String(p.manufacturer).trim()) {
                    allCategories.add(p.category + ' > ' + String(p.manufacturer).trim());
                }
            }
        });
        
        // 构建分类树并获取所有路径
        const categoryTree = buildCategoryTree(Array.from(allCategories));
        const allPaths = [];
        buildCategoryPathList(categoryTree, allPaths);
        
        // 合并：已排序的 + 未排序的（按拼音）
        const orderedSet = new Set(categoryOrderList);
        const unordered = allPaths.filter(p => !orderedSet.has(p)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        categoryOrderList = [...categoryOrderList, ...unordered];
        
        renderCategoryOrderList();
    } catch (error) {
        console.error('加载分类顺序失败:', error);
        container.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--danger-color);">
                <i class="fas fa-exclamation-triangle"></i>
                <p>加载失败: ${error.message}</p>
            </div>
        `;
    }
}

// 渲染分类顺序列表
function renderCategoryOrderList() {
    const container = document.getElementById('categoryOrderList');
    
    if (categoryOrderList.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">没有分类</div>';
        return;
    }
    
    container.innerHTML = categoryOrderList.map((category, index) => `
        <div class="category-order-item" data-index="${index}" draggable="true">
            <i class="fas fa-grip-vertical category-order-handle"></i>
            <div class="category-order-name">${category}</div>
            <div class="category-order-actions">
                ${index > 0 ? `<button class="category-order-btn" onclick="moveCategoryUp(${index})" title="上移"><i class="fas fa-arrow-up"></i></button>` : ''}
                ${index < categoryOrderList.length - 1 ? `<button class="category-order-btn" onclick="moveCategoryDown(${index})" title="下移"><i class="fas fa-arrow-down"></i></button>` : ''}
                <button class="category-order-btn" onclick="removeCategoryFromOrder(${index})" title="移除" style="color: var(--danger-color);"><i class="fas fa-times"></i></button>
            </div>
        </div>
    `).join('');
    
    // 添加拖拽功能
    initCategoryDragAndDrop();
}

// 初始化分类拖拽排序
function initCategoryDragAndDrop() {
    const container = document.getElementById('categoryOrderList');
    if (!container) return;
    
    let draggedElement = null;
    
    // 使用事件委托
    container.addEventListener('dragstart', (e) => {
        if (e.target.closest('.category-order-item')) {
            draggedElement = e.target.closest('.category-order-item');
            draggedElement.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedElement.dataset.index);
        }
    });
    
    container.addEventListener('dragend', (e) => {
        if (draggedElement) {
            draggedElement.classList.remove('dragging');
            draggedElement = null;
        }
    });
    
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        
        if (!draggedElement) return;
        
        const afterElement = getDragAfterElement(container, e.clientY);
        if (afterElement == null) {
            container.appendChild(draggedElement);
        } else {
            container.insertBefore(draggedElement, afterElement);
        }
    });
    
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        if (draggedElement) {
            updateCategoryOrderFromDOM();
        }
    });
}

// 获取拖拽后的元素位置
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.category-order-item:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// 从DOM更新分类顺序
function updateCategoryOrderFromDOM() {
    const items = document.querySelectorAll('.category-order-item');
    const newOrder = [];
    items.forEach(item => {
        const categoryName = item.querySelector('.category-order-name').textContent.trim();
        if (categoryName) {
            newOrder.push(categoryName);
        }
    });
    categoryOrderList = newOrder;
    renderCategoryOrderList();
}

// 上移分类
function moveCategoryUp(index) {
    if (index <= 0) return;
    [categoryOrderList[index], categoryOrderList[index - 1]] = [categoryOrderList[index - 1], categoryOrderList[index]];
    renderCategoryOrderList();
}

// 下移分类
function moveCategoryDown(index) {
    if (index >= categoryOrderList.length - 1) return;
    [categoryOrderList[index], categoryOrderList[index + 1]] = [categoryOrderList[index + 1], categoryOrderList[index]];
    renderCategoryOrderList();
}

// 从顺序中移除分类
function removeCategoryFromOrder(index) {
    if (confirm('确定要从显示顺序中移除这个分类吗？移除后它将排在最后。')) {
        categoryOrderList.splice(index, 1);
        renderCategoryOrderList();
    }
}

// 保存分类顺序（按当前客户）
async function saveCategoryOrder() {
    try {
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        const response = await fetch(`${API_CONFIG.baseUrl}/api/category-order?customerId=${encodeURIComponent(customerId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(categoryOrderList)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.success !== false) {
            showToast('分类顺序保存成功', 'success');
            // 刷新主页面分类列表
            setTimeout(() => {
                loadProducts();
            }, 500);
        } else {
            throw new Error(result.message || '保存失败');
        }
    } catch (error) {
        console.error('保存分类顺序失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

// 重置分类顺序（按当前客户）
async function resetCategoryOrder() {
    const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
    const user = getStoredUser();
    const customer = getCurrentCustomer();
    const customerName = (customer && customer.name) ? customer.name : `客户ID: ${customerId}`;
    
    if (!confirm(`确定要重置当前客户（${customerName}）的分类顺序吗？这将清除该客户的所有自定义顺序。`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_CONFIG.baseUrl}/api/category-order?customerId=${encodeURIComponent(customerId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify([])
        });
        
        if (!response.ok) {
            throw new Error(`HTTP错误! 状态: ${response.status}`);
        }
        
        showToast('分类顺序已重置', 'success');
        // 重新加载
        await loadCategoryOrderForSettings();
        // 刷新主页面分类列表
        setTimeout(() => {
            loadProducts();
        }, 500);
    } catch (error) {
        console.error('重置分类顺序失败:', error);
        showToast('重置失败: ' + error.message, 'error');
    }
}

// 点击设置模态框外部关闭
document.getElementById('settingsModal')?.addEventListener('click', function(e) {
    if (e.target === this) {
        closeSettings();
    }
});
