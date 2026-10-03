/**
 * 潜渊症 Mod 可视化管理（本地服务）
 * 浏览器打开后可直接拖拽排序、勾选启用，点保存即写入游戏配置
 * 只监听 127.0.0.1，不对外暴露
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const os = require('os');

const lib = require('./sort.js');
const { analyze, classify, loadEnabledIds, detectSeries, GAME_VERSION,
    getPaths, refreshPaths, saveUserPaths, loadUserPaths } = lib;

// 配置路径随探测结果变化，每次现取（支持运行时重新检测 / 手动改路径）
function configPath() { return path.join(getPaths().GAME, 'config_player.xml'); }
const UI = path.join(__dirname, 'ui.html');
const TRANS = path.join(__dirname, 'translations.json');
const ZH_PATH = path.join(__dirname, 'zh.json');
const USER_ZH = path.join(__dirname, 'user_zh.json');
const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen25-14b-8k';
const PORT_START = 9182;
const PORT = process.env.BARO_PORT ? parseInt(process.env.BARO_PORT, 10) : PORT_START;

// ---------- 名称翻译（走本地 Ollama，不联网） ----------
function loadTrans() {
    try { return JSON.parse(fs.readFileSync(TRANS, 'utf8')); } catch (e) { return {}; }
}

function hasChinese(s) { return /[\u4e00-\u9fa5]/.test(s); }

function loadZh() {
    try { return JSON.parse(fs.readFileSync(ZH_PATH, 'utf8')); } catch (e) { return {}; }
}

// 用户手动补的译文（优先级最高，不依赖任何模型）
function loadUserZh() {
    try { return JSON.parse(fs.readFileSync(USER_ZH, 'utf8')); } catch (e) { return {}; }
}

// 探测本地模型是否可用（避免没模型时报一堆红字）
function ollamaReachable() {
    return new Promise(resolve => {
        const req = http.get(OLLAMA + '/api/tags', res => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
}

function ollamaChat(prompt) {
    const body = JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.2 },
    });
    return new Promise((resolve, reject) => {
        const req = http.request(OLLAMA + '/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(d).message.content); }
                catch (e) { reject(new Error('模型返回无法解析')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(900000);
        req.write(body);
        req.end();
    });
}

async function translateAll() {
    if (!(await ollamaReachable())) {
        throw new Error('未检测到本地 AI（Ollama 未运行）。当前 mod 的中文名/简介已内置，无需翻译；新订阅的 mod 可用每行右侧「译」按钮手动补充。');
    }
    const trans = loadTrans();
    const transIdx = {};
    Object.keys(trans).forEach(k => { transIdx[__normName(k)] = trans[k]; });
    const zhAll = loadZh();
    const userZh = loadUserZh();
    const data = buildData();
    const mods = data.active.concat(data.idle);

    // 模型偶尔会偷懒把英文原名原样返回，这种不算已翻译，下次仍要重翻
    function isRealTranslation(name, val) {
        if (!val) return false;
        if (val === name) return hasChinese(name);   // 原名自带中文才算数
        return true;
    }

    // 三个来源都没有“真正写过”中文名时才需要翻译：手动译文 > 模型译文 > 内置表
    const todo = mods.filter(m => {
        if (userZh[m.id] && userZh[m.id].zh) return false;
        const __tv = trans[m.name] || transIdx[__normName(m.name)];
        if (isRealTranslation(m.name, __tv)) return false;
        if (zhAll[m.id] && zhAll[m.id].zh) return false;
        return true;
    }).map(m => m.name);

    const skipped = mods.length - todo.length;
    if (!todo.length) return { trans, added: 0, skipped };

    const promptFor = names =>
        '你是游戏模组名称翻译助手，把《潜渊症》(Barotrauma) 的模组名称翻译成中文。\n' +
        '硬性要求：每一条都必须给出中文译名，绝对不允许原样照抄英文。\n' +
        '翻译规则：\n' +
        '- 普通英文单词一律译成中文，参考示例：\n' +
        '    Lootbelt -> 战利品腰带\n' +
        '    BetterFabricatorUI -> 更好的制造站界面\n' +
        '    Detectable Alien Minerals -> 可探测的外星矿物\n' +
        '    Bigger Deconstructor -> 更大的解构器\n' +
        '    ItemIO BetterMergeStack -> 物品IO 更好的堆栈合并\n' +
        '    [BOS]Wrecks -> [BOS]沉船残骸\n' +
        '- 只有纯技术标识符/缩写才保留原文（如 Lua、IO、UI、API、[BOS]），它们之外的部分仍要译成中文。\n' +
        '- 名称本身已经是中文的，原样返回即可。\n' +
        '- 不要输出解释、序号或代码块标记。\n' +
        '只输出一个 JSON 对象，键是原始名称，值是中文译名。\n\n' +
        '待翻译：\n' + names.map(n => '- ' + n).join('\n');

    // 宽松解析：小模型偶尔会漏掉最后一项的收尾引号、加尾逗号，或用 ```json 包裹。
    // 直接解析失败时按由轻到重的顺序尝试修复，最后兜底用正则逐对提取。
    function lenientParse(out) {
        const s = out.indexOf('{');
        const e = out.lastIndexOf('}');
        if (s < 0 || e <= s) return null;
        const txt = out.slice(s, e + 1).trim();
        try { return JSON.parse(txt); } catch (_) {}
        // 尾部缺引号：  ...文字}  →  ...文字"}
        try { return JSON.parse(txt.replace(/\}\s*$/, '"}')); } catch (_) {}
        // 尾逗号：  "...",}  →  "..."}
        try { return JSON.parse(txt.replace(/,(\s*[}\]])/g, '$1')); } catch (_) {}
        // 兜底：不依赖整体结构，逐对提取 "key":"value"
        const obj = {};
        const re = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = re.exec(txt)) !== null) obj[m[1]] = m[2];
        return Object.keys(obj).length ? obj : null;
    }

    // 分批翻译：每批条数少 → 输出短、出错概率低；且每批完成即落盘，
    // 中途失败 / 停止服务都不会丢掉已翻好的部分。单批失败自动重试一次。
    const BATCH = 10;
    let added = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        let obj = null, lastErr = '';
        for (let t = 0; t < 2 && !obj; t++) {
            const out = await ollamaChat(promptFor(batch));
            obj = lenientParse(out);
            if (!obj) lastErr = out.slice(0, 120);
        }
        if (!obj) {
            throw new Error('第 ' + (Math.floor(i / BATCH) + 1) + '/' +
                Math.ceil(todo.length / BATCH) + ' 批翻译失败：模型输出不是合法 JSON（已自动重试一次）');
        }
        // 把模型返回的键归一到真实 mod 名（它偶尔会丢空格），保证之后按名字能命中
        Object.keys(obj).forEach(k => {
            const real = batch.find(n => __normName(n) === __normName(k));
            trans[real || k] = obj[k];
        });
        fs.writeFileSync(TRANS, JSON.stringify(trans, null, 2), 'utf8');
        added += Object.keys(obj).length;
    }
    return { trans, added, skipped };
}

// ---------- 读取当前配置中的 package ----------
function readPackages() {
    const cfg = configPath();
    if (!fs.existsSync(cfg)) return [];   // 路径不对时不要崩，返回空让界面提示
    const xml = fs.readFileSync(cfg, 'utf8');
    const m = xml.match(/<regularpackages>([\s\S]*?)<\/regularpackages>/);
    if (!m) return [];
    const out = [];
    const re = /<!--([\s\S]*?)-->|\s*(<package\s+[^>]*?\/>)/g;
    let lastComment = '';
    let r;
    while ((r = re.exec(m[1])) !== null) {
        if (r[1]) { lastComment = r[1].trim(); continue; }
        const tag = r[2];
        const idm = /Installed[/\\](\d+)[/\\]/i.exec(tag);
        if (!idm) continue;
        out.push({ id: idm[1], name: lastComment, tag });
        lastComment = '';
    }
    return out;
}

// ---------- 扫描所有 mod ----------
function buildData() {
    const enabledIds = loadEnabledIds();
    const pkgs = readPackages();
    const inConfig = {};
    pkgs.forEach(p => { inConfig[p.id] = p.tag; });
    const trans = loadTrans();
    const transIdx = {};
    Object.keys(trans).forEach(k => { transIdx[__normName(k)] = trans[k]; });
    const zhAll = loadZh();
    const userZh = loadUserZh();

    const W = getPaths().WORKSHOP;
    const LM = getPaths().LOCALMODS;
    const mods = [];
    const seen = new Set();

    // 扫描一个根目录：工坊（数字 id）与游戏目录里的 LocalMods（英文目录名）都支持
    const scanOne = (base) => {
        if (!base || !fs.existsSync(base)) return;
        fs.readdirSync(base).forEach(id => {
            if (!fs.statSync(path.join(base, id)).isDirectory()) return;
            if (seen.has(id)) return;
            const a = analyze(id, base);
            if (!a) return;
            seen.add(id);
            const c = classify(a);
            const patchBonus = /补丁|patch/i.test(a.name) ? -0.5 : 0;
            const u = userZh[id] || {};
            const zh = u.zh || trans[a.name] || transIdx[__normName(a.name)] || (zhAll[id] && zhAll[id].zh) || null;
            const numId = /^\d{1,20}$/.test(String(id));
            mods.push(Object.assign(a, {
                tier: c.tier + patchBonus,
                cat: c.cat,
                old: a.gameversion !== lib.GAME_VERSION,
                enabled: enabledIds.has(id),
                zh,
                desc: u.desc || (zhAll[id] && zhAll[id].desc) || autoPurpose(a),
                workshop: numId ? ('https://steamcommunity.com/sharedfiles/filedetails/?id=' + id) : '',
                local: !numId,
            }));
        });
    };

    scanOne(W);     // Steam 创意工坊
    scanOne(LM);    // 游戏目录里的 LocalMods（非 Steam 版 / 手动放的 mod）

    // 已启用的按当前配置顺序，未启用的按推荐顺序
    const active = pkgs
        .map(p => mods.find(m => m.id === p.id))
        .filter(Boolean)
        .map(m => Object.assign(m, { cat: m.cat }));
    const idle = mods.filter(m => !enabledIds.has(m.id));
    idle.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, 'zh'));

    return { active, idle, trans: loadTrans() };
}

// ---------- 保存 ----------
function save(list, allowEmpty) {
    // list: [{id, enabled}]，顺序即加载顺序
    const xml = fs.readFileSync(configPath(), 'utf8');
    const pkgs = readPackages();
    const tagOf = {};
    pkgs.forEach(p => { tagOf[p.id] = { tag: p.tag, name: p.name }; });

    // 备份：保留最近 3 份（.bak / .bak1 / .bak2），避免一次保存就把唯一的旧配置覆盖掉
    try {
        const cp = configPath();
        for (let i = 2; i >= 1; i--) {
            const from = i === 1 ? (cp + '.bak') : (cp + '.bak' + (i - 1));
            const to = cp + '.bak' + i;
            if (fs.existsSync(from)) fs.copyFileSync(from, to);
        }
        fs.writeFileSync(cp + '.bak', xml, 'utf8');
    } catch (e) { /* 备份失败不阻断保存 */ }

    // 需要在配置里但原本没有的 mod：从 Installed 目录补一条
    const INSTALLED = getPaths().INSTALLED;
    const items = [];
    list.forEach(it => {
        if (!it.enabled) return;
        let entry = tagOf[it.id];
        if (!entry) {
            const name = (() => {
                let fl = path.join(INSTALLED, it.id, 'filelist.xml');
                if (!fs.existsSync(fl)) {
                    const LM2 = getPaths().LOCALMODS;
                    if (LM2) fl = path.join(LM2, it.id, 'filelist.xml');
                }
                if (!fs.existsSync(fl)) return null;
                const m = /<contentpackage\s+[^>]*?name="([^"]*)"/i.exec(fs.readFileSync(fl, 'utf8'));
                return m ? m[1] : null;
            })();
            if (!name) return;
            entry = {
                name,
                tag: `<package\n        path="${pkgPathFor(it.id, INSTALLED)}" />`,
            };
        }
        items.push(entry);
    });

    // 写入配置用的 package 路径：工坊 mod 走 Installed，本地 mod 走游戏目录的 LocalMods
function pkgPathFor(id, installedDir) {
    const P = getPaths();
    let dir = path.join(installedDir, id);
    if (!fs.existsSync(path.join(dir, 'filelist.xml')) && P.LOCALMODS && fs.existsSync(path.join(P.LOCALMODS, id, 'filelist.xml'))) {
        dir = path.join(P.LOCALMODS, id);
    }
    return dir.replace(/\\/g, '/') + '/filelist.xml';
}
// 防误清空：原配置里有 mod，但新列表一个都不启用时拒绝写入
    if (pkgs.length > 0 && items.length === 0 && !allowEmpty) {
        throw new Error('已阻止保存：当前配置有 ' + pkgs.length + ' 个 mod，但新列表为空（防误清空）。确实要全部停用请点「清空mod」。');
    }

    const inner = '\n' + items.map(e =>
        `      <!--${e.name}-->\n      ${e.tag}`
    ).join('\n') + '\n    ';

    let out;
    const reInner = /(<regularpackages>)[\s\S]*?(<\/regularpackages>)/;
    const hasWrapper = /<contentpackages>[\s\S]*?<\/contentpackages>/.test(xml);
    if (hasWrapper) {
        if (reInner.test(xml)) {
            out = xml.replace(reInner, '$1' + inner + '$2');
        } else {
            // 有 contentpackages 但缺 regularpackages：插到它内部
            out = xml.replace('<contentpackages>',
                '<contentpackages>\n    <regularpackages>' + inner + '    </regularpackages>');
        }
    } else {
        // 没有 contentpackages（被游戏重置过）。注意：裸的 regularpackages 游戏不认，
        // 必须先移除再以正确的包裹结构重建
        out = xml.replace(/[\t ]*<regularpackages>[\s\S]*?<\/regularpackages>\r?\n?/, '');
        const block = '  <contentpackages>\n    <regularpackages>' + inner + '</regularpackages>\n  </contentpackages>\n';
        const i = out.lastIndexOf('</config>');
        out = out.slice(0, i) + block + '</config>' + out.slice(i + '</config>'.length);
    }
    fs.writeFileSync(configPath(), out, 'utf8');
    return items.length;
}

// ---------- HTTP ----------
function send(res, code, body, type) {
    res.writeHead(code, {
        'Content-Type': type || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

// 通过 Steam 启动游戏（本地服务，仅在本机生效）
function launchGame() {
    try {
        exec('cmd /c start "" "steam://rungameid/602960"');
        return true;
    } catch (e) {
        return false;
    }
}

// ---------- mod 更新检测（离线：对比本机会话的版本快照）----------
const VERSIONS = path.join(__dirname, 'versions.json');

function loadVersions() {
    try { return JSON.parse(fs.readFileSync(VERSIONS, 'utf8')); } catch (e) { return null; }
}
function saveVersions(v) {
    fs.writeFileSync(VERSIONS, JSON.stringify(v, null, 2), 'utf8');
}

// 扫描当前所有工坊 mod 的版本，作为一次快照
function scanModVersions() {
    const W = getPaths().WORKSHOP;
    const out = {};
    if (!fs.existsSync(W)) return out;
    fs.readdirSync(W).forEach(id => {
        const dir = path.join(W, id);
        if (!fs.statSync(dir).isDirectory()) return;
        const fl = path.join(dir, 'filelist.xml');
        if (!fs.existsSync(fl)) return;
        let t;
        try { t = fs.readFileSync(fl, 'utf8'); } catch (e) { return; }
        out[id] = {
            name: (/<contentpackage\s+[^>]*?name="([^"]*)"/i.exec(t) || [, '?'])[1],
            modversion: (/modversion="([^"]*)"/i.exec(t) || [, '-'])[1],
            gameversion: (/gameversion="([^"]*)"/i.exec(t) || [, '-'])[1],
            ts: fs.statSync(fl).mtime.toISOString(),
        };
    });
    return out;
}

// 自动简介：没有手写/内置简介时，从 mod 实际内容生成一行用途说明
const KIND_ZH = {
    Character: '角色/怪物', Item: '物品装备', Submarine: '潜艇船只', Text: '文本',
    Talents: '天赋', TalentTrees: '天赋树', Jobs: '职业', Afflictions: '症状状态',
    Missions: '任务', RandomEvents: '随机事件', NPCSets: 'NPC', Factions: '派系',
    Structure: '建筑结构', Sounds: '音效', Particles: '粒子特效', UIStyle: '界面样式',
    Decals: '贴图', Wreck: '沉船', EnemySubmarine: '敌方潜艇', Corpses: '尸体',
};
function autoPurpose(a) {
    const t = a.tags || {};
    const total = Object.values(t).reduce((x, y) => x + y, 0);
    const n = a.name || '';
    if (/luacsforbarotrauma/i.test(n)) return '前置框架：让游戏支持 Lua+C# 脚本类 mod，必须最先加载';
    if (/luacsclientside/i.test(n)) return '前置框架：强制客户端加载 Lua 脚本（联机用）';
    if (/^csforbarotrauma/i.test(n)) return '旧版脚本框架（已被 LuaCs 取代，不应启用）';
    if (/汉化|简体|Chinese|CN_zh/i.test(n)) return '汉化覆盖：把文本替换为中文，应放最后加载';
    if (a.deps && a.deps.length) {
        const base = a.deps.join('、');
        if (/补丁|兼容/i.test(n)) return '兼容补丁：配合「' + base + '」使用，解决内容冲突';
        if (/补丁|patch|expansion|拓展|扩展/i.test(n)) return '扩展补丁：基于「' + base + '」追加内容';
    }
    if (/补丁|patch/i.test(n)) return '补丁/修正类：调整或修复现有内容';
    if (total === 0 && (a.hasLua || a.hasCs)) {
        const lang = [a.hasLua ? 'Lua' : '', a.hasCs ? 'C#' : ''].filter(Boolean).join('+');
        return '脚本机制类：不新增内容，用 ' + lang + ' 改游戏机制/性能';
    }
    const raw = {
        '潜艇船只': (t.Submarine || 0) + (t.EnemySubmarine || 0),
        '角色内容': t.Character || 0,
        '职业/天赋': (t.Jobs || 0) + (t.Talents || 0) + (t.TalentTrees || 0),
        '物品装备': t.Item || 0,
        '症状机制': t.Afflictions || 0,
        'NPC/派系': (t.NPCSets || 0) + (t.Factions || 0) + (t.NPCConversations || 0),
        '事件/任务': (t.RandomEvents || 0) + (t.Missions || 0) + (t.LocationTypes || 0),
        '文本覆盖': t.Text || 0,
        '音效/特效': (t.Sounds || 0) + (t.Particles || 0) + (t.Decals || 0),
    };
    const score = { '潜艇船只': raw['潜艇船只'] * 12, '角色内容': raw['角色内容'] * 4 };
    const best = Object.entries(raw)
        .map(([k, v]) => [k, (score[k] !== undefined ? score[k] : v)])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])[0];
    if (!best) return '其他内容：' + Object.entries(t).slice(0, 3).map(([k, v]) => (KIND_ZH[k] || k) + '×' + v).join('、');
    const unit = {
        '潜艇船只': '艘潜艇', '角色内容': '个角色/怪物', '职业/天赋': '项职业或天赋',
        '物品装备': '件物品', '症状机制': '项状态效果', 'NPC/派系': '项 NPC/派系',
        '事件/任务': '项事件或任务', '文本覆盖': '处文本', '音效/特效': '项音效/特效',
    };
    let s = best[0] + '：新增/改动 ' + raw[best[0]] + ' ' + unit[best[0]];
    const others = Object.entries(raw).filter(([k, v]) => k !== best[0] && v > 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => k + '×' + v);
    if (others.length) s += '（另含 ' + others.join('、') + '）';
    if (a.hasLua || a.hasCs) s += '；含' + [a.hasLua ? 'Lua' : '', a.hasCs ? 'C#' : ''].filter(Boolean).join('+') + '脚本';
    return s;
}

// 可能冲突：多个启用的 mod 定义了同一个标识符（重复定义，最容易导致报错）
const DEF_TAGS = 'Item|Character|Affliction|Talent|Job|Submarine|NPCSet|Structure|Decal|Particle|Corpse|Wreck|StartItems';

// 原版内容自带的标识符（mod 覆盖原版东西属于正常，不算冲突）
let VANILLA = null;
function vanillaIdentifiers() {
    if (VANILLA) return VANILLA;
    const set = new Set();
    let scanned = 0;
    (function walk(dir) {
        if (scanned > 1500) return;
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            if (scanned > 1500) return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.xml')) continue;
            scanned++;
            try {
                if (fs.statSync(p).size > 2 * 1024 * 1024) continue;
                const s = fs.readFileSync(p, 'utf8');
                const re = new RegExp('<(?:' + DEF_TAGS + ')\\b[^>]*?identifier="([^"]+)"', 'g');
                let r;
                while ((r = re.exec(s)) !== null) set.add(r[1]);
            } catch (err) { /* 跳过读不了的文件 */ }
        }
    })(path.join(getPaths().GAME, 'Content'));
    VANILLA = set;
    return set;
}

function findDuplicateIdentifiers(mods) {
    const W = getPaths().WORKSHOP;
    const vanilla = vanillaIdentifiers();
    const map = {};
    mods.forEach(m => {
        const dir = path.join(W, m.id);
        const fl = path.join(dir, 'filelist.xml');
        if (!fs.existsSync(fl)) return;
        let xml;
        try { xml = fs.readFileSync(fl, 'utf8'); } catch (e) { return; }
        let scanned = 0;
        for (const f of xml.matchAll(/<\w+\s+file="([^"]+)"/g)) {
            if (scanned++ > 60) break;                       // 每个 mod 最多扫 60 个文件，避免卡顿
            const rel = f[1].replace('%ModDir%', '').replace(/^[/\\]/, '');
            const p = path.join(dir, rel);
            try {
                if (!fs.existsSync(p)) continue;
                if (fs.statSync(p).size > 2 * 1024 * 1024) continue;
                const s = fs.readFileSync(p, 'utf8');
                const re = new RegExp('<(?:' + DEF_TAGS + ')\\b[^>]*?identifier="([^"]+)"', 'g');
                let r;
                while ((r = re.exec(s)) !== null) {
                    (map[r[1]] = map[r[1]] || new Set()).add(m.zh || m.name);
                }
            } catch (e) { /* 跳过读不了的文件 */ }
        }
    });
    return Object.entries(map)
        .filter(([ident, set]) => {
            if (set.size < 2) return false;
            if (vanilla.has(ident)) return false;          // 原版内容：正常覆盖
            const names = [...set];
            // 同系列/配套（名称前缀一致，如“东方…”）共享标识符属正常，不算冲突
            const pre = names[0].slice(0, 2);
            if (pre.length === 2 && names.every(n => n.slice(0, 2) === pre)) return false;
            return true;
        })
        .map(([ident, set]) => ({ ident, mods: [...set] }))
        .sort((a, b) => b.mods.length - a.mods.length)
        .slice(0, 10);
}

// 用 App 模式打开独立窗口（无地址栏/无标签页，像真正的软件）
function openAppWindow(u) {
    const browsers = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const b of browsers) {
        if (fs.existsSync(b)) {
            try { exec(`"${b}" --app="${u}"`); return true; } catch (e) { /* 继续尝试下一个 */ }
        }
    }
    try { exec(`cmd /c start "" "${u}"`); return true; } catch (e) { return false; }
}

﻿// 给 PowerShell 命令里的路径加单引号（路径里的 ' 转义成两个）
function Q_(p) { return "'" + String(p).split("'").join("''") + "'"; }

// ---------- 共享文件夹（导出/导入 mod 目录）----------
const SHARE_FILE = path.join(__dirname, 'share.json');
function loadShare() { try { return JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch (e) { return {}; } }
function saveShare(o) { fs.writeFileSync(SHARE_FILE, JSON.stringify(o, null, 2), 'utf8'); }
function __escShare(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function __isWs(id) { return /^[0-9]{5,}$/.test(String(id == null ? '' : id).trim()); }
// 模型翻译返回的键偶尔会丢空格/标点（如 DontOpenDebugConsoleOnErrors），
// 显示时按去掉空格标点后的键兜底匹配，避免译文看起来像没保存
function __normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, ''); }
// 默认就放在软件自己的文件夹里
function defaultShareFolder() {
    const nw = path.join(__dirname, 'exported_mods');
    const old = path.join(__dirname, '导出的mod');
    try { if (!fs.existsSync(nw) && fs.existsSync(old)) fs.renameSync(old, nw); } catch (e) { }
    return nw;
}
// 没填就用记住的，再没有就用软件目录内的默认文件夹
function resolveShareFolder(f) { return (f && String(f).trim()) || loadShare().folder || defaultShareFolder(); }

// ---------- mod 方案存档：一套启用列表存一个文件，换存档时来回切换 ----------
const PRESET_DIR = path.join(__dirname, 'presets');
function __presetFile(name) {
    const n = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\s+|\s+$/g, '').replace(/^\.+$/, '_');
    if (!n) return '';
    return path.join(PRESET_DIR, n + '.json');
}

// mod id 只允许纯数字（Steam 创意工坊 id）：挡住 manifest 里 ../.. 之类的路径穿越
// mod id：工坊是纯数字，本地 mod 是英文目录名；都允许，但仍挡住 ../ 之类的路径穿越
function safeModId(id) {
    const s = String(id == null ? '' : id);
    if (/^\d{1,20}$/.test(s)) return s;
    if (/^[A-Za-z0-9][A-Za-z0-9._\- ]{0,63}$/.test(s) && s !== '.' && s !== '..') return s;
    return '';
}

// 一个 mod 的源目录就是创意工坊下的 <id> 文件夹（管理器只扫描这里）
function shareModDir(id) {
    const P = getPaths();
    const w = path.join(P.WORKSHOP, id);
    if (fs.existsSync(w)) return w;
    const l = P.LOCALMODS ? path.join(P.LOCALMODS, id) : '';
    if (l && fs.existsSync(l)) return l;
    return w;
}

// 递归删除（兼容老版本 Node，不用 fs.rmSync）
function rmDirSync(p) {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const c = path.join(p, e.name);
        if (e.isDirectory()) rmDirSync(c);
        else if (e.isSymbolicLink()) { try { fs.unlinkSync(c); } catch (_) {} }
        else { try { fs.unlinkSync(c); } catch (_) {} }
    }
    try { fs.rmdirSync(p); } catch (_) {}
}

// 递归复制（覆盖式）
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else if (e.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(s), d); } catch (_) {} }
        else { fs.copyFileSync(s, d); }
    }
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/' || url === '/ui.html') {
        if (!fs.existsSync(UI)) return send(res, 404, 'ui.html 缺失', 'text/plain');
        return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    }

    if (url === '/api/data') {
        try {
            const data = buildData();
            const P = getPaths();
            data.paths = {
                game: P.GAME,
                workshop: P.WORKSHOP,
                installed: P.INSTALLED,
                localmods: P.LOCALMODS,
                gameExists: fs.existsSync(P.GAME),
                localmodsExists: !!(P.LOCALMODS && fs.existsSync(P.LOCALMODS)),
                workshopExists: fs.existsSync(P.WORKSHOP),
                installedExists: fs.existsSync(P.INSTALLED),
                manual: loadUserPaths(),
            };
            return send(res, 200, JSON.stringify(data));
        } catch (e) {
            return send(res, 500, JSON.stringify({ error: e.message }));
        }
    }

    if (url === '/api/translate') {
        translateAll()
            .then(r => send(res, 200, JSON.stringify({ ok: true, trans: r.trans, added: r.added, skipped: r.skipped })))
            .catch(e => send(res, 500, JSON.stringify({ ok: false, error: e.message })));
        return;
    }

    if (url === '/api/save' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw) || {};
                const n = save(b.list || [], !!b.allowEmpty);
                send(res, 200, JSON.stringify({ ok: true, saved: n }));
            } catch (e) {
                send(res, 500, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (url === '/api/resort' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const list = JSON.parse(raw).list; // [{id, enabled}]，当前显示顺序
                const data = buildData();
                const byId = {};
                data.active.concat(data.idle).forEach(m => { byId[m.id] = m; });

                const enabledIds = list.filter(x => x.enabled).map(x => x.id);
                const enabledMods = enabledIds.map(id => byId[id]).filter(Boolean);
                const sortedEnabled = lib.resortActive(enabledMods);

                const disabledIds = list.filter(x => !x.enabled).map(x => x.id);
                const out = sortedEnabled.map(m => ({ id: m.id, enabled: true }))
                    .concat(disabledIds.map(id => ({ id, enabled: false })));
                send(res, 200, JSON.stringify({ ok: true, list: out }));
            } catch (e) {
                send(res, 500, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (url === '/api/test' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const bodyJson = JSON.parse(raw);
                const list = bodyJson.list;
                // 先把当前顺序写入游戏配置，让启动的游戏用这套顺序
                save(list);

                const data = buildData();
                const byId = {};
                data.active.concat(data.idle).forEach(m => { byId[m.id] = m; });
                const enabledIds = list.filter(x => x.enabled).map(x => x.id);
                const enabledMods = enabledIds.map(id => byId[id]).filter(Boolean);

                // 框架冲突：旧框架 CsForBarotrauma 与 LuaCs 系列同时启用
                const hasOldFrame = enabledMods.some(m => /^csforbarotrauma/i.test(m.name) && !/luacs/i.test(m.name));
                const hasLuaFrame = enabledMods.some(m => /luacs/i.test(m.name));
                const frameConflict = hasOldFrame && hasLuaFrame;

                // 版本不匹配
                const oldMods = enabledMods
                    .filter(m => m.gameversion !== GAME_VERSION)
                    .map(m => ({ name: m.zh || m.name, ver: m.gameversion }));

                // 同系列冲突检测
                const items = enabledMods.map(m => ({
                    name: m.name, zhName: m.zh || m.name, modversion: m.modversion,
                }));
                const groups = detectSeries(items);
                const conflicts = groups.filter(g => !g.addon);
                const addons = groups.filter(g => g.addon);

                // 依赖缺失：启用的 mod 声明了依赖，但那个依赖没启用
                const enabledNames = new Set(enabledMods.map(m => m.name));
                const missingDeps = [];
                enabledMods.forEach(m => {
                    (m.deps || []).forEach(dep => {
                        if (!enabledNames.has(dep)) {
                            missingDeps.push({ mod: m.zh || m.name, dep });
                        }
                    });
                });

                // 可能冲突：同一标识符被多个启用 mod 定义
                const possibleConflicts = findDuplicateIdentifiers(enabledMods);

                const doLaunch = bodyJson.launch !== false;
                const launched = doLaunch ? launchGame() : false;

                send(res, 200, JSON.stringify({
                    ok: true, launched,
                    report: {
                        enabledCount: enabledMods.length,
                        frameConflict, oldMods, conflicts, addons, missingDeps, possibleConflicts,
                    },
                }));
            } catch (e) {
                send(res, 500, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (url === '/api/setzh' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const store = loadUserZh();
                const cur = store[b.id] || {};
                if (typeof b.zh === 'string') cur.zh = b.zh;
                if (typeof b.desc === 'string') cur.desc = b.desc;
                store[b.id] = cur;
                fs.writeFileSync(USER_ZH, JSON.stringify(store, null, 2), 'utf8');
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) {
                send(res, 500, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // 检查 mod 更新：与上次快照对比（新增 / 版本变化 / 移除）
    if (url === '/api/updates' && req.method === 'POST') {
        try {
            const current = scanModVersions();
            const prev = loadVersions();
            if (!prev) {
                saveVersions(current);
                return send(res, 200, JSON.stringify({ ok: true, first: true, count: Object.keys(current).length }));
            }
            const updated = [], added = [], removed = [];
            Object.keys(current).forEach(id => {
                const c = current[id], p = prev[id];
                if (!p) {
                    added.push({ id, name: c.name, modversion: c.modversion, ts: c.ts });
                } else if (c.modversion !== p.modversion || c.gameversion !== p.gameversion) {
                    updated.push({
                        id, name: c.name,
                        from: p.modversion, to: c.modversion,
                        gameFrom: p.gameversion, gameTo: c.gameversion,
                        ts: c.ts,
                    });
                }
            });
            Object.keys(prev).forEach(id => { if (!current[id]) removed.push({ id, name: prev[id].name }); });
            saveVersions(current);     // 本次结果作为下次基线
            send(res, 200, JSON.stringify({ ok: true, updated, added, removed, count: Object.keys(current).length }));
        } catch (e) {
            send(res, 500, JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // 重新检测路径（刚装好游戏 / 改了 Steam 库位置时用）
    if (url === '/api/paths/rescan' && req.method === 'POST') {
        try {
            const P = refreshPaths();
            send(res, 200, JSON.stringify({ ok: true, paths: P, manual: loadUserPaths() }));
        } catch (e) {
            send(res, 500, JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // 手动指定路径（写入 paths.json，优先级最高；传空字符串即恢复自动）
    if (url === '/api/paths' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw) || {};
                if (b.clear) {
                    saveUserPaths({ game: '', workshop: '', installed: '' });
                } else {
                    saveUserPaths({
                        game: typeof b.game === 'string' ? b.game.trim() : undefined,
                        workshop: typeof b.workshop === 'string' ? b.workshop.trim() : undefined,
                        installed: typeof b.installed === 'string' ? b.installed.trim() : undefined,
                        localmods: typeof b.localmods === 'string' ? b.localmods.trim() : undefined,
                    });
                }
                const P = refreshPaths();
                send(res, 200, JSON.stringify({ ok: true, paths: P, manual: loadUserPaths() }));
            } catch (e) {
                send(res, 500, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

﻿    // 给 PowerShell 命令里的路径加单引号（路径里的 ' 转义成两个）
function Q_(p) { return "'" + String(p).split("'").join("''") + "'"; }

// ---------- 共享文件夹（导出/导入 mod 目录）----------
    if (url === '/api/share/get') {
        const sh = loadShare();
        send(res, 200, JSON.stringify({ ok: true, folder: sh.folder || defaultShareFolder(), minimize: sh.minimize !== false }));
        return;
    }

    if (url === '/api/share/set' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const prev = loadShare();
                saveShare({ folder: (b.folder || '').trim(), minimize: b.minimize === undefined ? (prev.minimize !== false) : !!b.minimize });
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // 导出：把当前已启用的 mod 整个目录复制到共享文件夹，并写一份 manifest.json
    if (url === '/api/share/export' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const folder = resolveShareFolder(b.folder);
                const ids = (b.list || []).map(x => safeModId(x && x.id)).filter(Boolean);
                if (!ids.length) throw new Error('当前没有已启用的 mod 可导出');
                fs.mkdirSync(folder, { recursive: true });

                // 清掉上次导出的残留：只删「看起来像 mod 目录」且这次不在列表里的，避免误删用户别的东西
                let cleaned = 0;
                try {
                    const keep = new Set(ids);
                    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
                        if (!e.isDirectory()) continue;
                        if (keep.has(e.name)) continue;
                        if (!safeModId(e.name)) continue;
                        rmDirSync(path.join(folder, e.name));
                        cleaned++;
                    }
                } catch (e) { /* 清理失败不影响导出 */ }
                let count = 0; const skipped = [];
                for (const id of ids) {
                    const src = shareModDir(id);
                    if (!fs.existsSync(src)) { skipped.push(id); continue; }
                    const dest = path.join(folder, id);
                    rmDirSync(dest);
                    copyDir(src, dest);
                    count++;
                }
                const manifest = {
                    app: 'BarotraumaModSorter', type: 'modpack',
                    exportedAt: new Date().toISOString(),
                    active: (b.list || []).map(m => ({ id: m.id, name: m.name || '', zh: m.zh || '' })),
                };
                fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
                // 顺带生成订阅清单：对方不想拷大文件时，直接在这里订阅创意工坊 mod
                try {
                    const wsList = (b.list || []).filter(m => __isWs(m && m.id));
                    if (wsList.length) {
                        const items = wsList.map(m => '<li><a class="sub" href="steam://subscribe/' + m.id + '">Steam 订阅</a> <b>' + __escShare(m.zh || m.name || m.id) + '</b> <code>' + m.id + '</code> <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.id + '">网页打开</a></li>').join('');
                        const html = '<!doctype html><html><head><meta charset="utf-8"><title>一键订阅 mod</title><style>body{font-family:"Microsoft YaHei",sans-serif;background:#111827;color:#e5e7eb;padding:24px;line-height:1.7}a{color:#818cf8}a.sub{background:#6366f1;color:#fff;padding:3px 10px;border-radius:6px;text-decoration:none;margin-right:8px}li{margin:6px 0}code{color:#9ca3af}</style></head><body><h2>共 ' + wsList.length + ' 个创意工坊 mod</h2><ol>' + items + '</ol><p>点「Steam 订阅」会拉起 Steam 客户端并弹出订阅确认；也可以点「网页打开」在社区页手动点「+ 订阅」。</p></body></html>';
                        fs.writeFileSync(path.join(folder, 'subscribe.html'), html, 'utf8');
                    }
                } catch (e) { /* 忽略：订阅清单生成失败不影响导出 */ }
                // 打包成 zip，方便直接发给别人（放在导出文件夹旁边，不塞进自己里面）
                let zipPath = '', zipError = '', zipSize = 0;
                if (b.zip !== false) {
                    try {
                        const stamp = new Date();
                        const p2 = n => (n < 10 ? '0' : '') + n;
                        const tag = stamp.getFullYear() + p2(stamp.getMonth() + 1) + p2(stamp.getDate()) + '-' + p2(stamp.getHours()) + p2(stamp.getMinutes());
                        const outDir = path.dirname(folder);
                        // 文件名带「几个 mod + 时间」，一眼看出这一包是哪次导出的
                        zipPath = path.join(outDir, 'BarotraumaMods-' + count + 'mods-' + tag + '.zip');
                        // 只留最新这一包，免得越攒越多
                        try {
                            for (const f of fs.readdirSync(outDir)) {
                                if (/^BarotraumaMods-\d+mods-\d{8}-\d{4}\.zip$/i.test(f) || f.toLowerCase() === 'mods_pack.zip') {
                                    try { fs.unlinkSync(path.join(outDir, f)); } catch (e) { }
                                }
                            }
                        } catch (e) { }
                        try {
                            const cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path ' +
                                Q_(path.join(folder, '*')) + ' -DestinationPath ' + Q_(zipPath) +
                                ' -CompressionLevel Optimal -Force"';
                            execSync(cmd, { timeout: 900000, windowsHide: true, maxBuffer: 1 << 26 });
                        } catch (e) {
                            // Compress-Archive 对超 2GB / 超长路径会失败，回退到系统自带 tar
                            zipError = String(e.message || e).slice(0, 80);
                            try {
                                execSync('tar -a -c -f ' + Q_(zipPath) + ' -C ' + Q_(folder) + ' .',
                                    { timeout: 900000, windowsHide: true, maxBuffer: 1 << 26 });
                                zipError = '';
                            } catch (e2) { zipError = String(e2.message || e2).slice(0, 120); }
                        }
                        if (fs.existsSync(zipPath)) { zipSize = fs.statSync(zipPath).size; zipError = ''; }
                        else { zipError = zipError || '压缩失败（未生成文件）'; zipPath = ''; }
                    } catch (e) { zipError = String(e.message || e).slice(0, 120); zipPath = ''; }
                }
                send(res, 200, JSON.stringify({ ok: true, count, skipped, cleaned, zip: zipPath, zipSize, zipError }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    if (url === '/api/share/open' && req.method === 'POST') {
        let raw = "";
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const folder = resolveShareFolder(b.folder);
                fs.mkdirSync(folder, { recursive: true });
                // Windows：调用独立脚本打开文件夹并强制置前（后台进程直接开 explorer 会被挡在后面）
                const Q = String.fromCharCode(34);
                const minimizeAll = (typeof b.minimize === 'boolean') ? b.minimize : (loadShare().minimize !== false);
                let cmd;
                if (process.platform === 'win32') {
                    const ps1 = path.join(__dirname, 'openFolder.ps1');
                // select：导出完要直接选中那个 zip，省得再找
                const sel = (b.select && fs.existsSync(String(b.select))) ? String(b.select) : '';
                    if (fs.existsSync(ps1)) {
                        cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + Q + ps1 + Q + ' -Folder ' + Q + folder + Q +
                        (minimizeAll ? ' -Minimize 1' : '') + (sel ? (' -Select ' + Q + sel + Q) : '');
                    } else {
                        cmd = sel
                        ? ('cmd /c explorer /select,' + Q + sel + Q)
                        : ('cmd /c explorer ' + Q + folder + Q);
                    }
                } else {
                    cmd = 'xdg-open ' + Q + folder + Q;
                }
                exec(cmd, () => {});
                send(res, 200, JSON.stringify({ ok: true, folder }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    // 从一个 mod 包文件夹导入：复制到工坊 / 本地 mod 目录，按 manifest 的启用顺序返回
    function doImport(folder) {
        if (!fs.existsSync(folder)) throw new Error('还没有可导入的内容：' + folder);
        const mfPath = path.join(folder, 'manifest.json');
        if (!fs.existsSync(mfPath)) throw new Error('该文件夹里没有 manifest.json，不是有效的 mod 包');
        const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8').replace(/^\uFEFF/, ''));
        const items = (mf.active || []).map(x => ({
            id: safeModId(typeof x === 'string' ? x : (x && x.id)),
            name: (x && (x.zh || x.name)) || '',
        })).filter(o => o.id);
        if (!items.length) throw new Error('manifest 里没有任何已启用的 mod');
        const ids = items.map(o => o.id);
        // 有工坊目录就装到工坊（Steam 版）；没有就装到游戏目录的 LocalMods（非 Steam 版）
        const P0 = getPaths();
        const W = (P0.WORKSHOP && fs.existsSync(P0.WORKSHOP)) ? P0.WORKSHOP : (P0.LOCALMODS || '');
        if (!W) throw new Error('既没有创意工坊目录，也没有本地 mod 目录，无法导入');
        fs.mkdirSync(W, { recursive: true });
        let imported = 0; const skipped = [];
        for (const id of ids) {
            const src = path.join(folder, id);
            if (!fs.existsSync(src)) { skipped.push(id); continue; }
            const dest = path.join(W, id);
            rmDirSync(dest); copyDir(src, dest); imported++;
        }
        return { imported: imported, skipped: skipped, active: ids, items: items };
    }

    // 对方发来的 zip：解压后直接导入（不用先手动解压、再跑到路径设置里填路径）
    if (url === '/api/share/import-zip' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const name = String(b.name || 'mods.zip');
                const buf = Buffer.from(String(b.data || ''), 'base64');
                if (!buf.length) throw new Error('没有收到 zip 内容');
                const tmp = path.join(os.tmpdir(), 'BaroImport_' + Date.now());
                rmDirSync(tmp); fs.mkdirSync(tmp, { recursive: true });
                const zp = path.join(tmp, 'pack.zip');
                fs.writeFileSync(zp, buf);
                const ex = path.join(tmp, 'x'); fs.mkdirSync(ex, { recursive: true });
                try {
                    execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path ' +
                        Q_(zp) + ' -DestinationPath ' + Q_(ex) + ' -Force"',
                        { timeout: 900000, windowsHide: true, maxBuffer: 1 << 26 });
                } catch (e) {
                    execSync('tar -x -f ' + Q_(zp) + ' -C ' + Q_(ex),
                        { timeout: 900000, windowsHide: true, maxBuffer: 1 << 26 });
                }
                // zip 里可能多包一层目录，往下找 manifest.json
                let target = '';
                (function walk(d, depth) {
                    if (target || depth > 4) return;
                    let ents = [];
                    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
                    for (const e of ents) {
                        if (target) return;
                        const p = path.join(d, e.name);
                        if (!e.isDirectory()) continue;
                        if (fs.existsSync(path.join(p, 'manifest.json'))) { target = p; return; }
                        walk(p, depth + 1);
                    }
                })(ex, 0);
                if (!target && fs.existsSync(path.join(ex, 'manifest.json'))) target = ex;
                if (!target) throw new Error('这个 zip 里没有 manifest.json，不是本工具导出的 mod 包');
                const r0 = doImport(target);
                try { rmDirSync(tmp); } catch (e) { }
                const out = { ok: true, fromZip: name };
                Object.keys(r0).forEach(k => { out[k] = r0[k]; });
                send(res, 200, JSON.stringify(out));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) })); }
        });
        return;
    }

    if (url === '/api/share/import' && req.method === 'POST') {
        let raw = "";
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const folder = resolveShareFolder(b.folder);
                const r0 = doImport(folder);
                send(res, 200, JSON.stringify({ ok: true, imported: r0.imported, skipped: r0.skipped, active: r0.active, items: r0.items }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    // 用 Steam 客户端或网页订阅创意工坊 mod（导入时缺的、或别人给的清单里的）
    if (url === '/api/steam/subscribe' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const ids = [];
                for (const x of (b.ids || [])) {
                    const id = String(x == null ? '' : x).trim();
                    if (__isWs(id) && !ids.includes(id)) ids.push(id);
                }
                const useWeb = b.mode === 'web';
                if (!ids.length) throw new Error('没有可订阅的创意工坊 mod（本地 mod 无法订阅）');
                if (ids.length > 30) throw new Error('一次最多订阅 30 个，当前 ' + ids.length + ' 个');
                ids.forEach((id, i) => {
                    const u = useWeb ? ('https://steamcommunity.com/sharedfiles/filedetails/?id=' + id) : ('steam://subscribe/' + id);
                    setTimeout(() => { try { exec('cmd /c start "" "' + u + '"'); } catch (e) { /* 忽略 */ } }, i * 400);
                });
                send(res, 200, JSON.stringify({ ok: true, count: ids.length, mode: useWeb ? 'web' : 'steam' }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // ---------- mod 方案存档 ----------
    if (url === '/api/presets/list') {
        try {
            fs.mkdirSync(PRESET_DIR, { recursive: true });
            const arr = fs.readdirSync(PRESET_DIR).filter(f => f.toLowerCase().endsWith('.json')).map(f => {
                const st = fs.statSync(path.join(PRESET_DIR, f));
                let count = 0;
                try { count = (JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8').replace(/^\uFEFF/, '')).active || []).length; } catch (e) { }
                return { name: f.slice(0, -5), count: count, savedAt: st.mtimeMs };
            }).sort((a, b) => b.savedAt - a.savedAt);
            send(res, 200, JSON.stringify({ ok: true, dir: PRESET_DIR, presets: arr }));
        } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        return;
    }

    if (url === '/api/presets/save' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const file = __presetFile(b.name);
                if (!file) throw new Error('请先给方案起个名字');
                if (!(b.list || []).length) throw new Error('当前没有已启用的 mod，没什么可存');
                fs.mkdirSync(PRESET_DIR, { recursive: true });
                const data = {
                    app: 'BarotraumaModSorter', type: 'preset',
                    savedAt: new Date().toISOString(),
                    active: (b.list || []).map(m => ({ id: safeModId(m && m.id), name: (m && (m.zh || m.name)) || '' })).filter(o => o.id),
                };
                if (!data.active.length) throw new Error('没有有效的 mod id');
                fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
                send(res, 200, JSON.stringify({ ok: true, name: path.basename(file, '.json'), count: data.active.length }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    if (url === '/api/presets/load' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const file = __presetFile(b.name);
                if (!file || !fs.existsSync(file)) throw new Error('找不到这个方案');
                const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
                const items = (d.active || []).map(x => ({
                    id: safeModId(typeof x === 'string' ? x : (x && x.id)),
                    name: (x && (x.zh || x.name)) || '',
                })).filter(o => o.id);
                send(res, 200, JSON.stringify({ ok: true, items: items }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    if (url === '/api/presets/delete' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const file = __presetFile(b.name);
                if (!file || !fs.existsSync(file)) throw new Error('找不到这个方案');
                fs.unlinkSync(file);
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    if (url === '/api/presets/open' && req.method === 'POST') {
        try {
            fs.mkdirSync(PRESET_DIR, { recursive: true });
            exec('cmd /c explorer "' + PRESET_DIR + '"');
            send(res, 200, JSON.stringify({ ok: true, dir: PRESET_DIR }));
        } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        return;
    }

    // 界面「退出」按钮调用：干净关闭服务（配合隐藏启动脚本，像正常软件一样退出）
    if (url === '/api/quit') {
        send(res, 200, JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 150);
        return;
    }

    if (url === '/icon.png' || url === '/favicon.ico') {
        const f = path.join(__dirname, 'app.png');
        if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), 'image/png');
        return send(res, 404, 'not found', 'text/plain');
    }

    send(res, 404, 'not found', 'text/plain');
});

// 端口自动顺延（避开系统保留段）
let port = PORT;
server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
        port += 1;
        if (port > PORT_START + 60) { console.log('找不到可用端口'); process.exit(1); }
        server.listen(port, '127.0.0.1');
    } else {
        console.log(e.message);
    }
});
server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(__dirname, 'server.port'), String(port), 'utf8');
    // 首次运行记录一份版本基线，供「检查更新」对比
    if (!loadVersions()) {
        try { saveVersions(scanModVersions()); console.log('  已记录 mod 版本基线'); } catch (e) { /* 忽略 */ }
    }

    // 监听就绪后打开独立 App 窗口（本地工具，双击即用）
    try {
        openAppWindow('http://127.0.0.1:' + port + '/');
    } catch (e) { /* 忽略：窗口打开失败不影响服务 */ }
    console.log('=========================================');
    console.log('  潜渊症 Mod 可视化管理');
    console.log('  http://127.0.0.1:' + port);
    const PP = getPaths();
    console.log('  游戏目录：' + PP.GAME);
    console.log('  创意工坊：' + PP.WORKSHOP);
    console.log('  关闭此窗口即停止服务');
    console.log('=========================================');
});
