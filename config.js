// API配置 - 可以在这里修改接口地址
// 如果需要在浏览器控制台修改，可以执行：
// localStorage.setItem('api_sync_url', 'http://你的服务器地址:5030/receive_data');

window.API_CONFIG_OVERRIDE = {
    // 取消注释并修改下面的地址来覆盖默认配置
    // syncUrl: 'http://60.12.218.220:5030/receive_data',
    // syncUrl: 'http://localhost:5030/receive_data',
};

// 客户和供应商信息配置（未登录时的默认值；登录后由登录用户覆盖）
window.CUSTOMER_CONFIG = {
    // 客户信息
    customer: {
        name: '温岭市第一人民医院（J）',
        id: '7522',
        assessCustomerId: '858' // ERP考核客户ID（从Excel数据中获取）
    },
    // 供应商信息
    supplier: {
        name: '浙江海尔施医疗设备有限公司',
        id: '2'
    },
    // 制单人ID（按客户配置：温岭=9631，其他客户可在此修改）
    inputManId: '9631'
};



