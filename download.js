/**
 * 命令行批量下载（与网页「资料下载」共用 huobanDownload 逻辑）
 * 用法：node download.js [客户ID] [操作码1,操作码2,...]
 * 环境变量：HUOBAN_ACCESS_TOKEN、HUOBAN_TABLE_ID
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {npm
    CATALOG_OPTIONS,
    isHuobanConfigured,
    queryProductFiles,
    normalizeOperationCodes
} = require('./huobanDownload');

const DEFAULT_CUSTOMER_ID = process.env.HUOBAN_DEFAULT_CUSTOMER_ID || '10936';
const DEFAULT_OP_CODES = (process.env.HUOBAN_DEFAULT_OP_CODES || '33530J2')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function downloadFileToDisk(fileInfo, downloadDir) {
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
    const folder = CATALOG_OPTIONS.find((c) => c.id === fileInfo.catalogId);
    const subDir = path.join(downloadDir, folder ? folder.folder : '其他资料');
    if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
    }
    const prefix = fileInfo.op_code ? `${fileInfo.op_code}_` : '';
    const safeFilename = (prefix + fileInfo.name).replace(/[\\/:*?"<>|]/g, '_');
    const filepath = path.join(subDir, safeFilename);

    if (fs.existsSync(filepath)) {
        console.log(`⏭ 跳过已存在: ${path.relative(downloadDir, filepath)}`);
        return true;
    }

    const response = await axios({
        method: 'GET',
        url: fileInfo.url,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 120000
    });
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    return new Promise((resolve) => {
        writer.on('finish', () => {
            console.log(`✅ ${path.relative(downloadDir, filepath)}`);
            resolve(true);
        });
        writer.on('error', (err) => {
            console.error(`❌ ${safeFilename}:`, err.message);
            resolve(false);
        });
    });
}

async function main() {
    if (!isHuobanConfigured()) {
        console.error('请设置环境变量 HUOBAN_ACCESS_TOKEN');
        process.exit(1);
    }

    const customerId = (process.argv[2] || DEFAULT_CUSTOMER_ID).trim();
    const opArg = process.argv[3];
    const operationCodes = normalizeOperationCodes(
        opArg ? opArg.split(',').map((s) => s.trim()) : DEFAULT_OP_CODES
    );
    const catalogIds = CATALOG_OPTIONS.map((c) => c.id);
    const downloadDir = path.join(__dirname, 'downloads', customerId);

    console.log('客户ID:', customerId);
    console.log('操作码:', operationCodes.join(', '));
    console.log('资料类型:', CATALOG_OPTIONS.map((c) => c.label).join(' / '));

    const files = await queryProductFiles({ customerId, operationCodes, catalogIds });
    if (!files.length) {
        console.log('未找到附件');
        return;
    }

    console.log(`共 ${files.length} 个文件，保存到 ${downloadDir}`);
    let ok = 0;
    for (const f of files) {
        if (await downloadFileToDisk(f, downloadDir)) ok++;
    }
    console.log(`完成：${ok}/${files.length}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
