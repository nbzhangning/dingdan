const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { handleProductsAPI, handleCategoriesAPI } = require('./productManager');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// 配置信息
const CONFIG = {
    port: Number(process.env.PORT) || 3330, // 本服务监听端口（本地开发时使用）
    // 目标ERP地址（接收数据后转发到这里）
    // 这是真正的ERP订单接收接口 targetUrl: 'http://60.12.218.220:5030/receive_data',
    targetUrl: process.env.ERP_TARGET_URL || 'http://172.16.24.216:5030/receive_data',
    // 旧地址（备用）
    oldUrl: 'http://101.71.121.242:6881/hessw_webservice_4.3.33/DSOrder',
    strictErpSync: process.env.ERP_STRICT_MODE === '1', // 严格模式：ERP失败时接口返回失败
    retryEnabled: process.env.ERP_RETRY_ENABLED !== '0',
    retryMaxAttempts: Number(process.env.ERP_RETRY_MAX_ATTEMPTS) || 3,
    retryDelayMs: Number(process.env.ERP_RETRY_DELAY_MS) || 30000,
    retryQueueLimit: Number(process.env.ERP_RETRY_QUEUE_LIMIT) || 500
};

// 存储接收到的数据（实际应用中应使用数据库）
const receivedData = [];


// 失败重试队列（内存）
const retryQueue = [];
const erpStats = {
    successCount: 0,
    failureCount: 0,
    queuedCount: 0,
    droppedCount: 0
};

function enqueueRetry(orderData, recordId, lastError) {
    if (!CONFIG.retryEnabled) return;

    if (retryQueue.length >= CONFIG.retryQueueLimit) {
        erpStats.droppedCount += 1;
        console.error(`❌ 重试队列已满(${CONFIG.retryQueueLimit})，丢弃数据ID: ${recordId}`);
        return;
    }

    retryQueue.push({
        recordId,
        orderData,
        attempts: 0,
        lastError: lastError ? String(lastError.message || lastError) : '',
        nextRunAt: Date.now() + CONFIG.retryDelayMs,
        createdAt: new Date().toISOString()
    });

    erpStats.queuedCount += 1;
}

async function processRetryQueue() {
    if (!CONFIG.retryEnabled || retryQueue.length === 0) return;

    const now = Date.now();
    for (let i = retryQueue.length - 1; i >= 0; i--) {
        const item = retryQueue[i];
        if (item.nextRunAt > now) continue;

        item.attempts += 1;
        try {
            await syncToERP(item.orderData);
            erpStats.successCount += 1;
            console.log(`✅ 重试成功，数据ID: ${item.recordId}，尝试次数: ${item.attempts}`);
            retryQueue.splice(i, 1);
        } catch (error) {
            erpStats.failureCount += 1;
            item.lastError = String(error.message || error);
            if (item.attempts >= CONFIG.retryMaxAttempts) {
                console.error(`❌ 重试达到最大次数，放弃数据ID: ${item.recordId}`);
                retryQueue.splice(i, 1);
                continue;
            }
            item.nextRunAt = Date.now() + CONFIG.retryDelayMs;
        }
    }
}


function getUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (error) {
        console.error('读取用户失败:', error.message);
        return [];
    }
}

function getUserByName(username) {
    if (!username) return null;
    const users = getUsers();
    return users.find(u => String(u.username || '').trim() === String(username).trim()) || null;
}

function getUserCustomers(user) {
    if (!user) return [];
    if (Array.isArray(user.customers) && user.customers.length > 0) {
        return user.customers
            .filter(c => c && c.id != null)
            .map(c => ({
                ...c,
                id: String(c.id),
                assessCustomerId: c.assessCustomerId != null ? String(c.assessCustomerId) : undefined,
                entryid: c.entryid != null ? String(c.entryid) : undefined,
                inputmanid: c.inputmanid != null ? String(c.inputmanid) : undefined
            }));
    }
    if (user.customer && user.customer.id != null) {
        return [{
            ...user.customer,
            id: String(user.customer.id),
            assessCustomerId: user.customer.assessCustomerId != null ? String(user.customer.assessCustomerId) : undefined,
            entryid: user.entryId != null ? String(user.entryId) : (user.customer.entryid != null ? String(user.customer.entryid) : undefined),
            inputmanid: user.inputManId != null ? String(user.inputManId) : (user.customer.inputmanid != null ? String(user.customer.inputmanid) : undefined)
        }];
    }
    return [];
}

function buildLoginProfile(user) {
    const customers = getUserCustomers(user);
    const defaultCustomer = customers[0] || null;
    const { password: _, ...profile } = user;
    profile.customers = customers;
    profile.customer = defaultCustomer || user.customer || null;
    profile.defaultCustomerId = defaultCustomer ? defaultCustomer.id : null;
    profile.entryId = defaultCustomer?.entryid || user.entryId || '';
    profile.inputManId = defaultCustomer?.inputmanid || user.inputManId || '';
    return profile;
}

function applyUserOrderContext(orderData, user, selectedCustomerId) {
    if (!user) return { orderData, customer: null };
    const customers = getUserCustomers(user);
    if (customers.length === 0) {
        const error = new Error('该用户没有可下单的客户');
        error.statusCode = 403;
        throw error;
    }

    const targetId = String(selectedCustomerId || orderData.customid || customers[0].id);
    const customer = customers.find(c => String(c.id) === targetId);
    if (!customer) {
        const error = new Error('当前用户无权给该客户下单');
        error.statusCode = 403;
        throw error;
    }

    const patched = { ...orderData };
    patched.customid = String(customer.id);
    if (customer.assessCustomerId) patched.assesscustomid = String(customer.assessCustomerId);
    if (customer.entryid) patched.entryid = String(customer.entryid);
    if (customer.inputmanid) patched.inputmanid = String(customer.inputmanid);

    return { orderData: patched, customer };
}

// 创建HTTP服务器
const server = http.createServer((req, res) => {
    // 设置CORS头，允许跨域请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 处理OPTIONS预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const pathParts = path.split('/').filter(p => p); // 分割路径

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

    // 登录验证 API：POST /api/login
    if (pathParts[0] === 'api' && pathParts[1] === 'login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body || '{}');
                if (!username || !password) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: '请输入用户名和密码' }));
                    return;
                }
                const user = getUserByName(username);
                if (!user || String(user.password) !== String(password)) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: false, message: '用户名或密码错误' }));
                    return;
                }
                const profile = buildLoginProfile(user);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, user: profile }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, message: '请求格式错误' }));
            }
        });
        return;
    }

    // 接收数据接口
    if (path === '/receive_data' && req.method === 'POST') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                let orderData;
                
                // 尝试解析JSON
                try {
                    orderData = JSON.parse(body);
                } catch (e) {
                    // 如果不是JSON，可能是URL编码的表单数据
                    if (body.includes('=')) {
                        const params = new URLSearchParams(body);
                        const jsonStr = params.get('data') || params.get('json') || body;
                        orderData = JSON.parse(jsonStr);
                    } else {
                        throw new Error('无法解析请求数据');
                    }
                }

                console.log('收到订单数据:', JSON.stringify(orderData, null, 2));

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

                // 根据登录用户确定可下单客户并覆盖固定字段
                const username = req.headers['x-user-name'];
                const selectedCustomerId = req.headers['x-customer-id'];
                const currentUser = getUserByName(username);
                if (username && !currentUser) {
                    res.writeHead(401);
                    res.end(JSON.stringify({ success: false, message: '登录用户不存在或会话已失效' }));
                    return;
                }
                if (currentUser) {
                    const patched = applyUserOrderContext(orderData, currentUser, selectedCustomerId);
                    orderData = patched.orderData;
                }

                // 数据格式转换和验证（确保所有数字字段都是字符串格式）
                orderData = normalizeOrderData(orderData);

                console.log(`✅ 订单数据验证通过，包含 ${orderData.detailList.length} 个明细项`);
                console.log('转换后的数据:', JSON.stringify(orderData, null, 2));

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
                        erpStats.successCount += 1;
                        console.log('✅ 数据已成功同步到ERP，数据ID:', record.id);
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
                        erpStats.failureCount += 1;
                        enqueueRetry(orderData, record.id, error);
                        console.error('⚠️ 同步到ERP失败，数据ID:', record.id);
                        console.error('   错误详情:', error.message);
                        // 严格模式下返回失败，非严格模式保持兼容
                        if (!res.headersSent) {
                            const statusCode = CONFIG.strictErpSync ? 502 : 200;
                            const success = !CONFIG.strictErpSync;
                            res.writeHead(statusCode);
                            res.end(JSON.stringify({
                                success,
                                message: CONFIG.strictErpSync
                                    ? 'ERP同步失败（严格模式），请稍后重试'
                                    : '数据接收成功，但ERP同步失败（数据已保存，可稍后重试）',
                                dataId: record.id,
                                error: error.message,
                                errorCode: error.code || 'UNKNOWN',
                                strictMode: CONFIG.strictErpSync,
                                queuedForRetry: CONFIG.retryEnabled
                            }, null, 2));
                        }
                    });

            } catch (error) {
                console.error('处理请求错误:', error);
                const statusCode = Number(error.statusCode) || 400;
                res.writeHead(statusCode);
                res.end(JSON.stringify({
                    success: false,
                    message: statusCode === 400 ? ('数据格式错误: ' + error.message) : error.message
                }));
            }
        });

        req.on('error', error => {
            console.error('请求错误:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '服务器内部错误'
            }));
        });

    } 
    // 查询接收到的数据接口
    else if (path === '/get_data' && req.method === 'GET') {
        const id = parsedUrl.query.id;
        
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
    else if (path === '/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            service: '海尔施ERP数据同步服务',
            timestamp: new Date().toISOString(),
            receivedCount: receivedData.length,
            strictErpSync: CONFIG.strictErpSync,
            retryEnabled: CONFIG.retryEnabled,
            retryQueueSize: retryQueue.length
        }));
    }
    // ERP重试队列状态
    else if (path === '/erp/retry_queue' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            config: {
                strictErpSync: CONFIG.strictErpSync,
                retryEnabled: CONFIG.retryEnabled,
                retryMaxAttempts: CONFIG.retryMaxAttempts,
                retryDelayMs: CONFIG.retryDelayMs,
                retryQueueLimit: CONFIG.retryQueueLimit
            },
            stats: erpStats,
            queueSize: retryQueue.length,
            queue: retryQueue.map(item => ({
                recordId: item.recordId,
                attempts: item.attempts,
                lastError: item.lastError,
                nextRunAt: new Date(item.nextRunAt).toISOString(),
                createdAt: item.createdAt
            }))
        }, null, 2));
    }
    // 手动触发一次重试任务
    else if (path === '/erp/retry_now' && req.method === 'POST') {
        processRetryQueue()
            .then(() => {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: '已触发重试任务',
                    queueSize: retryQueue.length
                }));
            })
            .catch(error => {
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    message: error.message
                }));
            });
    }
    // 404
    else {
        res.writeHead(404);
        res.end(JSON.stringify({
            success: false,
            message: '接口不存在'
        }));
    }
});

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
            
            // 数字字段转换为字符串并验证
            const detailNumericFields = ['connodtlid', 'goodsid', 'goodsqty'];
            detailNumericFields.forEach(field => {
                if (normalizedDetail[field] !== undefined && normalizedDetail[field] !== null) {
                    const value = String(normalizedDetail[field]).trim();
                    if (value === '' || isNaN(value)) {
                        throw new Error(`detailList[${index}].${field} 必须是有效数字，当前值: ${normalizedDetail[field]}`);
                    }
                    // 确保是纯数字字符串（移除所有非数字字符，但保留原值）
                    const numValue = value.replace(/[^\d]/g, '');
                    if (numValue === '') {
                        throw new Error(`detailList[${index}].${field} 必须是有效数字，当前值: ${normalizedDetail[field]}`);
                    }
                    normalizedDetail[field] = numValue;
                } else {
                    throw new Error(`detailList[${index}].${field} 不能为空`);
                }
            });
            
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

// 启动服务器
setInterval(() => {
    processRetryQueue().catch(error => {
        console.error('处理重试队列失败:', error.message);
    });
}, Math.max(3000, Math.floor(CONFIG.retryDelayMs / 2)));

server.listen(CONFIG.port, () => {
    console.log('========================================');
    console.log('海尔施ERP数据同步服务已启动');
    console.log('========================================');
    console.log(`服务地址: http://localhost:${CONFIG.port}`);
    console.log(`接收接口: POST http://localhost:${CONFIG.port}/receive_data`);
    console.log(`查询接口: GET http://localhost:${CONFIG.port}/get_data`);
    console.log(`健康检查: GET http://localhost:${CONFIG.port}/health`);
    console.log(`目标ERP: ${CONFIG.targetUrl}`);
    console.log(`严格模式: ${CONFIG.strictErpSync ? '开启' : '关闭'}`);
    console.log(`重试队列: ${CONFIG.retryEnabled ? '开启' : '关闭'} (maxAttempts=${CONFIG.retryMaxAttempts}, delayMs=${CONFIG.retryDelayMs})`);
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

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

