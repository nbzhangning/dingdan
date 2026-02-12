// 从Excel文件导入货品数据
const { getProducts, saveProducts, getCategories, saveCategories } = require('./productManager');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Excel文件路径
const excelFile = path.join(__dirname, '货品价格管理_20260205092543.xlsx');

console.log('开始从Excel文件导入货品数据...');
console.log('文件路径:', excelFile);

// 检查文件是否存在
if (!fs.existsSync(excelFile)) {
    console.error('❌ 错误: Excel文件不存在:', excelFile);
    process.exit(1);
}

// 读取Excel文件
let workbook;
try {
    workbook = XLSX.readFile(excelFile);
    console.log('✅ Excel文件读取成功');
    console.log('工作表列表:', workbook.SheetNames);
} catch (error) {
    console.error('❌ 读取Excel文件失败:', error.message);
    process.exit(1);
}

// 获取第一个工作表（或指定工作表）
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

// 将工作表转换为JSON
const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
    defval: '', // 空单元格的默认值
    raw: false  // 不保留原始值，转换为字符串
});

console.log(`\n读取到 ${jsonData.length} 行数据`);
console.log('列名:', Object.keys(jsonData[0] || {}));
console.log('\n前3行数据示例:');
jsonData.slice(0, 3).forEach((row, index) => {
    console.log(`第${index + 1}行:`, JSON.stringify(row, null, 2));
});

// 解析数据并导入
const existingProducts = getProducts();
const existingCategories = getCategories();
const existingErpGoodsIds = new Set(existingProducts.map(p => p.erpGoodsId).filter(id => id));

// 分类映射（用于存储分类ID）
const categoryMap = new Map();
existingCategories.forEach(cat => {
    categoryMap.set(cat.name, cat.id);
});

let imported = 0;
let skipped = 0;
let errors = 0;
const newCategories = new Set();

// 处理每一行数据
jsonData.forEach((row, index) => {
    try {
        // 根据Excel实际列名提取数据
        const productName = String(row['货品名称'] || '').trim();
        const erpGoodsId = String(row['ERP货品ID'] || '').trim();
        const operationCode = String(row['货品操作码'] || '').trim();
        const category1 = String(row['货品一级分类'] || '').trim();
        const category2 = String(row['货品二级分类'] || '').trim();
        const category3 = String(row['货品三级分类'] || '').trim();
        
        // 处理价格（格式可能是 "2000.00元"，需要提取数字）
        let priceStr = String(row['货品单价'] || '0').trim();
        priceStr = priceStr.replace(/[^\d.]/g, ''); // 移除所有非数字字符（保留小数点）
        const price = parseFloat(priceStr) || 0;
        
        const spec = String(row['货品规格'] || '').trim();
        
        // 处理厂家（格式可能是 "厂家名称|ID"，只取名称部分）
        let manufacturer = String(row['货品生产厂家'] || '').trim();
        if (manufacturer.includes('|')) {
            manufacturer = manufacturer.split('|')[0].trim();
        }
        
        const unit = String(row['货品单位'] || '件').trim();
        const brand = String(row['货品品牌'] || '').trim();
        const status = String(row['货品状态（对接）'] || '正常').trim();

        // 验证必填字段
        if (!productName || !erpGoodsId) {
            console.warn(`⚠️ 第${index + 2}行跳过: 缺少必填字段（货品名称: "${productName}", ERP货品ID: "${erpGoodsId}"）`);
            skipped++;
            return;
        }
        
        // 只导入状态为"正常"的货品
        if (status !== '正常') {
            console.log(`跳过: ${productName} (状态: ${status})`);
            skipped++;
            return;
        }

        // 检查是否已存在（根据ERP货品ID）
        if (existingErpGoodsIds.has(erpGoodsId)) {
            console.log(`跳过: ${productName} (ERP货品ID: ${erpGoodsId} 已存在)`);
            skipped++;
            return;
        }

        // 构建分类名称（一级/二级/三级）
        let categoryName = '';
        let categoryPath = '';
        if (category1) {
            categoryPath = category1;
            if (category2) {
                categoryPath += ' > ' + category2;
                if (category3) {
                    categoryPath += ' > ' + category3;
                }
            }
            categoryName = categoryPath;
        } else {
            categoryName = '未分类';
        }

        // 确保分类存在
        let categoryId = categoryMap.get(categoryName);
        if (!categoryId && categoryName !== '未分类') {
            // 创建新分类
            const newCategoryId = existingCategories.length > 0 
                ? Math.max(...existingCategories.map(c => c.id)) + 1 
                : 1;
            const newCategory = {
                id: newCategoryId,
                name: categoryName,
                description: `从Excel导入: ${categoryPath}`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            existingCategories.push(newCategory);
            categoryMap.set(categoryName, newCategoryId);
            categoryId = newCategoryId;
            newCategories.add(categoryName);
            console.log(`创建新分类: ${categoryName}`);
        }

        // 创建货品对象
        const newProduct = {
            id: existingProducts.length > 0 
                ? Math.max(...existingProducts.map(p => p.id)) + 1 
                : 1,
            name: productName,
            category: categoryName,
            categoryId: categoryId || null,
            spec: spec,
            price: price || 0,
            stock: 0, // 默认库存为0
            manufacturer: manufacturer,
            brand: brand || '', // 品牌
            erpGoodsId: erpGoodsId, // ERP货品ID（重要：用于订单同步，接口抛送时使用此字段）
            operationCode: operationCode || '', // 操作码
            unit: unit || '件',
            description: `ERP货品ID: ${erpGoodsId}${operationCode ? ', 操作码: ' + operationCode : ''}${brand ? ', 品牌: ' + brand : ''}`,
            status: 1, // 启用
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        existingProducts.push(newProduct);
        existingErpGoodsIds.add(erpGoodsId);
        imported++;
        console.log(`✅ 导入: ${productName} (ERP货品ID: ${erpGoodsId}, 分类: ${categoryName})`);
    } catch (error) {
        console.error(`❌ 第${index + 2}行处理失败:`, error.message);
        errors++;
    }
});

// 保存数据
console.log('\n正在保存数据...');

if (saveCategories(existingCategories)) {
    console.log('✅ 分类数据保存成功');
} else {
    console.error('❌ 分类数据保存失败');
}

if (saveProducts(existingProducts)) {
    console.log('✅ 货品数据保存成功');
} else {
    console.error('❌ 货品数据保存失败');
    process.exit(1);
}

// 输出统计信息
console.log('\n========================================');
console.log('导入完成！');
console.log('========================================');
console.log(`成功导入: ${imported} 个货品`);
console.log(`跳过: ${skipped} 个货品（已存在或缺少必填字段）`);
console.log(`错误: ${errors} 个货品`);
if (newCategories.size > 0) {
    console.log(`新建分类: ${newCategories.size} 个`);
    console.log('分类列表:', Array.from(newCategories).join(', '));
}
console.log('========================================');

