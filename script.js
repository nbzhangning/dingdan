// 登录校验：未登录则跳转登录页（仅主页面 index 需要）
(function () {
    var isIndex = /index\.html$/i.test(window.location.pathname) || (window.location.pathname === '/' || window.location.pathname === '');
    if (!isIndex) return;
    try {
        var userJson = sessionStorage.getItem('user');
        const u = userJson ? JSON.parse(userJson) : null;
        if (!u || (!u.customer && !(Array.isArray(u.customers) && u.customers.length))) {
            window.location.replace('login.html');
            return;
        }
    } catch (e) {
        window.location.replace('login.html');
    }
})();

// 根据登录用户覆盖客户/供应商/制单人配置
(function () {
    try {
        var userJson = sessionStorage.getItem('user');
        if (userJson) {
            var user = JSON.parse(userJson);
            window.CUSTOMER_CONFIG = {
                customer: user.customer || window.CUSTOMER_CONFIG?.customer,
                supplier: user.supplier || window.CUSTOMER_CONFIG?.supplier,
                inputManId: user.inputManId != null ? String(user.inputManId) : (window.CUSTOMER_CONFIG?.inputManId || 'system')
            };
        }
    } catch (e) {}
})();

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
        
        // 优先级3: 自动检测环境
        const isLocal = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname === '';
        
        const defaultUrl = isLocal 
            ? 'http://localhost:3330/receive_data'  // 本地开发
            : 'http://60.12.218.220:5030/receive_data';  // 生产环境
        
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
    
    // 请求超时时间（毫秒）
    timeout: 10000
};



let currentUser = null;
let availableCustomers = [];
let activeCustomer = null;

let hasOrderableCustomers = true;

function showNoCustomerPermission(message) {
    hasOrderableCustomers = false;
    activeCustomer = null;
    const label = document.getElementById('currentUserLabel');
    if (label) {
        label.textContent = '当前客户：无可下单客户';
    }

    const noResults = document.getElementById('noResults');
    const grid = document.getElementById('productsGrid');
    const loading = document.getElementById('loading');
    if (loading) loading.style.display = 'none';
    if (grid) grid.style.display = 'none';
    if (noResults) {
        noResults.style.display = 'block';
        noResults.innerHTML = `
            <i class="fas fa-user-lock"></i>
            <p>${message || '该用户没有可下单的客户'}</p>
            <p style="font-size:12px;color:#999;margin-top:10px;">请联系管理员为当前账号配置可下单客户权限。</p>
        `;
    }

    const checkoutBtn = document.getElementById('checkoutBtn');
    if (checkoutBtn) checkoutBtn.disabled = true;

    const customerSelector = document.getElementById('customerSelector');
    if (customerSelector) customerSelector.style.display = 'none';
}


function getUserNameHeader() {
    return currentUser && currentUser.username ? String(currentUser.username) : '';
}

function normalizeUserCustomers(user) {
    if (!user) return [];
    if (Array.isArray(user.customers) && user.customers.length > 0) {
        return user.customers.map(c => ({
            ...c,
            id: String(c.id),
            assessCustomerId: c.assessCustomerId != null ? String(c.assessCustomerId) : '',
            entryid: c.entryid != null ? String(c.entryid) : (user.entryId != null ? String(user.entryId) : ''),
            inputmanid: c.inputmanid != null ? String(c.inputmanid) : (user.inputManId != null ? String(user.inputManId) : '')
        }));
    }
    if (user.customer && user.customer.id != null) {
        return [{
            ...user.customer,
            id: String(user.customer.id),
            assessCustomerId: user.customer.assessCustomerId != null ? String(user.customer.assessCustomerId) : '',
            entryid: user.entryId != null ? String(user.entryId) : (user.customer.entryid != null ? String(user.customer.entryid) : ''),
            inputmanid: user.inputManId != null ? String(user.inputManId) : (user.customer.inputmanid != null ? String(user.customer.inputmanid) : '')
        }];
    }
    return [];
}

function applyActiveCustomer(customer) {
    if (!customer) return;
    activeCustomer = customer;
    API_CONFIG.defaultValues.erpCustomerId = String(customer.id || API_CONFIG.defaultValues.erpCustomerId);
    API_CONFIG.defaultValues.erpAssessCustomerId = String(customer.assessCustomerId || API_CONFIG.defaultValues.erpAssessCustomerId || '');
    API_CONFIG.defaultValues.supplierId = String(customer.entryid || API_CONFIG.defaultValues.supplierId || '');
    API_CONFIG.defaultValues.inputManId = String(customer.inputmanid || API_CONFIG.defaultValues.inputManId || '');
}

function updateCustomerUI() {
    const label = document.getElementById('currentUserLabel');
    if (label) {
        const customerName = activeCustomer?.name || '未选择客户';
        const inputMan = API_CONFIG.defaultValues.inputManId ? ' 制单人ID:' + API_CONFIG.defaultValues.inputManId : '';
        label.textContent = '当前客户：' + customerName + inputMan;
    }

    const select = document.getElementById('customerSelector');
    if (!select) return;

    if (availableCustomers.length <= 1) {
        select.style.display = 'none';
        return;
    }

    select.style.display = '';
    const current = activeCustomer ? String(activeCustomer.id) : '';
    select.innerHTML = availableCustomers.map(c => `<option value="${c.id}">${c.name || c.id}</option>`).join('');
    if (current) select.value = current;
}

function switchCustomer(customerId) {
    const target = availableCustomers.find(c => String(c.id) === String(customerId));
    if (!target) return;
    applyActiveCustomer(target);
    cart = [];
    saveCart();
    updateCartUI();
    currentCategory = 'all';
    document.getElementById('searchInput').value = '';
    updateCustomerUI();
    loadProducts();
}

// 产品数据（从API加载）
let productsData = [];
let categoriesData = [];

// 购物车数据
let cart = JSON.parse(localStorage.getItem('cart')) || [];
let filteredProducts = [];
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
        if (!p.category) return;
        const parts = p.category.split(' > ').map(s => s.trim()).filter(Boolean);
        if (includeManufacturer && p.manufacturer && String(p.manufacturer).trim()) {
            parts.push(String(p.manufacturer).trim());
        }
        let path = '';
        parts.forEach((part, idx) => {
            path = idx === 0 ? part : path + ' > ' + part;
            counts[path] = (counts[path] || 0) + 1;
        });
    });
    return counts;
}

// 加载产品数据
async function loadProducts() {
    if (!hasOrderableCustomers || !activeCustomer) {
        showNoCustomerPermission('该用户没有可下单的客户');
        return;
    }

    const loading = document.getElementById('loading');
    const grid = document.getElementById('productsGrid');
    const noResults = document.getElementById('noResults');
    
    try {
        loading.style.display = 'block';
        grid.style.display = 'none';
        noResults.style.display = 'none';
        
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        const response = await fetch(`${API_CONFIG.baseUrl}/api/products?customerId=${encodeURIComponent(customerId)}`, {
            headers: {
                'x-user-name': getUserNameHeader()
            }
        });
        if (!response.ok) {
            const msg = response.status === 403 ? '该用户没有可下单的客户或无权访问该客户货品' : `HTTP错误! 状态: ${response.status}`;
            throw new Error(msg);
        }
        
        const result = await response.json();
        if (result.success) {
            productsData = result.data || [];
            // 只显示启用的产品
            productsData = productsData.filter(p => p.status !== 0);
            filteredProducts = [...productsData];
            
            // 初始化分类和渲染产品（使用产品档案中的分类）
            initCategoriesFromProducts();
            filterByCategory(currentCategory);
            renderProducts();
        } else {
            throw new Error(result.message || '加载产品数据失败');
        }
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
            const msg = response.status === 403 ? '该用户没有可下单的客户或无权访问该客户货品' : `HTTP错误! 状态: ${response.status}`;
            throw new Error(msg);
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

// 从产品数据中提取分类（仅保留下拉框；第四级为厂家，过长则缩写显示）
function initCategoriesFromProducts() {
    const extended = new Set();
    productsData.forEach(p => {
        if (!p.category) return;
        extended.add(p.category);
        if (p.manufacturer && String(p.manufacturer).trim()) {
            extended.add(p.category + ' > ' + String(p.manufacturer).trim());
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

// 退出登录
function logout() {
    sessionStorage.removeItem('user');
    window.location.href = 'login.html';
}

// 初始化页面
document.addEventListener('DOMContentLoaded', function() {
    try {
        currentUser = JSON.parse(sessionStorage.getItem('user') || '{}');
    } catch (e) {
        currentUser = {};
    }

    availableCustomers = normalizeUserCustomers(currentUser);
    if (availableCustomers.length === 0) {
        showNoCustomerPermission('该用户没有可下单的客户');
    } else {
        hasOrderableCustomers = true;
        const defaultId = currentUser?.defaultCustomerId ? String(currentUser.defaultCustomerId) : String(availableCustomers[0].id);
        applyActiveCustomer(availableCustomers.find(c => String(c.id) === defaultId) || availableCustomers[0]);
        updateCustomerUI();
    }

    const customerSelector = document.getElementById('customerSelector');
    if (customerSelector && !customerSelector._bound) {
        customerSelector._bound = true;
        customerSelector.addEventListener('change', function() {
            switchCustomer(this.value);
        });
    }

    // 先加载数据
    if (hasOrderableCustomers) {
        loadProducts();
    }
    updateCartUI();
    
    // 搜索框回车事件
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });
    
    // 实时搜索
    document.getElementById('searchInput').addEventListener('input', function(e) {
        if (e.target.value.trim() === '') {
            filteredProducts = [...productsData];
            filterByCategory(currentCategory);
            renderProducts();
        }
    });
    
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
        if (!p.category) return;
        extended.add(p.category);
        if (p.manufacturer && String(p.manufacturer).trim()) {
            extended.add(p.category + ' > ' + String(p.manufacturer).trim());
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
function filterByCategory(category) {
    currentCategory = category;
    const parts = category.split(' > ').map(p => p.trim()).filter(Boolean);
    if (category === 'all') {
        filteredProducts = [...productsData];
    } else if (parts.length === 4) {
        const cat3 = parts[0] + ' > ' + parts[1] + ' > ' + parts[2];
        const manufacturer = parts[3];
        filteredProducts = productsData.filter(p => {
            if (!p.category) return false;
            return (p.category === cat3 || p.category.startsWith(cat3 + ' >')) &&
                   String(p.manufacturer || '').trim() === manufacturer;
        });
    } else {
        filteredProducts = productsData.filter(p => {
            if (!p.category) return false;
            return p.category === category || p.category.startsWith(category + ' >');
        });
    }
    
    const quickSel = document.getElementById('categoryQuickSelect');
    if (quickSel) quickSel.value = category;
    
    const displayTitle = parts.length === 4
        ? parts[0] + ' > ' + parts[1] + ' > ' + parts[2] + ' > ' + abbreviateManufacturer(parts[3])
        : category;
    document.getElementById('sectionTitle').textContent = category === 'all' ? '全部产品' : displayTitle;
    
    applySort();
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
        
        const customerId = API_CONFIG.defaultValues.erpCustomerId || '7522';
        const response = await fetch(`${API_CONFIG.baseUrl}/api/products?customerId=${encodeURIComponent(customerId)}&search=${encodeURIComponent(searchTerm)}`, {
            headers: {
                'x-user-name': getUserNameHeader()
            }
        });
        if (!response.ok) {
            const msg = response.status === 403 ? '该用户没有可下单的客户或无权访问该客户货品' : `HTTP错误! 状态: ${response.status}`;
            throw new Error(msg);
        }
        
        const result = await response.json();
        if (result.success) {
            filteredProducts = (result.data || []).filter(p => p.status !== 0);
            document.getElementById('sectionTitle').textContent = `搜索结果: "${searchTerm}" (${filteredProducts.length}个)`;
            applySort();
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
    renderProducts();
    } finally {
        document.getElementById('loading').style.display = 'none';
    }
}

// 排序产品
function sortProducts() {
    currentSort = document.getElementById('sortSelect').value;
    applySort();
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

// 渲染产品列表
function renderProducts() {
    const grid = document.getElementById('productsGrid');
    const loading = document.getElementById('loading');
    const noResults = document.getElementById('noResults');
    
    if (filteredProducts.length === 0) {
        grid.style.display = 'none';
        loading.style.display = 'none';
        noResults.style.display = 'block';
        return;
    }
    
    grid.style.display = 'grid';
    loading.style.display = 'none';
    noResults.style.display = 'none';
    
    grid.innerHTML = filteredProducts.map(product => `
        <div class="product-card">
            <div class="product-info">
                <span class="product-category">${product.category || '未分类'}</span>
                <h3 class="product-name">${product.name}</h3>
                ${product.operationCode ? `<p class="product-operation-code" style="font-size: 12px; color: #2563eb; margin-top: 4px; font-weight: 600;"><i class="fas fa-barcode"></i> 操作码: ${product.operationCode}</p>` : ''}
                ${product.spec ? `<p class="product-spec">${product.spec}</p>` : ''}
                ${product.manufacturer ? `<p class="product-manufacturer"><i class="fas fa-industry"></i> ${product.manufacturer}</p>` : ''}
                ${product.brand ? `<p class="product-brand" style="font-size: 12px; color: #666; margin-top: 4px;"><i class="fas fa-tag"></i> ${product.brand}</p>` : ''}
            </div>
            <div class="product-bottom">
                <div class="product-price">¥${(product.price || 0).toFixed(2)}</div>
                <button class="add-to-cart-btn" onclick="addToCart(${product.id})">
                    <i class="fas fa-cart-plus"></i> 加入购物车
                </button>
            </div>
        </div>
    `).join('');
}


// 添加到购物车
function addToCart(productId) {
    const product = productsData.find(p => p.id === productId);
    if (!product) return;
    
    const existingItem = cart.find(item => item.id === productId);
    
    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({
            ...product,
            quantity: 1
        });
    }
    
    saveCart();
    updateCartUI();
    showToast(`${product.name} 已加入购物车`);
}

// 更新购物车UI
function updateCartUI() {
    const cartBadge = document.getElementById('cartBadge');
    const cartItems = document.getElementById('cartItems');
    const emptyCart = document.getElementById('emptyCart');
    const totalPrice = document.getElementById('totalPrice');
    const checkoutBtn = document.getElementById('checkoutBtn');
    
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    
    cartBadge.textContent = totalItems;
    totalPrice.textContent = `¥${total.toFixed(2)}`;
    checkoutBtn.disabled = cart.length === 0;
    
    if (cart.length === 0) {
        emptyCart.style.display = 'block';
        cartItems.innerHTML = '';
    } else {
        emptyCart.style.display = 'none';
        cartItems.innerHTML = cart.map(item => {
            const product = productsData.find(p => p.id == item.id);
            const maxQty = (product && product.stock != null && Number(product.stock) > 0) ? Number(product.stock) : 9999;
            const safeId = typeof item.id === 'string' ? JSON.stringify(item.id) : item.id;
            return `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.name}</div>
                    <div class="cart-item-spec">${item.spec}</div>
                    <div class="cart-item-manufacturer"><i class="fas fa-industry"></i> ${item.manufacturer}</div>
                    <div class="cart-item-price">¥${item.price.toFixed(2)} × ${item.quantity} = ¥${(item.price * item.quantity).toFixed(2)}</div>
                    <div class="cart-item-controls">
                        <button class="quantity-btn" onclick="updateQuantity(${safeId}, ${item.quantity - 1})">-</button>
                        <input type="number" class="quantity-input" value="${item.quantity}" 
                               min="1" max="${maxQty}" 
                               onchange="updateQuantity(${safeId}, parseInt(this.value, 10))">
                        <button class="quantity-btn" onclick="updateQuantity(${safeId}, ${item.quantity + 1})">+</button>
                        <button class="remove-btn" onclick="removeFromCart(${safeId})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        }).join('');
    }
}

// 更新数量（支持修改为 1～库存上限，无库存限制时上限 9999）
function updateQuantity(productId, newQuantity) {
    const item = cart.find(item => item.id == productId);
    if (!item) return;
    
    const product = productsData.find(p => p.id == productId);
    const maxQty = (product && product.stock != null && Number(product.stock) > 0)
        ? Number(product.stock)
        : 9999;
    newQuantity = Math.max(1, Math.min(Math.floor(Number(newQuantity) || 1), maxQty));
    
    if (newQuantity === 0) {
        removeFromCart(productId);
    } else {
        item.quantity = newQuantity;
        saveCart();
        updateCartUI();
    }
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

// 保存购物车到本地存储
function saveCart() {
    localStorage.setItem('cart', JSON.stringify(cart));
}

// 结账
function checkout() {
    if (!hasOrderableCustomers || !activeCustomer) {
        showToast('该用户没有可下单的客户', 'warning');
        return;
    }

    if (cart.length === 0) {
        showToast('购物车是空的');
        return;
    }
    
    const modal = document.getElementById('modalOverlay');
    const summary = document.getElementById('orderSummary');
    
    // 生成订单摘要
    summary.innerHTML = cart.map(item => `
        <div class="summary-item">
            <span>${item.name} × ${item.quantity}</span>
            <span>¥${(item.price * item.quantity).toFixed(2)}</span>
        </div>
    `).join('') + `
        <div class="summary-item" style="margin-top: 1rem; padding-top: 1rem; border-top: 2px solid var(--border-color); font-weight: 700; font-size: 1.1rem;">
            <span>总计</span>
            <span style="color: var(--primary-color);">¥${cart.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2)}</span>
        </div>
    `;
    
    // 清空表单
    document.getElementById('orderForm').reset();
    
    modal.classList.add('show');
}

// 关闭模态框
function closeModal() {
    document.getElementById('modalOverlay').classList.remove('show');
}

// 构造海尔施ERP格式的订单数据
function buildERPOrderData(customerInfo, cartItems) {
    // 生成订单编号：格式类似 "HBS-120260121061"
    // 格式：HBS- + YYMMDD + HHMMSS（后6位）
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2); // 年份后两位
    const month = String(now.getMonth() + 1).padStart(2, '0'); // 月份
    const day = String(now.getDate()).padStart(2, '0'); // 日期
    const hour = String(now.getHours()).padStart(2, '0'); // 小时
    const minute = String(now.getMinutes()).padStart(2, '0'); // 分钟
    const second = String(now.getSeconds()).padStart(2, '0'); // 秒
    const orderNo = `HBS-${year}${month}${day}${hour}${minute}${second}`; // 例如：HBS-260121121530
    // 订单日期格式：YYYY-MM-DD HH:mm:ss（包含时间部分，时间设为 00:00:00）
    const orderDate = `${now.getFullYear()}-${month}-${day} 00:00:00`;
    
    // 构造订单细单列表
    const detailList = cartItems.map((item, index) => ({
        conno: orderNo,
        connodtlid: item.id.toString(), // 数据ID，使用产品ID
        goodsid: (item.erpGoodsId || item.id).toString(), // ERP货品ID（优先使用erpGoodsId，如果没有则使用产品ID）
        goodsqty: item.quantity.toString(), // 订单细单采购数量
        dtlmemo: item.spec || '' // 备注：批号要求，使用规格信息
    }));
    
    // 构造ERP订单数据
    const erpOrderData = {
        businessType: API_CONFIG.defaultValues.businessType,
        conno: orderNo,
        customid: (activeCustomer && activeCustomer.id) ? String(activeCustomer.id) : API_CONFIG.defaultValues.erpCustomerId,
        memo: customerInfo.notes || customerInfo.org || '', // 订单总单备注
        credate: orderDate,
        entryid: (activeCustomer && activeCustomer.entryid) ? String(activeCustomer.entryid) : API_CONFIG.defaultValues.supplierId,
        inputmanid: (activeCustomer && activeCustomer.inputmanid) ? String(activeCustomer.inputmanid) : API_CONFIG.defaultValues.inputManId,
        assesscustomid: (activeCustomer && activeCustomer.assessCustomerId) ? String(activeCustomer.assessCustomerId) : API_CONFIG.defaultValues.erpAssessCustomerId,
        detailList: detailList // 订单明细列表（必须包含）
    };
    
    // 验证detailList
    if (!detailList || detailList.length === 0) {
        console.error('❌ 错误: detailList为空，无法提交订单');
        throw new Error('订单明细不能为空');
    }
    
    console.log(`订单包含 ${detailList.length} 个明细项:`, detailList);
    
    return erpOrderData;
}

// 提交订单
function submitOrder(event) {
    if (!hasOrderableCustomers || !activeCustomer) {
        showToast('该用户没有可下单的客户', 'warning');
        return false;
    }

    // 阻止表单默认提交行为和事件冒泡
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const form = document.getElementById('orderForm');
    
    if (!form.checkValidity()) {
        form.reportValidity();
        return false;
    }
    
    const customerInfo = {
            name: document.getElementById('customerName').value,
            phone: document.getElementById('customerPhone').value,
            org: document.getElementById('customerOrg').value,
            address: document.getElementById('customerAddress').value,
            notes: document.getElementById('orderNotes').value
    };
    
    const orderData = {
        customer: customerInfo,
        items: cart.map(item => ({
            id: item.id,
            name: item.name,
            spec: item.spec,
            price: item.price,
            quantity: item.quantity
        })),
        total: cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
        date: new Date().toISOString()
    };
    
    // 构造ERP格式数据
    const erpOrderData = buildERPOrderData(customerInfo, cart);
    
    console.log('订单数据:', orderData);
    console.log('ERP格式数据:', erpOrderData);
    
    // 显示加载状态
    const submitBtn = document.querySelector('.btn-primary');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...';
    
    // 发送到同步接口（带超时控制）
    console.log('正在发送到:', API_CONFIG.syncUrl);
    
    // 创建超时Promise
    const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
            reject(new Error('请求超时，请检查服务器是否已启动'));
        }, API_CONFIG.timeout);
    });
    
    // 创建请求Promise
    const fetchPromise = fetch(API_CONFIG.syncUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-user-name': getUserNameHeader(),
            'x-customer-id': activeCustomer ? String(activeCustomer.id) : ''
        },
        body: JSON.stringify(erpOrderData)
    });
    
    // 使用 Promise.race 实现超时控制
    Promise.race([fetchPromise, timeoutPromise])
    .then(response => {
        const httpStatus = response.status;
        if (!response.ok) {
            const msg = response.status === 403 ? '该用户没有可下单的客户或无权访问该客户货品' : `HTTP错误! 状态: ${response.status}`;
            throw new Error(msg);
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
        updateCartUI();
        
        // 关闭模态框
        closeModal();
        
        // 显示成功消息
        if (data.success) {
            showToast('订单提交成功！数据已同步到海尔施ERP。', 'success');
        } else {
            showToast('订单已提交，但ERP同步可能存在问题。', 'warning');
        }
        
        // 导出订单数据（保留本地备份）
        exportOrderData(orderData);
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
        
        // 即使接口失败，也保存本地数据
        exportOrderData(orderData);
        
        // 显示详细错误消息
        const fullMessage = errorMessage + '\n\n订单数据已导出到本地文件。';
        alert(fullMessage);
        
        // 询问用户是否继续
        if (confirm('接口调用失败，是否仍要清空购物车？\n订单数据已导出到本地。')) {
            cart = [];
            saveCart();
            updateCartUI();
            closeModal();
        }
    })
    .finally(() => {
        // 恢复按钮状态
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
    });
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

// 保存订单到历史记录（包含详细的接收状态）
function saveOrderToHistory(orderData, erpOrderData, responseData) {
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory')) || [];
    
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
    
    const historyItem = {
        id: Date.now(),
        orderNo: erpOrderData.conno,
        date: new Date().toISOString(),
        customer: orderData.customer,
        items: orderData.items,
        total: orderData.total,
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
    
    localStorage.setItem('orderHistory', JSON.stringify(orderHistory));
}

// 显示历史订单
function showOrderHistory() {
    const modal = document.getElementById('orderHistoryModal');
    modal.style.display = 'flex';
    loadOrderHistory();
}

// 关闭历史订单
function closeOrderHistory() {
    document.getElementById('orderHistoryModal').style.display = 'none';
}

// 加载历史订单
function loadOrderHistory() {
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory')) || [];
    const historyList = document.getElementById('orderHistoryList');
    
    if (orderHistory.length === 0) {
        historyList.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                <i class="fas fa-inbox" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;"></i>
                <p>暂无历史订单</p>
            </div>
        `;
        return;
    }
    
    historyList.innerHTML = orderHistory.map(order => {
        const date = new Date(order.date);
        
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
                            ¥${order.total.toFixed(2)}
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
                    <p style="margin: 0.25rem 0;"><strong>客户:</strong> ${order.customer.name}</p>
                    <p style="margin: 0.25rem 0;"><strong>单位:</strong> ${order.customer.org}</p>
                    <p style="margin: 0.25rem 0;"><strong>电话:</strong> ${order.customer.phone}</p>
                    <p style="margin: 0.25rem 0;"><strong>地址:</strong> ${order.customer.address}</p>
                </div>
                
                <div style="margin-bottom: 1rem;">
                    <strong>订单明细 (${order.items.length}项):</strong>
                    <div style="margin-top: 0.5rem;">
                        ${order.items.map(item => `
                            <div style="padding: 0.5rem; background: white; margin-bottom: 0.25rem; border-radius: var(--radius);">
                                ${item.name} × ${item.quantity} = ¥${(item.price * item.quantity).toFixed(2)}
                            </div>
                        `).join('')}
                    </div>
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
                </div>
            </div>
        `;
    }).join('');
}

// 筛选历史订单
function filterOrderHistory() {
    const searchTerm = document.getElementById('orderSearchInput').value.toLowerCase().trim();
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory')) || [];
    const historyList = document.getElementById('orderHistoryList');
    
    if (!searchTerm) {
        loadOrderHistory();
        return;
    }
    
    const filtered = orderHistory.filter(order => 
        order.orderNo.toLowerCase().includes(searchTerm) ||
        order.customer.name.toLowerCase().includes(searchTerm) ||
        order.customer.org.toLowerCase().includes(searchTerm) ||
        order.customer.phone.includes(searchTerm)
    );
    
    if (filtered.length === 0) {
        historyList.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                <i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;"></i>
                <p>未找到匹配的订单</p>
            </div>
        `;
        return;
    }
    
    // 使用相同的渲染逻辑，但只显示筛选结果
    historyList.innerHTML = filtered.map(order => {
        const date = new Date(order.date);
        
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
                            ¥${order.total.toFixed(2)}
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
                    <p style="margin: 0.25rem 0;"><strong>客户:</strong> ${order.customer.name}</p>
                    <p style="margin: 0.25rem 0;"><strong>单位:</strong> ${order.customer.org}</p>
                    <p style="margin: 0.25rem 0;"><strong>电话:</strong> ${order.customer.phone}</p>
                    <p style="margin: 0.25rem 0;"><strong>地址:</strong> ${order.customer.address}</p>
                </div>
                
                <div style="margin-bottom: 1rem;">
                    <strong>订单明细 (${order.items.length}项):</strong>
                    <div style="margin-top: 0.5rem;">
                        ${order.items.map(item => `
                            <div style="padding: 0.5rem; background: white; margin-bottom: 0.25rem; border-radius: var(--radius);">
                                ${item.name} × ${item.quantity} = ¥${(item.price * item.quantity).toFixed(2)}
                            </div>
                        `).join('')}
                    </div>
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
                </div>
            </div>
        `;
    }).join('');
}

// 导出单个订单
function exportOrderHistory(orderId) {
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory')) || [];
    const order = orderHistory.find(o => o.id === orderId);
    
    if (!order) {
        showToast('订单不存在', 'error');
        return;
    }
    
    exportOrderData({
        customer: order.customer,
        items: order.items,
        total: order.total,
        date: order.date,
        orderNo: order.orderNo,
        erpData: order.erpData,
        response: order.response
    });
    
    showToast('订单已导出', 'success');
}

// 查看订单详情
function viewOrderDetail(orderId) {
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory')) || [];
    const order = orderHistory.find(o => o.id === orderId);
    
    if (!order) {
        showToast('订单不存在', 'error');
        return;
    }
    
    const detail = `
订单编号: ${order.orderNo}
下单时间: ${new Date(order.date).toLocaleString('zh-CN')}
订单状态: ${order.status === 'success' ? '成功' : '警告'}

客户信息:
  姓名: ${order.customer.name}
  单位: ${order.customer.org}
  电话: ${order.customer.phone}
  地址: ${order.customer.address}
  备注: ${order.customer.notes || '无'}

订单明细:
${order.items.map((item, index) => `  ${index + 1}. ${item.name} (${item.spec})
     数量: ${item.quantity} × ¥${item.price.toFixed(2)} = ¥${(item.price * item.quantity).toFixed(2)}`).join('\n')}

订单总额: ¥${order.total.toFixed(2)}

ERP数据:
${JSON.stringify(order.erpData, null, 2)}

服务器响应:
${JSON.stringify(order.response, null, 2)}
    `;
    
    alert(detail);
}
