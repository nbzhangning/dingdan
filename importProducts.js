// 导入示例货品数据
const { getProducts, saveProducts } = require('./productManager');
const fs = require('fs');
const path = require('path');

// 示例货品数据（从script.js中提取）
const sampleProducts = [
    {
        name: '一次性医用口罩',
        category: '防护用品',
        spec: '三层防护，50只/盒',
        price: 28.00,
        stock: 1000,
        manufacturer: '3M中国有限公司',
        erpGoodsId: '28075',
        unit: '盒',
        description: '一次性医用口罩，三层防护',
        status: 1
    },
    {
        name: '医用外科手套',
        category: '防护用品',
        spec: '一次性，100只/盒',
        price: 35.00,
        stock: 800,
        manufacturer: '稳健医疗用品股份有限公司',
        erpGoodsId: '28076',
        unit: '盒',
        description: '医用外科手套，一次性使用',
        status: 1
    },
    {
        name: 'PCR试剂盒',
        category: '检测试剂',
        spec: '96孔，核酸检测专用',
        price: 580.00,
        stock: 200,
        manufacturer: '华大基因科技股份有限公司',
        erpGoodsId: '28077',
        unit: '盒',
        description: 'PCR试剂盒，96孔，核酸检测专用',
        status: 1
    },
    {
        name: '一次性注射器',
        category: '注射器械',
        spec: '5ml，无菌独立包装',
        price: 10.50,
        stock: 5000,
        manufacturer: 'BD医疗技术（上海）有限公司',
        erpGoodsId: '28078',
        unit: '支',
        description: '一次性注射器，5ml，无菌独立包装',
        status: 1
    },
    {
        name: '医用酒精消毒液',
        category: '消毒用品',
        spec: '75%浓度，500ml/瓶',
        price: 12.00,
        stock: 600,
        manufacturer: '利尔康医疗科技股份有限公司',
        erpGoodsId: '28079',
        unit: '瓶',
        description: '医用酒精消毒液，75%浓度',
        status: 1
    }
];

console.log('开始导入示例货品数据...');

const existingProducts = getProducts();
const existingNames = new Set(existingProducts.map(p => p.name));

let imported = 0;
let skipped = 0;

sampleProducts.forEach(product => {
    if (existingNames.has(product.name)) {
        console.log(`跳过: ${product.name} (已存在)`);
        skipped++;
        return;
    }

    const newProduct = {
        id: existingProducts.length > 0 
            ? Math.max(...existingProducts.map(p => p.id)) + 1 
            : 1,
        ...product,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    existingProducts.push(newProduct);
    existingNames.add(product.name);
    imported++;
    console.log(`导入: ${product.name}`);
});

if (saveProducts(existingProducts)) {
    console.log(`\n导入完成！`);
    console.log(`成功导入: ${imported} 个货品`);
    console.log(`跳过: ${skipped} 个货品（已存在）`);
} else {
    console.error('保存失败！');
    process.exit(1);
}









