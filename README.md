# 海尔施医疗器械快速下单系统

面向医院客户的试剂耗材在线下单：前端界面 + Node.js 后端 + SQLite 多客户货品库 + ERP 订单同步。

## 快速启动

```bash
npm install
npm start
```

- 服务：**http://localhost:3330**
- 登录页：`login.html` → 下单页：`index.html`
- Windows 一键启动：`scripts\启动服务并配置网络.bat`（需管理员配置防火墙时）

## 目录结构

```
├── server.js / auth.js / productManager.js / database.js   # 后端核心
├── index.html / login.html / script.js / styles.css / config.js
├── data/                    # SQLite 与数据（git 忽略）
├── scripts/                 # 运维、导入、检查工具
├── deploy/                  # 部署脚本与 Nginx 配置
└── docs（*.md）             # 说明文档
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 启动服务 |
| `npm run setup-customer` | 新建客户 + 导入 Excel + 建用户 |
| `npm run import-excel-to-customer` | 向指定客户导入 Excel |
| `npm run add-user` / `list-users` | 用户管理 |
| `npm run health` | 健康检查 |

## 文档

| 文档 | 内容 |
|------|------|
| [使用说明.md](使用说明.md) | 日常使用与排错 |
| [README_API.md](README_API.md) | 订单同步 API |
| [货品管理API文档.md](货品管理API文档.md) | 货品/分类接口 |
| [Excel导入说明.md](Excel导入说明.md) | Excel 导入 |
| [登录与用户说明.md](登录与用户说明.md) | 用户与客户 |
| [客户供应商配置说明.md](客户供应商配置说明.md) | config.js |
| [README_部署运维.md](README_部署运维.md) | 部署与 PM2 速查 |
| [项目运维手册.md](项目运维手册.md) | 完整运维手册 |
| [局域网访问问题排查.md](局域网访问问题排查.md) | 局域网访问 |

## 技术栈

Node.js · SQLite · 原生 HTML/CSS/JS

MIT License
