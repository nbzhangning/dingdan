// 货品管理模块
const fs = require('fs');
const path = require('path');

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化数据文件
function initDataFiles() {
    if (!fs.existsSync(PRODUCTS_FILE)) {
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
    if (!fs.existsSync(CATEGORIES_FILE)) {
        // 不创建默认分类，留空以使用导入或API创建的分类
        fs.writeFileSync(CATEGORIES_FILE, JSON.stringify([], null, 2), 'utf8');
    }
}

// 读取货品数据
function getProducts() {
    try {
        const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('读取货品数据失败:', error);
        return [];
    }
}

// 保存货品数据
function saveProducts(products) {
    try {
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('保存货品数据失败:', error);
        return false;
    }
}

// 读取分类数据
function getCategories() {
    try {
        const data = fs.readFileSync(CATEGORIES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('读取分类数据失败:', error);
        return [];
    }
}

// 保存分类数据
function saveCategories(categories) {
    try {
        fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categories, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('保存分类数据失败:', error);
        return false;
    }
}

// 获取下一个ID
function getNextId(items) {
    if (items.length === 0) return 1;
    return Math.max(...items.map(item => item.id || 0)) + 1;
}

// 货品管理API处理函数
function handleProductsAPI(req, res, method, pathParts) {
    const products = getProducts();

    // GET /api/products - 获取货品（支持按客户 customerId 筛选，未设 customerId 的货品归属 7522）
    if (method === 'GET' && pathParts.length === 2) {
        const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const category = query.get('category');
        const search = query.get('search');
        const customerId = query.get('customerId');

        let result = products;

        // 按客户归属筛选：传入 customerId 时只返回该客户所属货品（无 customerId 的货品视为 7522）
        if (customerId) {
            result = result.filter(p => {
                const pid = p.customerId != null ? String(p.customerId) : '7522';
                return pid === String(customerId);
            });
        }

        // 按分类筛选
        if (category) {
            result = result.filter(p => p.category === category || p.categoryId === parseInt(category));
        }

        // 搜索（支持名称、规格、厂家、操作码、ERP货品ID）
        if (search) {
            const searchLower = search.toLowerCase();
            result = result.filter(p =>
                p.name.toLowerCase().includes(searchLower) ||
                p.spec?.toLowerCase().includes(searchLower) ||
                p.manufacturer?.toLowerCase().includes(searchLower) ||
                p.operationCode?.toLowerCase().includes(searchLower) ||
                p.erpGoodsId?.toLowerCase().includes(searchLower)
            );
        }

        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            count: result.length,
            data: result
        }, null, 2));
        return;
    }

    // GET /api/products/:id - 获取单个货品
    if (method === 'GET' && pathParts.length === 3) {
        const id = parseInt(pathParts[2]);
        const product = products.find(p => p.id === id);

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
        return;
    }

    // POST /api/products - 创建货品
    if (method === 'POST' && pathParts.length === 2) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const productData = JSON.parse(body);

                // 验证必填字段
                if (!productData.name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        success: false,
                        message: '货品名称不能为空'
                    }));
                    return;
                }

                // 创建新货品（归属客户 customerId，必填以便后续按客户显示）
                const newProduct = {
                    id: getNextId(products),
                    name: productData.name,
                    category: productData.category || '',
                    categoryId: productData.categoryId || null,
                    spec: productData.spec || '',
                    price: parseFloat(productData.price) || 0,
                    stock: parseInt(productData.stock) || 0,
                    manufacturer: productData.manufacturer || '',
                    brand: productData.brand || '', // 品牌
                    erpGoodsId: productData.erpGoodsId || '', // ERP货品ID（用于订单同步）
                    operationCode: productData.operationCode || '', // 操作码
                    unit: productData.unit || '件', // 单位
                    description: productData.description || '',
                    status: productData.status !== undefined ? productData.status : 1, // 1:启用 0:禁用
                    customerId: productData.customerId != null ? String(productData.customerId) : '7522', // 归属客户
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                products.push(newProduct);
                if (saveProducts(products)) {
                    res.writeHead(201);
                    res.end(JSON.stringify({
                        success: true,
                        message: '货品创建成功',
                        data: newProduct
                    }, null, 2));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        message: '保存失败'
                    }));
                }
            } catch (error) {
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
        const productIndex = products.findIndex(p => p.id === id);

        if (productIndex === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                message: '货品不存在'
            }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const updateData = JSON.parse(body);
                const product = products[productIndex];

                // 更新字段
                if (updateData.name !== undefined) product.name = updateData.name;
                if (updateData.category !== undefined) product.category = updateData.category;
                if (updateData.categoryId !== undefined) product.categoryId = updateData.categoryId;
                if (updateData.spec !== undefined) product.spec = updateData.spec;
                if (updateData.price !== undefined) product.price = parseFloat(updateData.price);
                if (updateData.stock !== undefined) product.stock = parseInt(updateData.stock);
                if (updateData.manufacturer !== undefined) product.manufacturer = updateData.manufacturer;
                if (updateData.erpGoodsId !== undefined) product.erpGoodsId = updateData.erpGoodsId;
                if (updateData.unit !== undefined) product.unit = updateData.unit;
                if (updateData.description !== undefined) product.description = updateData.description;
                if (updateData.status !== undefined) product.status = updateData.status;
                product.updatedAt = new Date().toISOString();

                if (saveProducts(products)) {
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        success: true,
                        message: '货品更新成功',
                        data: product
                    }, null, 2));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        message: '保存失败'
                    }));
                }
            } catch (error) {
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
        const id = parseInt(pathParts[2]);
        const productIndex = products.findIndex(p => p.id === id);

        if (productIndex === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                message: '货品不存在'
            }));
            return;
        }

        products.splice(productIndex, 1);
        if (saveProducts(products)) {
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                message: '货品删除成功'
            }, null, 2));
        } else {
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '保存失败'
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

// 分类管理API处理函数
function handleCategoriesAPI(req, res, method, pathParts) {
    const categories = getCategories();

    // GET /api/categories - 获取所有分类
    if (method === 'GET' && pathParts.length === 2) {
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            count: categories.length,
            data: categories
        }, null, 2));
        return;
    }

    // GET /api/categories/:id - 获取单个分类
    if (method === 'GET' && pathParts.length === 3) {
        const id = parseInt(pathParts[2]);
        const category = categories.find(c => c.id === id);

        if (category) {
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                data: category
            }, null, 2));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                message: '分类不存在'
            }));
        }
        return;
    }

    // POST /api/categories - 创建分类
    if (method === 'POST' && pathParts.length === 2) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
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

                const newCategory = {
                    id: getNextId(categories),
                    name: categoryData.name,
                    description: categoryData.description || '',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                categories.push(newCategory);
                if (saveCategories(categories)) {
                    res.writeHead(201);
                    res.end(JSON.stringify({
                        success: true,
                        message: '分类创建成功',
                        data: newCategory
                    }, null, 2));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        message: '保存失败'
                    }));
                }
            } catch (error) {
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
        const categoryIndex = categories.findIndex(c => c.id === id);

        if (categoryIndex === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                message: '分类不存在'
            }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const updateData = JSON.parse(body);
                const category = categories[categoryIndex];

                if (updateData.name !== undefined) category.name = updateData.name;
                if (updateData.description !== undefined) category.description = updateData.description;
                category.updatedAt = new Date().toISOString();

                if (saveCategories(categories)) {
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        success: true,
                        message: '分类更新成功',
                        data: category
                    }, null, 2));
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        message: '保存失败'
                    }));
                }
            } catch (error) {
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
        const id = parseInt(pathParts[2]);
        const categoryIndex = categories.findIndex(c => c.id === id);

        if (categoryIndex === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({
                success: false,
                message: '分类不存在'
            }));
            return;
        }

        categories.splice(categoryIndex, 1);
        if (saveCategories(categories)) {
            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                message: '分类删除成功'
            }, null, 2));
        } else {
            res.writeHead(500);
            res.end(JSON.stringify({
                success: false,
                message: '保存失败'
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

// 初始化
initDataFiles();

module.exports = {
    handleProductsAPI,
    handleCategoriesAPI,
    getProducts,
    getCategories,
    saveProducts,
    saveCategories
};



