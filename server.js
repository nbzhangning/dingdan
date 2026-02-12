const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { handleProductsAPI, handleCategoriesAPI } = require('./productManager');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

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
                let users = [];
                if (fs.existsSync(USERS_FILE)) {
                    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                }
                const user = users.find(u => String(u.username).trim() === String(username).trim());
                if (!user || String(user.password) !== String(password)) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: false, message: '用户名或密码错误' }));
                    return;
                }
                const { password: _, ...profile } = user;
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
                        console.error('⚠️ 同步到ERP失败，但数据已保存，数据ID:', record.id);
                        console.error('   错误详情:', error.message);
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
                    });

            } catch (error) {
                console.error('处理请求错误:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
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
            receivedCount: receivedData.length
        }));
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
server.listen(CONFIG.port, () => {
    console.log('========================================');
    console.log('海尔施ERP数据同步服务已启动');
    console.log('========================================');
    console.log(`服务地址: http://localhost:${CONFIG.port}`);
    console.log(`接收接口: POST http://localhost:${CONFIG.port}/receive_data`);
    console.log(`查询接口: GET http://localhost:${CONFIG.port}/get_data`);
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

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

