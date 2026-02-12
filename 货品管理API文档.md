# 货品管理API文档

## 概述

后端提供完整的货品档案和分类管理功能，支持CRUD操作，数据持久化存储在 `data/` 目录下。

## 数据存储

- **货品数据**: `data/products.json`
- **分类数据**: `data/categories.json`

数据以JSON格式存储，支持持久化。

## 货品管理API

### 1. 获取所有货品

**接口**: `GET /api/products`

**查询参数**:
- `category` (可选): 按分类筛选
- `search` (可选): 搜索关键词（搜索名称、规格、厂家）

**示例**:
```bash
# 获取所有货品
curl http://localhost:3330/api/products

# 按分类筛选
curl http://localhost:3330/api/products?category=防护用品

# 搜索
curl http://localhost:3330/api/products?search=口罩
```

**响应**:
```json
{
  "success": true,
  "count": 18,
  "data": [
    {
      "id": 1,
      "name": "一次性医用口罩",
      "category": "防护用品",
      "categoryId": 1,
      "spec": "三层防护，50只/盒",
      "price": 28.00,
      "stock": 1000,
      "manufacturer": "3M中国有限公司",
      "erpGoodsId": "28075",
      "unit": "件",
      "description": "",
      "status": 1,
      "createdAt": "2026-01-21T12:00:00.000Z",
      "updatedAt": "2026-01-21T12:00:00.000Z"
    }
  ]
}
```

### 2. 获取单个货品

**接口**: `GET /api/products/:id`

**示例**:
```bash
curl http://localhost:3330/api/products/1
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "一次性医用口罩",
    ...
  }
}
```

### 3. 创建货品

**接口**: `POST /api/products`

**请求体**:
```json
{
  "name": "货品名称",
  "category": "防护用品",
  "categoryId": 1,
  "spec": "规格说明",
  "price": 28.00,
  "stock": 1000,
  "manufacturer": "生产厂家",
  "erpGoodsId": "28075",
  "unit": "件",
  "description": "详细描述",
  "status": 1
}
```

**必填字段**: `name`

**示例**:
```bash
curl -X POST http://localhost:3330/api/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "新货品",
    "category": "防护用品",
    "price": 28.00,
    "stock": 1000,
    "erpGoodsId": "28075"
  }'
```

### 4. 更新货品

**接口**: `PUT /api/products/:id`

**请求体**: 同创建接口，只需包含要更新的字段

**示例**:
```bash
curl -X PUT http://localhost:3330/api/products/1 \
  -H "Content-Type: application/json" \
  -d '{
    "price": 30.00,
    "stock": 1200
  }'
```

### 5. 删除货品

**接口**: `DELETE /api/products/:id`

**示例**:
```bash
curl -X DELETE http://localhost:3330/api/products/1
```

## 分类管理API

### 1. 获取所有分类

**接口**: `GET /api/categories`

**示例**:
```bash
curl http://localhost:3330/api/categories
```

**响应**:
```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "id": 1,
      "name": "防护用品",
      "description": "口罩、手套、隔离衣等",
      "createdAt": "2026-01-21T12:00:00.000Z",
      "updatedAt": "2026-01-21T12:00:00.000Z"
    }
  ]
}
```

### 2. 获取单个分类

**接口**: `GET /api/categories/:id`

### 3. 创建分类

**接口**: `POST /api/categories`

**请求体**:
```json
{
  "name": "分类名称",
  "description": "分类描述"
}
```

**示例**:
```bash
curl -X POST http://localhost:3330/api/categories \
  -H "Content-Type: application/json" \
  -d '{
    "name": "新分类",
    "description": "分类描述"
  }'
```

### 4. 更新分类

**接口**: `PUT /api/categories/:id`

### 5. 删除分类

**接口**: `DELETE /api/categories/:id`

## 货品数据字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Number | 货品ID（自动生成） |
| name | String | 货品名称（必填） |
| category | String | 分类名称 |
| categoryId | Number | 分类ID |
| spec | String | 规格说明 |
| price | Number | 价格 |
| stock | Number | 库存数量 |
| manufacturer | String | 生产厂家 |
| erpGoodsId | String | ERP货品ID（用于订单同步） |
| unit | String | 单位（默认：件） |
| description | String | 详细描述 |
| status | Number | 状态（1:启用 0:禁用） |
| createdAt | String | 创建时间 |
| updatedAt | String | 更新时间 |

## 分类数据字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Number | 分类ID（自动生成） |
| name | String | 分类名称（必填） |
| description | String | 分类描述 |
| createdAt | String | 创建时间 |
| updatedAt | String | 更新时间 |

## 默认分类

系统初始化时会创建以下默认分类：

1. 防护用品
2. 检测试剂
3. 注射器械
4. 消毒用品
5. 采血器械
6. 手术器械
7. 实验耗材
8. 敷料用品
9. 监测器械
10. 输液器械

## 使用示例

### JavaScript (前端)

```javascript
// 获取所有货品
fetch('http://localhost:3330/api/products')
  .then(res => res.json())
  .then(data => {
    console.log('货品列表:', data.data);
  });

// 创建货品
fetch('http://localhost:3330/api/products', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: '新货品',
    category: '防护用品',
    price: 28.00,
    stock: 1000,
    erpGoodsId: '28075'
  })
})
.then(res => res.json())
.then(data => {
  console.log('创建成功:', data);
});

// 更新货品
fetch('http://localhost:3330/api/products/1', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    price: 30.00,
    stock: 1200
  })
})
.then(res => res.json())
.then(data => {
  console.log('更新成功:', data);
});

// 删除货品
fetch('http://localhost:3330/api/products/1', {
  method: 'DELETE'
})
.then(res => res.json())
.then(data => {
  console.log('删除成功:', data);
});
```

## 注意事项

1. **数据持久化**: 所有数据保存在 `data/` 目录下的JSON文件中
2. **ID自动生成**: 创建新记录时，系统会自动生成唯一ID
3. **数据验证**: 创建货品时，`name` 字段为必填
4. **CORS支持**: 已配置跨域支持，前端可以直接调用
5. **错误处理**: 所有接口都包含错误处理和状态码

## 数据备份

建议定期备份 `data/` 目录下的JSON文件，以防数据丢失。









