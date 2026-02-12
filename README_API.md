# 海尔施ERP数据同步接口文档

## 接口说明

本服务提供数据接收接口，用于同步订单细单数据到海尔施ERP系统。

## 服务配置

- **服务端口**: 5030
- **接收接口**: `POST http://60.12.218.220:5030/receive_data`
- **目标ERP地址**: `http://60.12.218.220:6881/npserver/DSOrder`
- **旧地址（备用）**: `http://101.71.121.242:6881/hessw_webservice_4.3.33/DSOrder`

## API接口

### 1. 接收订单数据接口

**接口地址**: `POST /receive_data`

**请求头**:
```
Content-Type: application/json
```

**请求体格式** (JSON):
```json
{
  "businessType": "DS01",
  "conno": "订单总单编号",
  "customid": "ERP客户ID",
  "memo": "订单总单备注",
  "credate": "订单总单下单日期",
  "entryid": "供应商id",
  "inputmanid": "制单人ID",
  "assesscustomid": "ERP考核客户ID",
  "detailList": [
    {
      "conno": "订单总单编号",
      "connodtlid": "数据ID",
      "goodsid": "ERP货品ID",
      "goodsqty": "订单细单采购数量",
      "dtlmemo": "备注：批号要求"
    }
  ]
}
```

**字段说明**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| businessType | String | 是 | 业务类型，固定值 "DS01" |
| conno | String | 是 | 订单总单编号 |
| customid | String | 是 | ERP客户ID |
| memo | String | 否 | 订单总单备注 |
| credate | String | 是 | 订单总单下单日期，格式：YYYY-MM-DD |
| entryid | String | 是 | 供应商id |
| inputmanid | String | 是 | 制单人ID |
| assesscustomid | String | 是 | ERP考核客户ID |
| detailList | Array | 是 | 订单细单列表 |
| detailList[].conno | String | 是 | 订单总单编号（与主单一致） |
| detailList[].connodtlid | String | 是 | 数据ID（细单唯一标识） |
| detailList[].goodsid | String | 是 | ERP货品ID |
| detailList[].goodsqty | String | 是 | 订单细单采购数量 |
| detailList[].dtlmemo | String | 否 | 备注：批号要求 |

**响应格式**:
```json
{
  "success": true,
  "message": "数据接收成功并已同步到ERP",
  "dataId": 1234567890,
  "erpResult": {
    "statusCode": 200,
    "response": "ERP返回内容"
  }
}
```

**错误响应**:
```json
{
  "success": false,
  "message": "错误信息"
}
```

### 2. 查询接收数据接口

**接口地址**: `GET /get_data`

**查询参数**:
- `id` (可选): 数据ID，不传则返回所有数据

**响应格式**:
```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "id": 1234567890,
      "receivedAt": "2024-01-01T12:00:00.000Z",
      "data": { ... }
    }
  ]
}
```

### 3. 健康检查接口

**接口地址**: `GET /health`

**响应格式**:
```json
{
  "status": "ok",
  "service": "海尔施ERP数据同步服务",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "receivedCount": 10
}
```

## 使用示例

### JavaScript (前端)

```javascript
const orderData = {
  businessType: "DS01",
  conno: "ORD20240101001",
  customid: "C001",
  memo: "订单备注信息",
  credate: "2024-01-01",
  entryid: "S001",
  inputmanid: "U001",
  assesscustomid: "AC001",
  detailList: [
    {
      conno: "ORD20240101001",
      connodtlid: "1",
      goodsid: "G001",
      goodsqty: "10",
      dtlmemo: "批号要求：20240101"
    }
  ]
};

fetch('http://60.12.218.220:5030/receive_data', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(orderData)
})
.then(response => response.json())
.then(data => {
  console.log('同步成功:', data);
})
.catch(error => {
  console.error('同步失败:', error);
});
```

### cURL

```bash
curl -X POST http://60.12.218.220:5030/receive_data \
  -H "Content-Type: application/json" \
  -d '{
    "businessType": "DS01",
    "conno": "ORD20240101001",
    "customid": "C001",
    "memo": "订单备注",
    "credate": "2024-01-01",
    "entryid": "S001",
    "inputmanid": "U001",
    "assesscustomid": "AC001",
    "detailList": [{
      "conno": "ORD20240101001",
      "connodtlid": "1",
      "goodsid": "G001",
      "goodsqty": "10",
      "dtlmemo": "批号要求"
    }]
  }'
```

## 启动服务

### 方式一：使用Node.js

```bash
# 安装依赖（如果需要）
npm install

# 启动服务
npm start
# 或
node server.js
```

### 方式二：使用PM2（生产环境推荐）

```bash
# 安装PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name erp-sync-server

# 查看状态
pm2 status

# 查看日志
pm2 logs erp-sync-server
```

## 配置说明

在 `server.js` 文件中可以修改以下配置：

```javascript
const CONFIG = {
    port: 5030,  // 服务端口
    targetUrl: 'http://60.12.218.220:6881/npserver/DSOrder',  // 目标ERP地址
    oldUrl: 'http://101.71.121.242:6881/hessw_webservice_4.3.33/DSOrder'  // 备用地址
};
```

## 注意事项

1. **数据格式**: 所有数量字段（goodsqty）需要以字符串形式传递
2. **日期格式**: credate字段使用 YYYY-MM-DD 格式
3. **错误处理**: 即使ERP同步失败，数据也会保存在服务器中
4. **CORS**: 服务已配置允许跨域请求
5. **超时设置**: ERP请求超时时间为30秒

## 故障排查

1. **接口无法访问**: 检查服务是否启动，端口是否被占用
2. **ERP同步失败**: 检查目标ERP地址是否可访问，网络是否正常
3. **数据格式错误**: 检查请求体JSON格式是否正确，必填字段是否齐全

## 日志

服务会在控制台输出以下日志：
- 收到的订单数据
- ERP同步结果
- 错误信息

生产环境建议使用PM2或类似工具管理日志。









