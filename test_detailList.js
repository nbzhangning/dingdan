// 测试detailList的完整数据格式
const http = require('http');

// 测试数据 - 包含完整的detailList
const testData = {
    "businessType": "DS01",
    "conno": "HBS-120260127088",
    "customid": "7016",
    "memo": "",
    "credate": "2026-01-27 00:00:00",
    "entryid": "1",
    "inputmanid": "9631",
    "assesscustomid": "656",
    "detailList": [
        {
            "conno": "HBS-120260127088",
            "connodtlid": "2300018756177377",
            "goodsid": "6770",
            "goodsqty": "5",
            "dtlmemo": ""
        }
    ]
};

console.log('测试数据（包含detailList）:');
console.log(JSON.stringify(testData, null, 2));
console.log('\n验证detailList:');
console.log(`- detailList是否存在: ${testData.detailList ? '是' : '否'}`);
console.log(`- detailList是否为数组: ${Array.isArray(testData.detailList) ? '是' : '否'}`);
console.log(`- detailList数量: ${testData.detailList ? testData.detailList.length : 0}`);
if (testData.detailList && testData.detailList.length > 0) {
    testData.detailList.forEach((detail, index) => {
        console.log(`- 明细[${index}]: goodsid=${detail.goodsid}, goodsqty=${detail.goodsqty}, conno=${detail.conno}`);
    });
}

console.log('\n正在发送请求到本地服务器...\n');

const postData = JSON.stringify(testData);

const options = {
    hostname: 'localhost',
    port: 3330,
    path: '/receive_data',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 30000
};

const req = http.request(options, (res) => {
    let responseData = '';

    console.log(`状态码: ${res.statusCode}`);
    console.log(`响应头:`, res.headers);
    console.log('\n响应内容:');

    res.on('data', (chunk) => {
        responseData += chunk.toString();
    });

    res.on('end', () => {
        try {
            const jsonResponse = JSON.parse(responseData);
            console.log(JSON.stringify(jsonResponse, null, 2));
            
            // 验证响应
            if (jsonResponse.success) {
                console.log('\n✅ 请求成功！');
                if (jsonResponse.erpResult) {
                    console.log('✅ ERP同步成功');
                } else if (jsonResponse.error) {
                    console.log('⚠️ ERP同步失败，但数据已保存');
                }
            } else {
                console.log('\n❌ 请求失败:', jsonResponse.message);
            }
        } catch (e) {
            console.log(responseData);
        }
    });
});

req.on('error', (error) => {
    console.error('请求错误:', error.message);
    if (error.code === 'ECONNREFUSED') {
        console.error('\n错误: 无法连接到服务器');
        console.error('请确保服务器已启动: node server.js');
    }
});

req.on('timeout', () => {
    console.error('请求超时');
    req.destroy();
});

req.write(postData);
req.end();








