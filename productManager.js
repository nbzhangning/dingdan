/**
 * productManager.js — 货品档案与分类管理
 *
 * 数据来源双轨：
 *   - Oracle 实时协议价（fetchAgreementPricesByCustomer）：GET /api/products 时优先返回
 *   - SQLite products 表本地缓存：Oracle 不通时降级，或维护"配套提供"价格
 *
 * price_type 区分：
 *   '协议价' = 从 Oracle 同步的正式价格
 *   '配套提供' = 本地手工维护，不从 Oracle 拉取（常见于试剂配套耗材）
 *
 * 关键接口：
 *   GET  /api/products?customerId=   返回合并后的货品列表（Oracle + 本地配套）
 *   POST /api/products               新增本地货品
 *   PUT  /api/products/:id           修改本地货品
 *   DELETE /api/products/:id         删除本地货品
 *   GET/PUT /api/category-order      分类排序（按客户）
 */
// 货品管理模块（SQLite 配套提供 + Oracle 协议价）
const PRICE_TYPE_SUPPORTING = '配套提供';
const { dbRun, dbGet, dbAll } = require('./database');
const { fetchAgreementPricesByCustomer, isConfigured: isOracleConfigured } = require('./oracleProducts');
const { config: oracleConfig } = require('./oracleConfig');
const {
    resolveOracleSupplierIdForPriceQuery,
    resolveOraclePriceTypeForQuery
} = require('./userResolve');

/** 【M3】安全读取请求体，超出 maxBytes 时拒绝并销毁连接 */
function readProductBody(req, maxBytes = 1 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                req.destroy();
                reject(new Error('BODY_TOO_LARGE'));
                return;
            }
            body += chunk.toString();
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

const UNCATEGORIZED = '无分类';

/** 空分类、未分类 统一为「无分类」（Oracle 视图暂无分类字段时使用） */
function normalizeCategory(category) {
    if (category === null || category === undefined) return UNCATEGORIZED;
    const s = String(category).trim();
    if (!s || s === '未分类') return UNCATEGORIZED;
    return s;
}

// 将数据库行转换为产品对象
function rowToProduct(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        category: normalizeCategory(row.category),
        categoryId: row.category_id,
        customerId: row.customer_id,
        spec: row.spec,
        price: row.price,
        priceType: row.price_type || '协议价',
        stock: row.stock,
        manufacturer: row.manufacturer,
        brand: row.brand,
        erpGoodsId: row.erp_goods_id,
        operationCode: row.operation_code,
        unit: row.unit,
        description: row.description,
        status: row.status,
        hideInMenu: row.hide_in_menu === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

// 将产品对象转换为数据库行
function productToRow(product) {
    return {
        name: product.name,
        category: product.category || null,
        category_id: product.categoryId || null,
        customer_id: product.customerId || '7522',
        spec: product.spec || null,
        price: product.price || 0,
        price_type: product.priceType || product.price_type || '协议价',
        stock: product.stock || 0,
        manufacturer: product.manufacturer || null,
        brand: product.brand || null,
        erp_goods_id: product.erpGoodsId || null,
        operation_code: product.operationCode || null,
        unit: product.unit || '件',
        description: product.description || null,
        status: product.status !== undefined ? product.status : 1,
        hide_in_menu: product.hideInMenu === true ? 1 : 0,
        updated_at: new Date().toISOString()
    };
}

// 读取货品数据（兼容旧接口）
async function getProducts() {
    try {
        const rows = await dbAll('SELECT * FROM products ORDER BY id');
        return rows.map(rowToProduct);
    } catch (error) {
        console.error('读取货品数据失败:', error);
        return [];
    }
}

// 保存货品数据（兼容旧接口，批量更新）
async function saveProducts(products) {
    // 注意：这个方法主要用于兼容，实际应该使用单个产品的增删改
    // 这里实现批量更新逻辑
    try {
        for (const product of products) {
            const row = productToRow(product);
            if (product.id) {
                // 更新
                await dbRun(
                    `UPDATE products SET 
                        name = ?, category = ?, category_id = ?, customer_id = ?,
                        spec = ?, price = ?, price_type = ?, stock = ?, manufacturer = ?, brand = ?,
                        erp_goods_id = ?, operation_code = ?, unit = ?, description = ?,
                        status = ?, hide_in_menu = ?, updated_at = ?
                    WHERE id = ?`,
                    [
                        row.name, row.category, row.category_id, row.customer_id,
                        row.spec, row.price, row.price_type, row.stock, row.manufacturer, row.brand,
                        row.erp_goods_id, row.operation_code, row.unit, row.description,
                        row.status, row.hide_in_menu, row.updated_at, product.id
                    ]
                );
            } else {
                // 插入
                await dbRun(
                    `INSERT INTO products (
                        name, category, category_id, customer_id, spec, price, price_type, stock,
                        manufacturer, brand, erp_goods_id, operation_code, unit, description,
                        status, hide_in_menu, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.name, row.category, row.category_id, row.customer_id,
                        row.spec, row.price, row.price_type, row.stock, row.manufacturer, row.brand,
                        row.erp_goods_id, row.operation_code, row.unit, row.description,
                        row.status, row.hide_in_menu, new Date().toISOString(), row.updated_at
                    ]
                );
            }
        }
        return true;
    } catch (error) {
        console.error('保存货品数据失败:', error);
        return false;
    }
}

// 读取分类数据（兼容旧接口）
async function getCategories() {
    try {
        const rows = await dbAll('SELECT * FROM categories ORDER BY id');
        return rows.map(row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    } catch (error) {
        console.error('读取分类数据失败:', error);
        return [];
    }
}

// 保存分类数据（兼容旧接口）
async function saveCategories(categories) {
    try {
        for (const category of categories) {
            if (category.id) {
                await dbRun(
                    'UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?',
                    [category.name, category.description || null, new Date().toISOString(), category.id]
                );
            } else {
                await dbRun(
                    'INSERT INTO categories (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)',
                    [category.name, category.description || null, new Date().toISOString(), new Date().toISOString()]
                );
            }
        }
        return true;
    } catch (error) {
        console.error('保存分类数据失败:', error);
        return false;
    }
}

// 获取下一个ID
async function getNextId(tableName) {
    try {
        // 白名单验证，防止SQL注入
        const allowedTables = ['products', 'categories', 'users'];
        if (!allowedTables.includes(tableName)) {
            throw new Error(`不允许的表名: ${tableName}`);
        }
        const row = await dbGet(`SELECT MAX(id) as maxId FROM ${tableName}`);
        return (row?.maxId || 0) + 1;
    } catch (error) {
        console.error('获取下一个ID失败:', error);
        return 1;
    }
}

function filterProductsInMemory(products, { category, search }) {
    let list = products;
    if (category) {
        const cat = String(category).trim();
        list = list.filter((p) => p.category === cat || String(p.categoryId) === cat);
    }
    if (search) {
        const q = String(search).trim().toLowerCase();
        list = list.filter(
            (p) =>
                (p.name && p.name.toLowerCase().includes(q)) ||
                (p.spec && p.spec.toLowerCase().includes(q)) ||
                (p.manufacturer && p.manufacturer.toLowerCase().includes(q)) ||
                (p.operationCode && p.operationCode.toLowerCase().includes(q)) ||
                (p.erpGoodsId && String(p.erpGoodsId).toLowerCase().includes(q))
        );
    }
    return list;
}

/** SQLite：仅配套提供（Excel 导入） */
async function fetchWholesaleFromSqlite(customerId, includeHidden) {
    let sql = `SELECT * FROM products WHERE customer_id = ? AND (price_type = ? OR price_type = '批发价')`;
    const params = [String(customerId).trim(), PRICE_TYPE_SUPPORTING];
    if (!includeHidden) {
        sql += ' AND hide_in_menu = 0';
    }
    sql += ' ORDER BY id';
    const rows = await dbAll(sql, params);
    return rows.map((row) => ({ ...rowToProduct(row), source: 'sqlite' }));
}

/** SQLite：仅协议价（订单页使用） */
async function fetchAgreementFromSqlite(customerId, includeHidden) {
    let sql = `SELECT * FROM products WHERE customer_id = ?
        AND (price_type = '协议价' OR price_type IS NULL OR price_type = '')`;
    const params = [String(customerId).trim()];
    if (!includeHidden) {
        sql += ' AND hide_in_menu = 0';
    }
    sql += ' ORDER BY id';
    const rows = await dbAll(sql, params);
    return rows.map((row) => ({ ...rowToProduct(row), source: 'sqlite' }));
}

/** 订单页：仅本地 SQLite 协议价 */
async function listProductsForOrder(options) {
    const { customerId, category, search, includeHidden } = options;
    const cid = String(customerId || '').trim();
    if (!cid) {
        return { products: [], sources: { sqlite: 'empty' }, mode: 'sqlite-agreement' };
    }
    let products = await fetchAgreementFromSqlite(cid, includeHidden);
    products = filterProductsInMemory(products, { category, search });
    return { products, sources: { sqlite: '协议价' }, mode: 'sqlite-agreement' };
}

/**
 * 订单页合并列表（默认）
 * - 协议价：仅 Oracle 视图（实时），不使用 SQLite 协议价
 * - 配套提供：仅 SQLite（Excel 导入）
 */
async function listProductsMerged(options) {
    const { customerId, priceCustomerId, supplierId, mergePrice, category, search, includeHidden } =
        options;
    const cid = String(customerId || '').trim();
    const priceCid = String(priceCustomerId || customerId || '').trim();
    const sid = String(supplierId || '').trim();
    const oracleSid = resolveOracleSupplierIdForPriceQuery({
        mergePrice,
        customerId: cid,
        priceCustomerId: priceCid,
        supplierId: sid
    });
    const oraclePriceType = resolveOraclePriceTypeForQuery({
        mergePrice,
        customerId: cid,
        priceCustomerId: priceCid,
        agreementPriceType: oracleConfig.agreementPriceType,
        mergePriceType: oracleConfig.mergePriceType
    });
    const isMergeOracle = oraclePriceType !== oracleConfig.agreementPriceType;
    const priceTypeLabel = isMergeOracle ? oraclePriceType : '协议价';
    if (!cid) {
        return { products: [], sources: {} };
    }

    const sources = {
        oracle: '协议价',
        sqlite: '配套提供'
    };
    let agreement = [];
    let wholesale = [];

    if (isOracleConfigured()) {
        try {
            agreement = await fetchAgreementPricesByCustomer(priceCid, oracleSid, oraclePriceType);
            const mergeHint = priceCid !== cid ? ',抛单' + cid : '';
            sources.oracle = oracleSid
                ? `${priceTypeLabel}:${agreement.length}条(视图客户${priceCid}${mergeHint},供应商${oracleSid})`
                : `${priceTypeLabel}:${agreement.length}条(视图客户${priceCid}${mergeHint}${priceCid !== cid ? ',合并价格不限供应商' : ''})`;
        } catch (err) {
            console.error('Oracle 协议价查询失败:', err.message);
            sources.oracle = 'error: ' + err.message;
        }
    } else {
        sources.oracle = 'disabled(未配置.env)';
    }

    try {
        wholesale = await fetchWholesaleFromSqlite(cid, includeHidden);
        sources.sqlite = `配套提供:${wholesale.length}条`;
    } catch (err) {
        console.error('SQLite 配套提供查询失败:', err.message);
        sources.sqlite = 'error: ' + err.message;
    }

    let products = [...agreement, ...wholesale];
    products = filterProductsInMemory(products, { category, search });
    products = products.map((p) => ({
        ...p,
        category: normalizeCategory(p.category)
    }));
    return { products, sources };
}

/** 仅 SQLite（设置页、无客户、或 includeHidden 管理全部本地档案） */
async function listProductsSqliteOnly(options) {
    const { customerId, category, search, includeHidden } = options;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (customerId) {
        sql += ' AND customer_id = ?';
        params.push(String(customerId).trim());
    }
    if (category) {
        sql += ' AND (category = ? OR category_id = ?)';
        params.push(category, parseInt(category) || 0);
    }
    if (search) {
        sql += ` AND (
            name LIKE ? OR spec LIKE ? OR manufacturer LIKE ? OR
            operation_code LIKE ? OR erp_goods_id LIKE ?
        )`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    if (!includeHidden) {
        sql += ' AND hide_in_menu = 0';
    }
    sql += ' ORDER BY id';
    const rows = await dbAll(sql, params);
    return rows.map((row) => ({ ...rowToProduct(row), source: 'sqlite' }));
}

// 货品管理API处理函数（异步版本）
async function handleProductsAPI(req, res, method, pathParts) {
    // GET /api/products - 获取货品
    if (method === 'GET' && pathParts.length === 2) {
        try {
            const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
            const category = query.get('category');
            const search = query.get('search');
            const customerId = query.get('customerId');
            const priceCustomerId = (query.get('priceCustomerId') || '').trim();
            const supplierId = (query.get('supplierId') || '').trim();
            const mergePrice = query.get('mergePrice');
            const includeHidden = query.get('includeHidden') === 'true';
            const sourceMode = query.get('source');
            // 默认 merged：Oracle 协议价(实时) + SQLite 配套提供
            // source=sqlite-agreement：仅本地协议价；source=sqlite：设置页全部本地

            let result;
            let meta = {};

            if (sourceMode === 'sqlite-agreement' && customerId && !includeHidden) {
                const orderList = await listProductsForOrder({
                    customerId,
                    category,
                    search,
                    includeHidden
                });
                result = orderList.products;
                meta = { sources: orderList.sources, mode: orderList.mode };
            } else if (customerId && !includeHidden) {
                const merged = await listProductsMerged({
                    customerId,
                    priceCustomerId: priceCustomerId || customerId,
                    supplierId,
                    mergePrice,
                    category,
                    search,
                    includeHidden
                });
                result = merged.products;
                meta = { sources: merged.sources, mode: 'oracle+sqlite' };
            } else {
                result = await listProductsSqliteOnly({
                    customerId,
                    category,
                    search,
                    includeHidden
                });
                meta = { mode: 'sqlite-only' };
            }

            res.writeHead(200);
            res.end(
                JSON.stringify(
                    {
                        success: true,
                        count: result.length,
                        data: result,
                        ...meta
                    },
                    null,
                    2
                )
            );
        } catch (error) {
            console.error('获取货品列表失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '获取货品列表失败: ' + error.message
            }));
        }
        return;
    }

    // GET /api/products/:id - 获取单个货品
    if (method === 'GET' && pathParts.length === 3) {
        try {
            const id = parseInt(pathParts[2], 10);
            const row = await dbGet('SELECT * FROM products WHERE id = ?', [id]);
            const product = rowToProduct(row);

            if (product) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    data: product
                }, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({
                    success: false,
                    message: '货品不存在'
                }));
            }
        } catch (error) {
            console.error('获取货品失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '获取货品失败: ' + error.message
            }));
        }
        return;
    }

    // POST /api/products - 创建货品
    if (method === 'POST' && pathParts.length === 2) {
        readProductBody(req, 256 * 1024)
        .catch((err) => {
            if (!res.headersSent) { res.writeHead(err.message === 'BODY_TOO_LARGE' ? 413 : 500); res.end(JSON.stringify({ success: false, message: err.message === 'BODY_TOO_LARGE' ? '请求体过大' : '读取失败' })); }
        })
        .then(async (body) => {
            if (body === undefined) return;
            try {
                const productData = JSON.parse(body);

                if (!productData.name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '货品名称不能为空'
                    }));
                    return;
                }
                if (productData.customerId == null || productData.customerId === '') {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '请设定货品归属客户（customerId）'
                    }));
                    return;
                }

                const newId = await getNextId('products');
                const row = productToRow({
                    ...productData,
                    id: newId
                });

                await dbRun(
                    `INSERT INTO products (
                        id, name, category, category_id, customer_id, spec, price, price_type, stock,
                        manufacturer, brand, erp_goods_id, operation_code, unit, description,
                        status, hide_in_menu, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        newId, row.name, row.category, row.category_id, row.customer_id,
                        row.spec, row.price, row.price_type, row.stock, row.manufacturer, row.brand,
                        row.erp_goods_id, row.operation_code, row.unit, row.description,
                        row.status, row.hide_in_menu, new Date().toISOString(), row.updated_at
                    ]
                );

                const newProduct = {
                    id: newId,
                    ...productData,
                    hideInMenu: productData.hideInMenu === true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    message: '货品创建成功',
                    data: newProduct
                }, null, 2));
            } catch (error) {
                console.error('创建货品失败:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
                }));
            }
        });
        return;
    }

    // PUT /api/products/:id - 更新货品
    if (method === 'PUT' && pathParts.length === 3) {
        const id = parseInt(pathParts[2]);
        readProductBody(req, 256 * 1024)
        .catch((err) => {
            if (!res.headersSent) { res.writeHead(err.message === 'BODY_TOO_LARGE' ? 413 : 500); res.end(JSON.stringify({ success: false, message: err.message === 'BODY_TOO_LARGE' ? '请求体过大' : '读取失败' })); }
        })
        .then(async (body) => {
            if (body === undefined) return;
            try {
                const existing = await dbGet('SELECT * FROM products WHERE id = ?', [id]);
                if (!existing) {
                    res.writeHead(404);
                    res.end(JSON.stringify({
                        success: false,
                        message: '货品不存在'
                    }));
                    return;
                }

                const updateData = JSON.parse(body);
                const product = rowToProduct(existing);

                // 更新字段
                if (updateData.name !== undefined) product.name = updateData.name;
                if (updateData.category !== undefined) product.category = updateData.category;
                if (updateData.categoryId !== undefined) product.categoryId = updateData.categoryId;
                if (updateData.customerId !== undefined) product.customerId = String(updateData.customerId).trim();
                if (updateData.spec !== undefined) product.spec = updateData.spec;
                if (updateData.price !== undefined) product.price = parseFloat(updateData.price);
                if (updateData.priceType !== undefined) product.priceType = String(updateData.priceType).trim() || '协议价';
                if (updateData.stock !== undefined) product.stock = parseInt(updateData.stock);
                if (updateData.manufacturer !== undefined) product.manufacturer = updateData.manufacturer;
                if (updateData.erpGoodsId !== undefined) product.erpGoodsId = updateData.erpGoodsId;
                if (updateData.unit !== undefined) product.unit = updateData.unit;
                if (updateData.description !== undefined) product.description = updateData.description;
                if (updateData.status !== undefined) product.status = updateData.status;
                if (updateData.hideInMenu !== undefined) product.hideInMenu = updateData.hideInMenu === true;
                product.updatedAt = new Date().toISOString();

                const row = productToRow(product);
                await dbRun(
                    `UPDATE products SET 
                        name = ?, category = ?, category_id = ?, customer_id = ?,
                        spec = ?, price = ?, price_type = ?, stock = ?, manufacturer = ?, brand = ?,
                        erp_goods_id = ?, operation_code = ?, unit = ?, description = ?,
                        status = ?, hide_in_menu = ?, updated_at = ?
                    WHERE id = ?`,
                    [
                        row.name, row.category, row.category_id, row.customer_id,
                        row.spec, row.price, row.price_type, row.stock, row.manufacturer, row.brand,
                        row.erp_goods_id, row.operation_code, row.unit, row.description,
                        row.status, row.hide_in_menu, row.updated_at, id
                    ]
                );

                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: '货品更新成功',
                    data: product
                }, null, 2));
            } catch (error) {
                console.error('更新货品失败:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
                }));
            }
        });
        return;
    }

    // DELETE /api/products/:id - 删除货品
    if (method === 'DELETE' && pathParts.length === 3) {
        try {
            const id = parseInt(pathParts[2], 10);
            const result = await dbRun('DELETE FROM products WHERE id = ?', [id]);

            if (result.changes > 0) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: '货品删除成功'
                }, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({
                    success: false,
                    message: '货品不存在'
                }));
            }
        } catch (error) {
            console.error('删除货品失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '删除失败: ' + error.message
            }));
        }
        return;
    }

    // 未匹配的路由
    res.writeHead(404);
    res.end(JSON.stringify({
        success: false,
        message: '接口不存在'
    }));
}

// 分类管理API处理函数（异步版本）
async function handleCategoriesAPI(req, res, method, pathParts) {
    // GET /api/categories - 获取所有分类
    if (method === 'GET' && pathParts.length === 2) {
        try {
            const categories = await getCategories();
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                count: categories.length,
                data: categories
            }, null, 2));
        } catch (error) {
            console.error('获取分类列表失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '获取分类列表失败: ' + error.message
            }));
        }
        return;
    }

    // GET /api/categories/:id - 获取单个分类
    if (method === 'GET' && pathParts.length === 3) {
        try {
            const id = parseInt(pathParts[2], 10);
            const row = await dbGet('SELECT * FROM categories WHERE id = ?', [id]);

            if (row) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    data: {
                        id: row.id,
                        name: row.name,
                        description: row.description,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at
                    }
                }, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({
                    success: false,
                    message: '分类不存在'
                }));
            }
        } catch (error) {
            console.error('获取分类失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '获取分类失败: ' + error.message
            }));
        }
        return;
    }

    // POST /api/categories - 创建分类
    if (method === 'POST' && pathParts.length === 2) {
        readProductBody(req, 64 * 1024)
        .catch((err) => {
            if (!res.headersSent) { res.writeHead(err.message === 'BODY_TOO_LARGE' ? 413 : 500); res.end(JSON.stringify({ success: false, message: err.message === 'BODY_TOO_LARGE' ? '请求体过大' : '读取失败' })); }
        })
        .then(async (body) => {
            if (body === undefined) return;
            try {
                const categoryData = JSON.parse(body);

                if (!categoryData.name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '分类名称不能为空'
                    }));
                    return;
                }

                const newId = await getNextId('categories');
                const now = new Date().toISOString();

                await dbRun(
                    'INSERT INTO categories (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    [newId, categoryData.name, categoryData.description || '', now, now]
                );

                const newCategory = {
                    id: newId,
                    name: categoryData.name,
                    description: categoryData.description || '',
                    createdAt: now,
                    updatedAt: now
                };

                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    message: '分类创建成功',
                    data: newCategory
                }, null, 2));
            } catch (error) {
                console.error('创建分类失败:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
                }));
            }
        });
        return;
    }

    // PUT /api/categories/:id - 更新分类
    if (method === 'PUT' && pathParts.length === 3) {
        const id = parseInt(pathParts[2]);
        readProductBody(req, 64 * 1024)
        .catch((err) => {
            if (!res.headersSent) { res.writeHead(err.message === 'BODY_TOO_LARGE' ? 413 : 500); res.end(JSON.stringify({ success: false, message: err.message === 'BODY_TOO_LARGE' ? '请求体过大' : '读取失败' })); }
        })
        .then(async (body) => {
            if (body === undefined) return;
            try {
                const existing = await dbGet('SELECT * FROM categories WHERE id = ?', [id]);
                if (!existing) {
                    res.writeHead(404);
                    res.end(JSON.stringify({
                        success: false,
                        message: '分类不存在'
                    }));
                    return;
                }

                const updateData = JSON.parse(body);
                const updates = [];
                const params = [];

                if (updateData.name !== undefined) {
                    updates.push('name = ?');
                    params.push(updateData.name);
                }
                if (updateData.description !== undefined) {
                    updates.push('description = ?');
                    params.push(updateData.description);
                }
                updates.push('updated_at = ?');
                params.push(new Date().toISOString());
                params.push(id);

                await dbRun(
                    `UPDATE categories SET ${updates.join(', ')} WHERE id = ?`,
                    params
                );

                const updated = await dbGet('SELECT * FROM categories WHERE id = ?', [id]);
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: '分类更新成功',
                    data: {
                        id: updated.id,
                        name: updated.name,
                        description: updated.description,
                        createdAt: updated.created_at,
                        updatedAt: updated.updated_at
                    }
                }, null, 2));
            } catch (error) {
                console.error('更新分类失败:', error);
                res.writeHead(400);
                res.end(JSON.stringify({
                    success: false,
                    message: '数据格式错误: ' + error.message
                }));
            }
        });
        return;
    }

    // DELETE /api/categories/:id - 删除分类
    if (method === 'DELETE' && pathParts.length === 3) {
        try {
            const id = parseInt(pathParts[2], 10);
            const result = await dbRun('DELETE FROM categories WHERE id = ?', [id]);

            if (result.changes > 0) {
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: '分类删除成功'
                }, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({
                    success: false,
                    message: '分类不存在'
                }));
            }
        } catch (error) {
            console.error('删除分类失败:', error);
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '删除失败: ' + error.message
            }));
        }
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({
        success: false,
        message: '接口不存在'
    }));
}

module.exports = {
    handleProductsAPI,
    handleCategoriesAPI,
    getProducts,
    getCategories,
    saveProducts,
    saveCategories,
    normalizeCategory,
    UNCATEGORIZED
};

