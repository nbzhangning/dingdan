/**
 * server.js — 应用主入口，原生 http 模块实现（无 Express）
 *
 * 职责：
 *   1. 监听 3330 端口，统一处理所有 HTTP 请求
 *   2. 路由分发：按路径前缀派发到各子模块处理函数
 *   3. 鉴权：所有 /api/* 接口进入 enforceApiAuth，校验 Bearer Token 与 customerId 归属
 *   4. 静态文件：直接读取磁盘文件返回，staticFileGuard 拦截 .env 等敏感路径
 *   5. 订单接收：POST /receive_data 保存订单到 SQLite 并转发到目标 ERP
 *
 * 关键约定：
 *   - SQLite 单进程写，不可使用 cluster/多实例（ecosystem.config.js 已固定 instances:1）
 *   - Token 存内存，服务重启后所有已登录用户需重新登录
 *   - targetUrl 是内网 ERP 转发地址，断网时订单仍落库，不影响本地功能
 */
require('./oracleConfig');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleProductsAPI, handleCategoriesAPI } = require('./productManager');
const { handleLogin: handleAuthLogin, logSecurityConfigOnStartup } = require('./auth');
const { enforceApiAuth, assertCustomerAccess, verifyApiSession, canAccessCustomerId } = require('./apiAuth');
const { isBlockedStaticRequest } = require('./staticFileGuard');
const {
    handleChangePassword,
    handleAdminListUsers,
    handleAdminCreateUser,
    handleAdminUpdateUser,
    handleAdminSearchOrders,
    handleAdminSearchOrdersNoRecord,
    handleAdminDeleteOrders
} = require('./userAdmin');
const {
    handleAdminSupportingList,
    handleAdminSupportingImport,
    handleAdminSupportingCreate,
    handleAdminSupportingUpdate
} = require('./adminSupportingProducts');
const { initDatabase, closeDatabase, dbRun, dbAll, dbGet } = require('./database');
const { assertOrderConnoNotDuplicate, isValidOrderConno } = require('./orderConno');
const { isConfigured: isOracleConfigured } = require('./oracleConfig');
const {
    closePool: closeOraclePool,
    queryErpOrderStatusByConnos,
    queryErpLineStatusByConnoAndGoodsid
} = require('./oracleProducts');
const {
    peelOrderHistorySnapshot,
    peelOrderAuditMeta,
    peelNotifyMeta,
    sendOrderWecomNotification
} = require('./orderNotify');
const { isWecomEnabled } = require('./wecomNotify');
const {
    handleProductFilesConfig,
    handleProductFilesPreview,
    handleProductFilesDownload
} = require('./productFilesDownload');
const { isHuobanConfigured } = require('./huobanDownload');
const {
    handleVendorCertsConfig,
    handleVendorCertsSearch,
    handleVendorCertsDownloadZip,
    handleVendorCertsDownloadOne
} = require('./vendorCertsApi');
const { isVendorCertsConfigured } = require('./vendorCertsDownload');
const { handleInventoryAPI } = require('./inventoryApi');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

/** 以 UTF-8 读取 POST 请求体，避免中文客户名乱码 */
function readRequestBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            total += chunk.length;
            if (maxBytes && total > maxBytes) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => resolve(chunks.join('')));
    });
}

// 配置信息
const CONFIG = {
    port: 3330, // 本服务监听端口（本地开发时使用）
    // 目标ERP地址（接收数据后转发到这里）
    // 这是真正的ERP订单接收接口 targetUrl: 'http://60.12.218.220:5030/receive_data',
    targetUrl: 'http://172.16.24.216:5030/receive_data',
    // 旧地址（备用）
    oldUrl: 'http://101.71.121.242:6881/hessw_webservice_4.3.33/DSOrder'
};

// 存储接收到的数据（实际应用中应使用数据库）
const receivedData = [];

// 创建HTTP服务器
const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const requestPath = requestUrl.pathname;
    if (requestPath === '/receive_data' && req.method === 'POST') {
        console.log(`[HTTP] ${new Date().toISOString()} POST ${requestPath} from ${req.socket.remoteAddress || 'unknown'}`);
    }

    // 设置CORS头，允许跨域请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Token');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 处理OPTIONS预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const pathParts = requestPath.split('/').filter(p => p); // 分割路径

    if (pathParts[0] === 'api') {
        const authResult = enforceApiAuth(req, res, req.method, pathParts);
        if (!authResult.ok) return;
    }

    // 货品管理API
    if (pathParts[0] === 'api' && pathParts[1] === 'products') {
        handleProductsAPI(req, res, req.method, pathParts);
        return;
    }

    // 分类管理API
    if (pathParts[0] === 'api' && pathParts[1] === 'categories') {
        handleCategoriesAPI(req, res, req.method, pathParts);
        return;
    }

    // 历史订单：GET /api/orders?customerId=xxx（必填，且须在登录用户授权客户范围内）
    if (pathParts[0] === 'api' && pathParts[1] === 'orders' && req.method === 'GET') {
        (async () => {
            try {
                const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
                const customerId = (query.get('customerId') || '').trim();
                if (!customerId) {
                    res.writeHead(400);
                    res.end(
                        JSON.stringify({
                            success: false,
                            message: '缺少 customerId 参数',
                            code: 'MISSING_CUSTOMER_ID'
                        })
                    );
                    return;
                }
                if (!assertCustomerAccess(req, res, customerId)) {
                    return;
                }
                const orderPlacer = (query.get('orderPlacer') || query.get('orderPlacerName') || '').trim();
                const limit = Math.min(Math.max(parseInt(query.get('limit') || '100', 10), 1), 200);
                let sql = 'SELECT * FROM orders WHERE customer_id = ?';
                const params = [customerId];
                if (orderPlacer) {
                    sql += ' AND order_placer_name = ?';
                    params.push(orderPlacer);
                }
                sql += ' ORDER BY datetime(COALESCE(order_placed_at, created_at)) DESC LIMIT ?';
                params.push(limit);
                const rows = await dbAll(sql, params);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, orders: rows.map(mapOrderRowToHistoryItem) }));
            } catch (error) {
                console.error('查询历史订单失败:', error);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '查询历史订单失败' }));
            }
        })();
        return;
    }

    // 历史订单明细 ERP 状态（单条）：POST /api/order-erp-line-status  body: { conno, goodsid }
    if (pathParts[0] === 'api' && pathParts[1] === 'order-erp-line-status' && req.method === 'POST') {
        readRequestBody(req, 16 * 1024)
            .then(async (body) => {
                let data;
                try {
                    data = JSON.parse(body || '{}');
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: 'JSON 格式错误' }));
                    return;
                }
                const conno = data.conno != null ? String(data.conno).trim() : '';
                const goodsid = data.goodsid != null ? String(data.goodsid).trim() : '';
                if (!conno || !goodsid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: '缺少 conno 或 goodsid' }));
                    return;
                }
                const line = await queryErpLineStatusByConnoAndGoodsid(conno, goodsid);
                if (!res.headersSent) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, ...line }));
                }
            })
            .catch((err) => {
                if (res.headersSent) return;
                console.error('order-erp-line-status 失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: err.message || '查询失败' }));
            });
        return;
    }

    // 兼容旧接口：POST /api/order-erp-status  body: { orderNos: [...] }
    if (pathParts[0] === 'api' && pathParts[1] === 'order-erp-status' && req.method === 'POST') {
        readRequestBody(req, 64 * 1024)
            .then(async (body) => {
                let data;
                try {
                    data = JSON.parse(body || '{}');
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: 'JSON 格式错误' }));
                    return;
                }
                const orderNos = Array.isArray(data.orderNos) ? data.orderNos : [];
                const statuses = await queryErpOrderStatusByConnos(orderNos);
                if (!res.headersSent) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, statuses: statuses || {} }));
                }
            })
            .catch((err) => {
                if (res.headersSent) return;
                console.error('order-erp-status 失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: err.message || '查询失败' }));
            });
        return;
    }

    // 分类顺序管理API：GET /api/category-order, PUT /api/category-order（SQLite版本）
    if (pathParts[0] === 'api' && pathParts[1] === 'category-order') {
        // GET /api/category-order?customerId=xxx - 获取分类顺序（按客户ID）
        if (req.method === 'GET') {
            (async () => {
                try {
                    const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
                    const customerId = query.get('customerId') || '7522';
                    
                    const rows = await dbAll(
                        'SELECT category_path FROM category_order WHERE customer_id = ? ORDER BY sort_order',
                        [customerId]
                    );
                    
                    const order = rows.map(row => row.category_path);
                    res.writeHead(200);
                    res.end(JSON.stringify(order, null, 2));
                } catch (error) {
                    console.error('读取分类顺序失败:', error);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取分类顺序失败' }));
                }
            })();
            return;
        }
        
        // PUT /api/category-order?customerId=xxx - 保存分类顺序（按客户ID）
        if (req.method === 'PUT') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
                    const customerId = query.get('customerId') || '7522';
                    
                    const order = JSON.parse(body || '[]');
                    if (!Array.isArray(order)) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ success: false, message: '分类顺序必须是数组' }));
                        return;
                    }
                    
                    // 删除旧数据
                    await dbRun('DELETE FROM category_order WHERE customer_id = ?', [customerId]);
                    
                    // 插入新数据
                    for (let i = 0; i < order.length; i++) {
                        await dbRun(
                            'INSERT INTO category_order (customer_id, category_path, sort_order) VALUES (?, ?, ?)',
                            [customerId, order[i], i]
                        );
                    }
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: '分类顺序保存成功', data: order }, null, 2));
                } catch (error) {
                    console.error('保存分类顺序失败:', error);
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: '数据格式错误: ' + error.message }));
                }
            });
            return;
        }
        
        res.writeHead(405);
        res.end(JSON.stringify({ success: false, message: '方法不允许' }));
        return;
    }

    // 货品资料下载（伙伴云）：GET config / POST preview / POST download
    if (pathParts[0] === 'api' && pathParts[1] === 'product-files') {
        if (req.method === 'GET' && pathParts[2] === 'config') {
            handleProductFilesConfig(req, res);
            return;
        }
        if (req.method === 'POST' && pathParts[2] === 'preview') {
            readRequestBody(req, 256 * 1024)
                .then((body) => handleProductFilesPreview(req, res, body))
                .catch((err) => {
                    console.error('读取资料预览请求体失败:', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
                });
            return;
        }
        if (req.method === 'POST' && pathParts[2] === 'download') {
            readRequestBody(req, 256 * 1024)
                .then((body) => handleProductFilesDownload(req, res, body))
                .catch((err) => {
                    console.error('读取资料下载请求体失败:', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
                });
            return;
        }
    }

    // 厂商供应商证照：GET config / POST search / POST download-zip / POST download-one
    if (pathParts[0] === 'api' && pathParts[1] === 'vendor-certs') {
        if (req.method === 'GET' && (!pathParts[2] || pathParts[2] === 'config')) {
            handleVendorCertsConfig(req, res);
            return;
        }
        if (req.method === 'POST' && pathParts[2] === 'search') {
            readRequestBody(req, 64 * 1024)
                .then((body) => handleVendorCertsSearch(req, res, body))
                .catch((err) => {
                    console.error('读取证照查询请求体失败:', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
                });
            return;
        }
        if (req.method === 'POST' && pathParts[2] === 'download-zip') {
            readRequestBody(req, 2 * 1024 * 1024)
                .then((body) => handleVendorCertsDownloadZip(req, res, body))
                .catch((err) => {
                    console.error('读取证照批量下载请求体失败:', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
                });
            return;
        }
        if (req.method === 'POST' && pathParts[2] === 'download-one') {
            readRequestBody(req, 32 * 1024)
                .then((body) => handleVendorCertsDownloadOne(req, res, body))
                .catch((err) => {
                    console.error('读取证照单文件下载请求体失败:', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
                });
            return;
        }
    }

    // 进销存管理 API：/api/inventory/*
    if (pathParts[0] === 'api' && pathParts[1] === 'inventory') {
        handleInventoryAPI(req, res, req.method, pathParts, readRequestBody)
            .catch((err) => {
                console.error('[inventory] 路由异常:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, message: '服务器内部错误' }));
                }
            });
        return;
    }

    // 登录 API（防暴力破解 / IP 限流）：POST /api/auth/login 或 /api/login（统一入口）
    if (
        req.method === 'POST' &&
        pathParts[0] === 'api' &&
        ((pathParts[1] === 'auth' && pathParts[2] === 'login') || pathParts[1] === 'login')
    ) {
        readRequestBody(req, 4096)
            .then((body) => handleAuthLogin(req, res, body))
            .catch((err) => {
                if (err.message === 'BODY_TOO_LARGE') {
                    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, message: '请求体过大' }));
                    return;
                }
                console.error('读取登录请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 修改自己的登录密码：POST /api/auth/change-password
    if (
        req.method === 'POST' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'auth' &&
        pathParts[2] === 'change-password'
    ) {
        readRequestBody(req, 8192)
            .then((body) => handleChangePassword(res, body))
            .catch((err) => {
                console.error('读取改密请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 管理员用户管理
    if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'users') {
        const sub = pathParts[3] || '';
        readRequestBody(req, 256 * 1024)
            .then((body) => {
                if (sub === 'list') {
                    return handleAdminListUsers(res, body);
                }
                return handleAdminCreateUser(res, body);
            })
            .catch((err) => {
                console.error('读取用户管理请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    if (
        req.method === 'PUT' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'admin' &&
        pathParts[2] === 'users' &&
        pathParts[3]
    ) {
        readRequestBody(req, 256 * 1024)
            .then((body) => handleAdminUpdateUser(res, pathParts[3], body))
            .catch((err) => {
                console.error('读取用户更新请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 管理员订单查询：POST /api/admin/orders/search
    if (
        req.method === 'POST' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'admin' &&
        pathParts[2] === 'orders' &&
        pathParts[3] === 'search'
    ) {
        readRequestBody(req, 64 * 1024)
            .then((body) => handleAdminSearchOrders(res, body))
            .catch((err) => {
                console.error('读取订单查询请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 细单「无记录」订单查询：POST /api/admin/orders/search-no-record
    if (
        req.method === 'POST' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'admin' &&
        pathParts[2] === 'orders' &&
        pathParts[3] === 'search-no-record'
    ) {
        readRequestBody(req, 64 * 1024)
            .then((body) => handleAdminSearchOrdersNoRecord(res, body))
            .catch((err) => {
                console.error('读取无记录订单查询请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 删除系统内订单：POST /api/admin/orders/delete
    if (
        req.method === 'POST' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'admin' &&
        pathParts[2] === 'orders' &&
        pathParts[3] === 'delete'
    ) {
        readRequestBody(req, 64 * 1024)
            .then((body) => handleAdminDeleteOrders(res, body))
            .catch((err) => {
                console.error('读取订单删除请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 管理员配套提供：POST list / import
    if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'supporting-products') {
        const sub = pathParts[3] || '';
        const maxBody = sub === 'import' ? 16 * 1024 * 1024 : 256 * 1024;
        readRequestBody(req, maxBody)
            .then((body) => {
                if (sub === 'list') return handleAdminSupportingList(res, body);
                if (sub === 'import') return handleAdminSupportingImport(res, body);
                if (sub === 'create') return handleAdminSupportingCreate(res, body);
                res.writeHead(404);
                res.end(JSON.stringify({ success: false, message: '接口不存在' }));
            })
            .catch((err) => {
                console.error('读取配套提供请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    if (
        req.method === 'PUT' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'admin' &&
        pathParts[2] === 'supporting-products' &&
        pathParts[3]
    ) {
        readRequestBody(req, 256 * 1024)
            .then((body) => handleAdminSupportingUpdate(res, pathParts[3], body))
            .catch((err) => {
                console.error('读取配套提供更新请求体失败:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: '读取请求失败' }));
            });
        return;
    }

    // 接收数据接口（需登录 Token，且仅能为自己有权访问的客户下单）
    if (requestPath === '/receive_data' && req.method === 'POST') {
        const receiveAuth = verifyApiSession(req);
        if (!receiveAuth.ok) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    success: false,
                    message: receiveAuth.message,
                    code: receiveAuth.code
                })
            );
            return;
        }

        readRequestBody(req, 2 * 1024 * 1024)
            .then(async (body) => {
            try {
                // 打印接收信息
                let orderData;

                // 解析订单 body
                try {
                    orderData = JSON.parse(body);
                } catch (e) {
                    if (body.includes('=')) {
                        const params = new URLSearchParams(body);
                        const jsonStr = params.get('data') || params.get('json') || body;
                        orderData = JSON.parse(jsonStr);
                    } else {
                        throw new Error('无法解析请求数据');
                    }
                }

                // 【H6 日志脱敏】只记录摘要信息，不输出货品明细/金额等敏感内容
                console.log(`[${new Date().toISOString()}] 接收订单: conno=${orderData.conno || '?'}, ` +
                    `客户=${orderData.customid || '?'}, 明细=${(orderData.detailList || []).length}条, ` +
                    `来自=${req.socket.remoteAddress || 'unknown'}, 大小=${body.length}B`);

                // 验证必要字段
                if (!orderData.businessType || !orderData.conno) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '缺少必要字段: businessType 或 conno'
                    }));
                    return;
                }

                // 验证detailList
                if (!orderData.detailList || !Array.isArray(orderData.detailList) || orderData.detailList.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '缺少必要字段: detailList（订单明细列表不能为空）'
                    }));
                    return;
                }

                // 验证detailList中的每个明细项
                for (let i = 0; i < orderData.detailList.length; i++) {
                    const detail = orderData.detailList[i];
                    if (!detail.conno || !detail.connodtlid || !detail.goodsid || !detail.goodsqty) {
                        res.writeHead(400);
                        res.end(JSON.stringify({
                            success: false,
                            message: `detailList[${i}] 缺少必要字段: conno, connodtlid, goodsid, goodsqty`
                        }));
                        return;
                    }
                    // 确保明细的conno与主单一致
                    if (detail.conno !== orderData.conno) {
                        console.warn(`⚠️ 明细[${i}]的conno(${detail.conno})与主单conno(${orderData.conno})不一致，已自动修正`);
                        detail.conno = orderData.conno;
                    }
                }

                const customId = orderData.customid != null ? String(orderData.customid).trim() : '';
                if (!customId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '缺少必要字段: customid（客户ID）'
                    }));
                    return;
                }
                if (!canAccessCustomerId(receiveAuth.session, customId)) {
                    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(
                        JSON.stringify({
                            success: false,
                            message: '无权为该客户下单',
                            code: 'FORBIDDEN_CUSTOMER'
                        })
                    );
                    return;
                }

                if (!isValidOrderConno(orderData.conno)) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(
                        JSON.stringify({
                            success: false,
                            message: '订单号格式无效，请 Ctrl+F5 强刷页面后重新提交',
                            code: 'INVALID_CONNO'
                        })
                    );
                    return;
                }

                const dup = await assertOrderConnoNotDuplicate(dbGet, orderData.conno, customId);
                if (!dup.ok) {
                    console.warn(
                        `[receive_data] 订单号冲突 conno=${orderData.conno} customid=${customId}: ${dup.message}`
                    );
                    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(
                        JSON.stringify({
                            success: false,
                            message: dup.message,
                            code: 'DUPLICATE_CONNO'
                        })
                    );
                    return;
                }

                // 下单人/通知对象以登录会话为准，防止客户端伪造 notifyUsername
                orderData.orderPlacerName = receiveAuth.session.username;
                orderData.notifyUsername = receiveAuth.session.username;

                const historySnapshot = peelOrderHistorySnapshot(orderData);
                const orderAudit = peelOrderAuditMeta(orderData);
                const notifyMeta = peelNotifyMeta(orderData);
                console.log(
                    '[receive_data] 下单人=%s 操作时间=%s notifyUsername=%s notifyCustomerName=%s conno=%s',
                    orderAudit.orderPlacerName || '(空)',
                    orderAudit.orderPlacedAt || '(空)',
                    notifyMeta.username || '(空)',
                    notifyMeta.customerName || '(空)',
                    orderData.conno || '(空)'
                );

                // 数据格式转换和验证（确保所有数字字段都是字符串格式）
                orderData = normalizeOrderData(orderData);

                console.log(`✅ 订单数据验证通过，包含 ${orderData.detailList.length} 个明细项`);

                // 保存数据
                const record = {
                    id: Date.now(),
                    receivedAt: new Date().toISOString(),
                    data: orderData
                };
                receivedData.push(record);

                // 同步到海尔施ERP（异步执行，不阻塞响应）
                syncToERP(orderData)
                    .then(result => {
                        console.log('✅ 数据已成功同步到ERP，数据ID:', record.id);

                        // ERP HTTP 200 后再发企业微信，避免未入库就提醒「10分钟后确认」
                        sendOrderWecomNotification(notifyMeta, orderData).catch((err) => {
                            console.error('⚠️ 企业微信下单通知失败:', err.message);
                        });
                        
                        // 保存订单到数据库
                        saveOrderToDatabase(orderData, result, true, null, historySnapshot, orderAudit)
                            .then(() => {
                                console.log('✅ 订单已保存到数据库，订单号:', orderData.conno);
                            })
                            .catch(err => {
                                console.error('⚠️ 保存订单到数据库失败:', err.message);
                            });
                        
                        // 如果请求还在等待，返回成功响应
                        if (!res.headersSent) {
                            res.writeHead(200);
                            res.end(JSON.stringify({
                                success: true,
                                message: '数据接收成功并已同步到ERP',
                                dataId: record.id,
                                erpResult: result
                            }, null, 2));
                        }
                    })
                    .catch(error => {
                        console.error('⚠️ 同步到ERP失败，但数据已保存，数据ID:', record.id);
                        console.error('   错误详情:', error.message);
                        
                        // 即使ERP同步失败，也保存订单到数据库（标记为未同步）
                        saveOrderToDatabase(orderData, null, false, error.message, historySnapshot, orderAudit)
                            .then(() => {
                                console.log('✅ 订单已保存到数据库（ERP同步失败），订单号:', orderData.conno);
                            })
                            .catch(err => {
                                console.error('⚠️ 保存订单到数据库失败:', err.message);
                            });
                        
                        // 即使ERP同步失败，也返回成功（数据已保存）
                        if (!res.headersSent) {
                            res.writeHead(200);
                            res.end(JSON.stringify({
                                success: true,
                                message: '数据接收成功，但ERP同步失败（数据已保存，可稍后重试）',
                                dataId: record.id,
                                error: error.message,
                                errorCode: error.code || 'UNKNOWN',
                                note: '数据已保存在服务器中，可以稍后手动同步或检查ERP服务状态'
                            }, null, 2));
                        }
                    })
                    .catch(err => {
                        // 防止未捕获的错误
                        console.error('❌ 处理ERP同步响应时发生未预期的错误:', err);
                    });

            } catch (error) {
                console.error('处理请求错误:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
                }));
            }
        })
            .catch((err) => {
                if (err.message === 'BODY_TOO_LARGE') {
                    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, message: '请求体过大' }));
                    return;
                }
                console.error('读取订单请求体失败:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        message: '服务器内部错误'
                    }));
                }
            });

    } 
    // 查询接收到的数据接口（仅管理员，调试用）
    else if (requestPath === '/get_data' && req.method === 'GET') {
        const getDataAuth = verifyApiSession(req);
        if (!getDataAuth.ok) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    success: false,
                    message: getDataAuth.message,
                    code: getDataAuth.code
                })
            );
            return;
        }
        if (!getDataAuth.session.isAdmin) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    success: false,
                    message: '仅管理员可查询接收缓存',
                    code: 'FORBIDDEN'
                })
            );
            return;
        }

        const id = requestUrl.searchParams.get('id');
        
        if (id) {
            const record = receivedData.find(r => r.id === parseInt(id));
            if (record) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    data: record
                }, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({
                    success: false,
                    message: '未找到指定数据'
                }));
            }
        } else {
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                count: receivedData.length,
                data: receivedData
            }, null, 2));
        }
    }
    // 健康检查接口
    else if (requestPath === '/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            service: '海尔施ERP数据同步服务',
            timestamp: new Date().toISOString(),
            receivedCount: receivedData.length
        }));
    }
    // 静态文件服务（HTML、CSS、JS等）
    else {
        // 处理静态文件请求
        let filePath = requestPath;
        try {
            filePath = decodeURIComponent(filePath);
        } catch (decodeErr) {
            res.writeHead(400);
            res.end(JSON.stringify({
                success: false,
                message: '无效的 URL 路径'
            }));
            return;
        }

        // 默认首页
        if (filePath === '/' || filePath === '') {
            filePath = '/index.html';
        }

        const relativePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

        if (isBlockedStaticRequest(relativePath)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    success: false,
                    message: '禁止访问该路径'
                })
            );
            return;
        }

        const fullPath = path.normalize(path.join(__dirname, relativePath));

        // 安全检查：确保文件在项目目录内
        const projectDir = path.normalize(__dirname);
        if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
            res.writeHead(403);
            res.end(JSON.stringify({
                success: false,
                message: '禁止访问'
            }));
            return;
        }
        
        // 检查文件是否存在
        fs.access(fullPath, fs.constants.F_OK, (err) => {
            if (err) {
                // 文件不存在，返回 404
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: '文件不存在: ' + requestPath
                }));
                return;
            }
            
            // 读取文件
            fs.readFile(fullPath, (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: '读取文件失败: ' + err.message
                    }));
                    return;
                }
                
                // 根据文件扩展名设置 Content-Type
                const ext = path.extname(fullPath).toLowerCase();
                const contentTypes = {
                    '.html': 'text/html; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.js': 'application/javascript; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.svg': 'image/svg+xml',
                    '.ico': 'image/x-icon',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                    '.ttf': 'font/ttf',
                    '.eot': 'application/vnd.ms-fontobject'
                };
                
                const contentType = contentTypes[ext] || 'application/octet-stream';
                
                // 设置响应头
                res.setHeader('Content-Type', contentType);
                res.writeHead(200);
                res.end(data);
            });
        });
    }
});

/** Oracle 细单/货品 ID：ora:客户:货品ID:价格类型 → ERP 数字货品 ID */
function toErpNumericString(raw, fieldLabel) {
    let value = String(raw ?? '').trim();
    if (value.startsWith('ora:')) {
        const parts = value.split(':');
        if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
            value = parts[2];
        }
    }
    const numValue = value.replace(/[^\d]/g, '');
    if (!/^\d+$/.test(numValue)) {
        throw new Error(`${fieldLabel} 必须是有效数字，当前值: ${raw}`);
    }
    return numValue;
}

/** 细单采购数量 goodsqty：支持最多 2 位小数，最小 0.01，最大 120000 */
const ORDER_QTY_MAX = 120000;

function toErpQtyString(raw, fieldLabel) {
    const value = String(raw ?? '').trim();
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.01) {
        throw new Error(`${fieldLabel} 须为不小于 0.01 的数字，当前值: ${raw}`);
    }
    if (n > ORDER_QTY_MAX) {
        throw new Error(`${fieldLabel} 不能超过 ${ORDER_QTY_MAX}，当前值: ${raw}`);
    }
    const rounded = Math.round(n * 100) / 100;
    if (Number.isInteger(rounded)) return String(rounded);
    return rounded.toFixed(2);
}

// 数据格式标准化函数（确保所有数字字段都是字符串格式）
function normalizeOrderData(orderData) {
    const normalized = { ...orderData };
    
    // 主单字段转换为字符串
    // customid, entryid, assesscustomid 必须是有效数字
    const strictNumericFields = ['customid', 'entryid', 'assesscustomid'];
    strictNumericFields.forEach(field => {
        if (normalized[field] !== undefined && normalized[field] !== null) {
            const value = String(normalized[field]).trim();
            if (value === '' || isNaN(value)) {
                throw new Error(`字段 ${field} 必须是有效数字，当前值: ${normalized[field]}`);
            }
            normalized[field] = value;
        }
    });
    
    // inputmanid 必须是有效数字
    if (normalized.inputmanid !== undefined && normalized.inputmanid !== null) {
        const value = String(normalized.inputmanid).trim();
        if (value === '' || isNaN(value)) {
            throw new Error(`字段 inputmanid 必须是有效数字，当前值: ${normalized.inputmanid}。示例: "9631"`);
        }
        normalized.inputmanid = value;
    }
    
    // 处理detailList
    if (normalized.detailList && Array.isArray(normalized.detailList)) {
        normalized.detailList = normalized.detailList.map((detail, index) => {
            const normalizedDetail = { ...detail };
            
            // 确保conno是字符串
            normalizedDetail.conno = String(normalizedDetail.conno || '');
            
            ['connodtlid', 'goodsid'].forEach((field) => {
                if (normalizedDetail[field] !== undefined && normalizedDetail[field] !== null) {
                    normalizedDetail[field] = toErpNumericString(
                        normalizedDetail[field],
                        `detailList[${index}].${field}`
                    );
                } else {
                    throw new Error(`detailList[${index}].${field} 不能为空`);
                }
            });
            if (normalizedDetail.goodsqty !== undefined && normalizedDetail.goodsqty !== null) {
                normalizedDetail.goodsqty = toErpQtyString(
                    normalizedDetail.goodsqty,
                    `detailList[${index}].goodsqty`
                );
            } else {
                throw new Error(`detailList[${index}].goodsqty 不能为空`);
            }
            
            // 确保dtlmemo是字符串（可以为空）
            normalizedDetail.dtlmemo = String(normalizedDetail.dtlmemo || '');
            
            return normalizedDetail;
        });
    }
    
    // 确保memo是字符串
    normalized.memo = String(normalized.memo || '');
    
    // 确保credate格式正确
    if (normalized.credate) {
        normalized.credate = String(normalized.credate);
    }
    
    return normalized;
}

/** 将数据库订单行转为前端历史订单结构 */
function mapOrderRowToHistoryItem(row) {
    let snapshot = null;
    let erpPayload = null;
    try {
        if (row.history_snapshot) snapshot = JSON.parse(row.history_snapshot);
    } catch (_) { /* ignore */ }
    try {
        if (row.order_data) erpPayload = JSON.parse(row.order_data);
    } catch (_) { /* ignore */ }

    const erpSynced = !!row.erp_synced;
    const serverReceived = row.server_received == null ? true : !!row.server_received;
    const status = row.status === 'success' ? 'success' : row.status === 'error' ? 'error' : 'warning';

    let items = [];
    let total = Number(row.total_amount) || 0;
    let customer = { name: row.customer_name || '' };

    let supplierName = '';
    let supplierId = '';
    if (snapshot) {
        if (snapshot.customer) customer = snapshot.customer;
        if (Array.isArray(snapshot.items)) items = snapshot.items;
        if (snapshot.total != null) total = Number(snapshot.total) || total;
        if (snapshot.supplierName) supplierName = String(snapshot.supplierName).trim();
        if (snapshot.supplierId != null) supplierId = String(snapshot.supplierId).trim();
    } else if (erpPayload && Array.isArray(erpPayload.detailList)) {
        items = erpPayload.detailList.map((d) => ({
            id: d.goodsid,
            erpGoodsId: d.goodsid != null ? String(d.goodsid) : '',
            name: d.dtlmemo ? `货品 ${d.goodsid}` : `货品 ${d.goodsid}`,
            spec: d.dtlmemo || '',
            price: 0,
            quantity: Number(d.goodsqty) || 1
        }));
    }

    // 快照 id/ora 可能已变，以抛单 detailList 的 goodsid 为准对齐 erpGoodsId
    if (Array.isArray(items) && erpPayload && Array.isArray(erpPayload.detailList)) {
        items = items.map((item, idx) => {
            const d = erpPayload.detailList[idx];
            const gid = d && d.goodsid != null ? String(d.goodsid).trim() : '';
            if (!gid) return item;
            return Object.assign({}, item, { erpGoodsId: gid });
        });
    }

    return {
        id: row.id || row.order_no,
        orderNo: row.order_no,
        date: row.created_at || new Date().toISOString(),
        customer,
        items,
        total,
        supplierName,
        supplierId,
        erpData: erpPayload || null,
        receiveStatus: {
            serverReceived,
            erpSynced,
            erpError: row.error_message || null,
            message:
                erpSynced ? '已同步到ERP' : row.error_message ? String(row.error_message) : '已保存，ERP待确认'
        },
        status,
        statusText: erpSynced ? '成功' : row.error_message ? '部分成功' : '待确认',
        orderPlacerName: row.order_placer_name || '',
        orderPlacedAt: row.order_placed_at || row.created_at || '',
        fromServer: true
    };
}

// 保存订单到数据库
async function saveOrderToDatabase(
    orderData,
    erpResult,
    erpSynced,
    errorMessage,
    historySnapshot,
    orderAudit
) {
    try {
        // 计算订单总金额（从detailList中计算，如果有价格信息）
        // 提取客户信息
        const customerId = orderData.customid || null;
        const customerName =
            (historySnapshot && historySnapshot.customer && historySnapshot.customer.name) ||
            orderData.memo ||
            null;
        const totalAmount =
            historySnapshot && historySnapshot.total != null
                ? Number(historySnapshot.total) || 0
                : 0;
        const snapshotJson = historySnapshot ? JSON.stringify(historySnapshot) : null;
        const orderPlacerName =
            orderAudit && orderAudit.orderPlacerName ? String(orderAudit.orderPlacerName).trim() : '';
        const orderPlacedAt =
            orderAudit && orderAudit.orderPlacedAt
                ? String(orderAudit.orderPlacedAt).trim()
                : new Date().toISOString();

        // 订单状态
        let status = 'pending';
        if (erpSynced) {
            status = 'success';
        } else if (errorMessage) {
            status = 'error';
        }
        
        // 保存订单数据（JSON格式）
        const orderDataJson = JSON.stringify(orderData);
        const erpDataJson = erpResult ? JSON.stringify(erpResult) : null;
        
        // 插入或更新订单（使用order_no作为唯一键）
        await dbRun(
            `INSERT OR REPLACE INTO orders (
                order_no, customer_id, customer_name, total_amount,
                order_data, erp_data, status,
                server_received, erp_synced, error_message,
                history_snapshot, order_placer_name, order_placed_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderData.conno,           // order_no
                customerId,                // customer_id
                customerName,              // customer_name
                totalAmount,               // total_amount
                orderDataJson,             // order_data
                erpDataJson,               // erp_data
                status,                    // status
                1,                         // server_received (已接收)
                erpSynced ? 1 : 0,         // erp_synced
                errorMessage || null,       // error_message
                snapshotJson,              // history_snapshot
                orderPlacerName || null,   // order_placer_name
                orderPlacedAt,             // order_placed_at
                orderPlacedAt,             // created_at（与操作时间一致）
                new Date().toISOString()   // updated_at
            ]
        );
        
        console.log(
            `💾 订单已保存到数据库: ${orderData.conno}, 状态: ${status}, 下单人: ${orderPlacerName || '-'}`
        );
    } catch (error) {
        console.error('❌ 保存订单到数据库失败:', error);
        throw error;
    }
}

// 同步数据到海尔施ERP
function syncToERP(orderData) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(orderData);
        
        try {
            const urlObj = new URL(CONFIG.targetUrl);
            const port = urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80);
            
            console.log(`正在同步到ERP: ${CONFIG.targetUrl}`);
            console.log(`目标主机: ${urlObj.hostname}, 端口: ${port}, 路径: ${urlObj.pathname}`);
            console.log(`订单编号: ${orderData.conno}, 明细数量: ${orderData.detailList ? orderData.detailList.length : 0}`);
            
            // 确保detailList被包含
            if (!orderData.detailList || !Array.isArray(orderData.detailList)) {
                console.error('❌ 警告: orderData中缺少detailList或格式不正确');
            } else {
                console.log(`明细列表:`, orderData.detailList.map(d => `goodsid:${d.goodsid}, qty:${d.goodsqty}`).join(', '));
            }
            
            const options = {
                hostname: urlObj.hostname,
                port: port,
                path: urlObj.pathname + (urlObj.search || ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 15000 // 15秒超时（减少超时时间）
            };

            const req = http.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk.toString();
                });

                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log('✅ ERP同步成功:', responseData.substring(0, 200)); // 只显示前200字符
                        resolve({
                            statusCode: res.statusCode,
                            response: responseData
                        });
                    } else {
                        const errorMsg = `ERP返回错误状态码: ${res.statusCode}, 响应: ${responseData.substring(0, 200)}`;
                        console.error('❌', errorMsg);
                        reject(new Error(errorMsg));
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ ERP请求错误:', error.message);
                console.error('   错误代码:', error.code);
                console.error('   目标地址:', CONFIG.targetUrl);
                reject(error);
            });

            req.on('timeout', () => {
                console.error('❌ ERP请求超时 (15秒)');
                console.error('   目标地址:', CONFIG.targetUrl);
                req.destroy();
                reject(new Error('ERP请求超时，目标服务器可能无法访问'));
            });

            req.write(postData);
            req.end();
        } catch (error) {
            console.error('❌ 构造ERP请求失败:', error.message);
            reject(error);
        }
    });
}

// 启动服务器（监听所有网络接口，允许局域网访问）
initDatabase()
    .then(() => {
        server.listen(CONFIG.port, '0.0.0.0', () => {
            console.log('========================================');
            console.log('海尔施ERP数据同步服务已启动');
            console.log('========================================');
            logSecurityConfigOnStartup();
            if (isWecomEnabled()) {
                console.log('企业微信下单通知: 已启用');
            } else {
                console.log('企业微信下单通知: 未配置 WECOM_* 环境变量');
            }
            console.log(`服务地址: http://localhost:${CONFIG.port}`);
            console.log(`局域网访问地址: http://服务器IP:${CONFIG.port}`);
            console.log(`数据库: SQLite (data/haier_order.db)`);
            console.log(
                `货品档案(订单页): ${isOracleConfigured() ? 'Oracle协议价+SQLite配套提供' : '仅SQLite(请配置.env中ORACLE_PASSWORD)'}`
            );
            console.log(`接收接口: POST http://localhost:${CONFIG.port}/receive_data`);
            console.log(`查询接口: GET http://localhost:${CONFIG.port}/get_data`);
            console.log(`历史订单: GET http://localhost:${CONFIG.port}/api/orders?customerId=客户ID`);
            console.log(`订单明细ERP状态: POST http://localhost:${CONFIG.port}/api/order-erp-line-status`);
            console.log(
                `货品资料下载: POST http://localhost:${CONFIG.port}/api/product-files/download` +
                    (isHuobanConfigured() ? ' (已配置)' : ' (未配置 HUOBAN_ACCESS_TOKEN)')
            );
            console.log(
                `厂商供应商证照: POST http://localhost:${CONFIG.port}/api/vendor-certs/search` +
                    (isVendorCertsConfigured() ? ' (已配置)' : ' (未配置 HUOBAN_ACCESS_TOKEN)')
            );
            console.log(`健康检查: GET http://localhost:${CONFIG.port}/health`);
            console.log(`目标ERP: ${CONFIG.targetUrl}`);
            console.log('');
            console.log('货品管理API:');
            console.log(`  获取货品: GET http://localhost:${CONFIG.port}/api/products`);
            console.log(`  创建货品: POST http://localhost:${CONFIG.port}/api/products`);
            console.log(`  更新货品: PUT http://localhost:${CONFIG.port}/api/products/:id`);
            console.log(`  删除货品: DELETE http://localhost:${CONFIG.port}/api/products/:id`);
            console.log('');
            console.log('分类管理API:');
            console.log(`  获取分类: GET http://localhost:${CONFIG.port}/api/categories`);
            console.log(`  创建分类: POST http://localhost:${CONFIG.port}/api/categories`);
            console.log(`  更新分类: PUT http://localhost:${CONFIG.port}/api/categories/:id`);
            console.log(`  删除分类: DELETE http://localhost:${CONFIG.port}/api/categories/:id`);
            console.log('========================================');
        });
    })
    .catch(err => {
        console.error('❌ 数据库初始化失败:', err);
        console.error('错误堆栈:', err.stack);
        process.exit(1);
    });

// 优雅关闭
process.on('SIGTERM', async () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    server.close(async () => {
        await closeDatabase();
        try {
            await closeOraclePool();
        } catch (_) { /* ignore */ }
        console.log('服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('收到SIGINT信号，正在关闭服务器...');
    server.close(async () => {
        await closeDatabase();
        try {
            await closeOraclePool();
        } catch (_) { /* ignore */ }
        console.log('服务器已关闭');
        process.exit(0);
    });
});

