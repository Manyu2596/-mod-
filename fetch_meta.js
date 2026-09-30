/**
 * 可选：从 Steam 官方接口拉取每个 mod 的真实标题/简介，写入 workshop_meta.json
 * 断网或接口失败时自动跳过（不影响 sort.js 使用 zh.json 翻译）
 * 运行：D:\Node\node.exe fetch_meta.js
 */
const fs = require('fs');
const path = require('path');
const sort = require('./sort.js');
const WORKSHOP = sort.getPaths().WORKSHOP;

const OUT = path.join(__dirname, 'workshop_meta.json');

async function fetchMeta(ids) {
    const body = new URLSearchParams();
    body.set('itemcount', String(ids.length));
    ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const r = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: ctrl.signal,
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    let ids = [];
    try {
        ids = fs.readdirSync(WORKSHOP).filter(d => fs.statSync(path.join(WORKSHOP, d)).isDirectory());
    } catch (e) {
        console.log('找不到 WORKSHOP 目录，跳过。');
        return;
    }
    if (!ids.length) return;

    let json;
    try {
        json = await fetchMeta(ids);
    } catch (e) {
        console.log('拉取 Steam 元数据失败（可能断网），跳过：' + e.message);
        return;
    }

    const map = {};
    for (const d of (json.response && json.response.publishedfiledetails) || []) {
        const id = String(d.publishedfileid);
        map[id] = {
            title: (d.title || '').replace(/^﻿/, ''),
            description: (d.description || '').replace(/^﻿/, ''),
        };
    }
    fs.writeFileSync(OUT, JSON.stringify(map, null, 2), 'utf8');
    console.log(`已写入 ${map.length || Object.keys(map).length} 个 mod 的 Steam 元数据 -> ${OUT}`);
    console.log('下次运行 sort.js 会优先采用其中含中文的官方标题。');
}

main().catch(e => { console.log('fetch_meta 出错（已忽略）：' + e.message); process.exit(0); });
