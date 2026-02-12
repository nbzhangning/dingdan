// 测试接口脚本
const http = require('http');

// 测试数据 - 符合海尔施ERP格式
// 生成订单编号：格式类似 "HBS-120260121061"
const now = new Date();
const year = String(now.getFullYear()).slice(-2);
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const hour = String(now.getHours()).padStart(2, '0');
const minute = String(now.getMinutes()).padStart(2, '0');
const second = String(now.getSeconds()).padStart(2, '0');
const orderNo = `HBS-${year}${month}${day}${hour}${minute}${second}`;

const testData = {
    businessType: "DS01",
    conno: orderNo,
    customid: "26794",
    memo: "",
    credate: `${now.getFullYear()}-${month}-${day} 00:00:00`, // YYYY-MM-DD HH:mm:ss格式
    entryid: "2",
    inputmanid: "11652",
    assesscustomid: "7103",
    detailList: [
        {
            conno: orderNo,
            connodtlid: "2300018651600649",
            goodsid: "2553",
            goodsqty: "2",
            dtlmemo: ""
        }
    ]
};

console.log('准备发送测试数据:');
console.log(JSON.stringify(testData, null, 2));
console.log('\n正在发送请求...\n');

// 发送POST请求
const postData = JSON.stringify(testData);

const options = {
    hostname: 'localhost',  // 本地开发使用 localhost
    port: 3330,  // 本地服务器端口
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
    } else if (error.code === 'ETIMEDOUT') {
        console.error('\n错误: 请求超时');
    }
});

req.on('timeout', () => {
    console.error('请求超时');
    req.destroy();
});

req.write(postData);
req.end();

