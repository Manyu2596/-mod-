/**
 * 潜渊症 Mod 可视化管理（本地服务）
 * 浏览器打开后可直接拖拽排序、勾选启用，点保存即写入游戏配置
 * 只监听 127.0.0.1，不对外暴露
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const MAX_BODY = 256 * 1024 * 1024;   // 请求体上限 256MB（zip 走 base64 会膨胀约 1.4 倍）

// 本地工具：任何漏网的异常都不该让服务直接退出，记到 server.err 里继续活着
function logFatal(kind, e) {
    try {
        fs.appendFileSync(path.join(__dirname, 'server.err'),
            new Date().toISOString() + ' ' + kind + ': ' + ((e && e.stack) || e) + '\n', 'utf8');
    } catch (_) { }
    try { console.error('[' + kind + ']', e && e.message); } catch (_) { }
}
process.on('uncaughtException', e => logFatal('uncaught', e));
process.on('unhandledRejection', e => logFatal('rejection', e));
const https = require('https');
const os = require('os');

const lib = require('./sort.js');
const { analyze, classify, loadEnabledIds, detectSeries, GAME_VERSION,
    getPaths, refreshPaths, saveUserPaths, loadUserPaths } = lib;

// 配置路径随探测结果变化，每次现取（支持运行时重新检测 / 手动改路径）
function configPath() { return path.join(getPaths().GAME, 'config_player.xml'); }
// ---------- 用户数据目录 ----------
// 程序目录（dist / 安装目录）每次更新版本、重新打包都会被整个重建，所以「存档备份 / mod 方案存档 /
// 配置回滚历史 / 译文 / 版本基线」一律不放在程序目录里。
// 默认也不放 C 盘：自动挑一个非系统盘（剩余空间最大的那个）建「潜渊症Mod管理器数据」；
// 想放哪都行 —— 设环境变量 BARO_DATA，或在界面「存档管理 → 更换数据目录」里指定。
const DATA_DIR_NAME = '潜渊症Mod管理器数据';
const REG_KEY = 'HKCU\\Software\\潜渊症Mod管理器';

function regGetDataDir() {
    try {
        const out = execSync('reg query "' + REG_KEY + '" /v DataDir', { windowsHide: true, timeout: 4000 }).toString();
        const m = out.match(/DataDir\s+REG_SZ\s+(.+)/);
        return m ? m[1].trim() : '';
    } catch (e) { return ''; }
}
function regSetDataDir(dir) {
    try {
        execSync('reg add "' + REG_KEY + '" /v DataDir /t REG_SZ /d "' + dir + '" /f', { windowsHide: true, timeout: 4000 });
        return true;
    } catch (e) { return false; }
}

// 列出固定磁盘（带剩余空间），系统盘排最后 —— 给自动选择和界面候选列表用
function candidateDrives() {
    const out = [];
    try {
        const txt = execSync('wmic logicaldisk where "drivetype=3" get caption,freespace /value', { windowsHide: true, timeout: 8000 }).toString();
        txt.split(/\r?\n\s*\r?\n/).forEach(b => {
            const cap = (b.match(/Caption=([A-Za-z]:)/) || [])[1];
            const free = (b.match(/FreeSpace=(\d+)/) || [])[1];
            if (cap) out.push({ drive: cap.toUpperCase(), free: free ? Number(free) : 0, dir: path.join(cap.toUpperCase() + '\\', DATA_DIR_NAME) });
        });
    } catch (e) { }
    if (!out.length) {
        for (let c = 68; c <= 90; c++) {   // D..Z
            const L = String.fromCharCode(c);
            if (fs.existsSync(L + ':\\')) out.push({ drive: L + ':', free: 0, dir: path.join(L + ':\\', DATA_DIR_NAME) });
        }
    }
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    return out.sort((a, b) => {
        if ((a.drive === sys) !== (b.drive === sys)) return a.drive === sys ? 1 : -1;
        return b.free - a.free;
    });
}

function resolveDataDir() {
    const tryMk = d => { try { fs.mkdirSync(d, { recursive: true }); return d; } catch (e) { return ''; } };
    const env = (process.env.BARO_DATA || '').trim();
    if (env) { const r = tryMk(env); if (r) return r; }
    const saved = regGetDataDir();
    if (saved) { const r = tryMk(saved); if (r) return r; }
    for (const c of candidateDrives()) { const r = tryMk(c.dir); if (r) return r; }   // 优先非系统盘
    const sysDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(), DATA_DIR_NAME);
    const r2 = tryMk(sysDir);
    if (r2) return r2;
    return __dirname;   // 都建不了就退回程序目录，至少还能用
}

let DATA_DIR, TRANS, USER_ZH, SIZE_CACHE, VERSIONS, SHARE_FILE, PRESET_DIR, BACKUP_ROOT, EXPORT_DIR;
function applyDataDir(dir) {
    DATA_DIR = dir;
    TRANS = path.join(dir, 'translations.json');
    USER_ZH = path.join(dir, 'user_zh.json');
    SIZE_CACHE = path.join(dir, 'modsize.json');
    VERSIONS = path.join(dir, 'versions.json');
    SHARE_FILE = path.join(dir, 'share.json');
    PRESET_DIR = path.join(dir, 'presets');
    BACKUP_ROOT = path.join(dir, 'savebackups');
    EXPORT_DIR = path.join(dir, 'exported_mods');
}
applyDataDir(resolveDataDir());
console.log('数据目录：' + DATA_DIR);

// ---------- 旧位置的数据搬过来（只复制不删除，原处留着当备份） ----------
const USER_DATA_ITEMS = [
    { name: 'versions.json', dir: false }, { name: 'translations.json', dir: false },
    { name: 'user_zh.json', dir: false }, { name: 'share.json', dir: false },
    { name: 'modsize.json', dir: false },
    { name: 'presets', dir: true }, { name: 'savebackups', dir: true },
    { name: 'confighistory', dir: true }, { name: 'exported_mods', dir: true },
    { name: '导出的mod', dir: true },
];
function copyDirInto(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const a = path.join(src, e.name), b = path.join(dst, e.name);
        if (e.isDirectory()) copyDirInto(a, b);
        else { try { fs.copyFileSync(a, b); } catch (err) { } }
    }
}
function migrateUserData(from) {
    if (!from || path.resolve(from) === path.resolve(DATA_DIR)) return 0;
    let n = 0;
    USER_DATA_ITEMS.forEach(it => {
        const src = path.join(from, it.name);
        const dst = path.join(DATA_DIR, it.name);
        if (!fs.existsSync(src) || fs.existsSync(dst)) return;
        try {
            if (it.dir) copyDirInto(src, dst); else fs.copyFileSync(src, dst);
            n++;
            console.log('用户数据已迁移：' + src + ' -> ' + dst);
        } catch (e) { console.log('迁移失败（忽略）：' + it.name + ' — ' + e.message); }
    });
    return n;
}

// 老版本把数据放在程序目录里，上一版默认位置是 %LOCALAPPDATA%（C 盘）—— 两个都扫一遍
if (DATA_DIR !== __dirname) {
    migrateUserData(__dirname);
    const legacy = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '', DATA_DIR_NAME);
    if (legacy && fs.existsSync(legacy)) migrateUserData(legacy);
}

const UI = path.join(__dirname, 'ui.html');
const ZH_PATH = path.join(__dirname, 'zh.json');
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
        writeFileAtomic(TRANS, JSON.stringify(trans, null, 2), 'utf8');
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

// ---------- 拼音首字母（未启用列表按 A→Z 排序用）----------
// 不依赖第三方库：用 zh 排序规则，配合每个拼音首字母的代表字定位所属字母段
const PY_BOUND = [
    ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'], ['G', '嘎'],
    ['H', '哈'], ['J', '击'], ['K', '咖'], ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '哦'],
    ['P', '趴'], ['Q', '七'], ['R', '然'], ['S', '撒'], ['T', '他'], ['W', '挖'], ['X', '西'],
    ['Y', '丫'], ['Z', '匝'],
];
const PY_CACHE = {};
function pyName(m) { return String((m && (m.zh || m.name)) || ''); }
function pyLetterOf(m) {
    const s = pyName(m).replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '');
    if (!s) return '#';
    const c = s[0];
    if (/[a-zA-Z]/.test(c)) return c.toUpperCase();
    if (/[0-9]/.test(c)) return '#';
    if (!/[\u4e00-\u9fa5]/.test(c)) return '#';
    if (PY_CACHE[c]) return PY_CACHE[c];
    let letter = '#';
    for (const b of PY_BOUND) {
        if (c.localeCompare(b[1], 'zh') >= 0) letter = b[0]; else break;
    }
    PY_CACHE[c] = letter;
    return letter;
}
function sortByPinyin(arr) {
    arr.sort((a, b) => {
        const la = pyLetterOf(a), lb = pyLetterOf(b);
        if (la !== lb) return la < lb ? -1 : 1;
        return pyName(a).localeCompare(pyName(b), 'zh', { numeric: true, sensitivity: 'base' });
    });
    return arr;
}
// ---------- mod 体积缓存（首次扫描后落盘，之后按 id+版本 复用）----------
let __sizeCache = null, __sizeDirty = false;
function loadSizeCache() {
    if (__sizeCache) return __sizeCache;
    try { __sizeCache = JSON.parse(fs.readFileSync(SIZE_CACHE, 'utf8')); } catch (e) { __sizeCache = {}; }
    return __sizeCache;
}
function saveSizeCache() {
    if (!__sizeDirty || !__sizeCache) return;
    try { writeFileAtomic(SIZE_CACHE, JSON.stringify(__sizeCache), 'utf8'); } catch (e) { }
    __sizeDirty = false;
}
function dirStats(dir) {
    let bytes = 0, files = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            files++;
            try { bytes += fs.statSync(p).size; } catch (err) { }
        }
    }
    return { bytes, files };
}
function modStats(id, a, base) {
    const cache = loadSizeCache();
    const key = String(id) + '|' + String((a && a.modversion) || '-');
    if (cache[key] && typeof cache[key].bytes === 'number') return cache[key];
    const s = dirStats(path.join(base, id));
    cache[key] = { bytes: s.bytes, files: s.files, ts: Date.now() };
    __sizeDirty = true;
    return cache[key];
}
function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
}

// ---------- 覆盖关系：谁盖住了谁（按真实标识符比对，不靠名字猜）----------
function modDirOf(m) {
    const P = getPaths();
    const w = path.join(P.WORKSHOP, String(m.id));
    if (fs.existsSync(path.join(w, 'filelist.xml'))) return w;
    if (P.LOCALMODS) {
        const l = path.join(P.LOCALMODS, String(m.id));
        if (fs.existsSync(path.join(l, 'filelist.xml'))) return l;
    }
    return w;
}
// 覆盖关系扫描结果的缓存（放在模块作用域，跨请求复用；key 变了才重扫）
let __ovCache = { key: '', out: null };
function collectIdentifiers(mods) {
    const vanilla = vanillaIdentifiers();
    const map = {};
    mods.forEach(m => {
        const dir = modDirOf(m);
        const fl = path.join(dir, 'filelist.xml');
        if (!fs.existsSync(fl)) return;
        let xml;
        try { xml = fs.readFileSync(fl, 'utf8'); } catch (e) { return; }
        const seen = new Set();
        let scanned = 0;
        for (const f of xml.matchAll(/<\w+\s+file="([^"]+)"/g)) {
            if (scanned++ > 80) break;
            const rel = f[1].replace('%ModDir%', '').replace(/^[/\\]/, '');
            const p = path.join(dir, rel);
            try {
                if (!fs.existsSync(p)) continue;
                if (fs.statSync(p).size > 2 * 1024 * 1024) continue;
                const s = fs.readFileSync(p, 'utf8');
                const re = new RegExp('<(?:' + DEF_TAGS + ')\\b[^>]*?identifier="([^"]+)"', 'g');
                let r;
                while ((r = re.exec(s)) !== null) {
                    if (seen.has(r[1]) || vanilla.has(r[1])) continue;
                    seen.add(r[1]);
                    (map[r[1]] = map[r[1]] || []).push(String(m.id));
                }
            } catch (e) { }
        }
    });
    return map;
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
            const st = modStats(id, a, base);
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
                sizeBytes: st.bytes, files: st.files, sizeText: fmtSize(st.bytes),
            }));
        });
    };

    scanOne(W);     // Steam 创意工坊
    scanOne(LM);    // 游戏目录里的 LocalMods（非 Steam 版 / 手动放的 mod）

    fillDeps(mods); // 推断每个 mod 的前置依赖（框架 / 系列本体）

    // 已启用的按当前配置顺序，未启用的按推荐顺序
    const active = pkgs
        .map(p => mods.find(m => m.id === p.id))
        .filter(Boolean)
        .map(m => Object.assign(m, { cat: m.cat }));
    const idle = mods.filter(m => !enabledIds.has(m.id));
    sortByPinyin(idle);                       // 未启用：按名称首字母拼音 A→Z，方便按字母翻找
    idle.forEach(m => { m.py = pyLetterOf(m); });

    saveSizeCache();
    return { active, idle, trans: loadTrans() };
}

// 原子写：先写同目录临时文件，再 rename 覆盖。
// 直接 writeFileSync 时如果中途崩了/断电，文件就是半截内容 —— config_player.xml 半截 = 游戏起不来。
function writeFileAtomic(file, text, enc) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, enc || 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch (e) {
        // 少数情况（跨卷 / 被占用）rename 会失败，退回复制+删除
        try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
        catch (e2) { try { fs.unlinkSync(tmp); } catch (e3) { } throw e; }
    }
}

// 跑外部命令但不卡住服务（exec 是异步的，execSync 会把整个界面冻住）
function runCmd(cmd, ms) {
    return new Promise(resolve => {
        exec(cmd, { timeout: ms || 900000, windowsHide: true, maxBuffer: 1 << 26 },
            err => resolve(err ? String(err.message || err) : ''));
    });
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

    // 历史快照：保留最近 12 份，供面板「配置回滚」使用
    try {
        const hd = path.join(DATA_DIR, 'confighistory');
        fs.mkdirSync(hd, { recursive: true });
        const d = new Date();
        const p2 = n => String(n).padStart(2, '0');
        const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
        fs.writeFileSync(path.join(hd, 'config_' + stamp + '.xml'), xml, 'utf8');
        const all = fs.readdirSync(hd).filter(f => /^config_.*\.xml$/.test(f)).sort().reverse();
        all.slice(12).forEach(f => { try { fs.unlinkSync(path.join(hd, f)); } catch (e) { } });
    } catch (e) { }

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
        if (i < 0) throw new Error('配置里找不到 </config>，已放弃写入（避免把 config_player.xml 写坏）。请在游戏里启动一次让它重新生成，或删掉该文件后重开游戏');
        out = out.slice(0, i) + block + '</config>' + out.slice(i + '</config>'.length);
    }
    writeFileAtomic(configPath(), out, 'utf8');
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

// 最近一次生成的订阅清单 HTML（供 GET /subscribe 以 http 方式打开；file:// 页面里的 steam:// 会被浏览器静默拦截）
let LAST_SUB_HTML = '';

// 通过 Steam 启动游戏（本地服务，仅在本机生效）
function launchGame() {
    try {
        exec('cmd /c start "" "steam://rungameid/602960"');
        return true;
    } catch (e) {
        return false;
    }
}

// ---------- 前置依赖推断 ----------
// Steam 工坊的「必需物品」字段绝大多数作者不填，所以这里从 mod 自身内容与命名推断：
//  1) 脚本框架：带 Lua/C# 的 mod 需要 LuaCsForBarotrauma
//  2) 系列本体：名字里带「补丁/扩展/汉化/兼容」的 mod，需要同系列的那个本体 mod
function fillDeps(mods) {
    const norm = (s) => __normName(String(s || ''));
    const isFrame = (m) => /luacs|^csforbarotrauma/i.test(m.name || '');
    const kwAddon = /(补丁|patch|扩展|拓展|expansion|extra|add-?on|汉化|简体|中文|chinese|兼容|compat)/i;
    const luaFrame = mods.find(m => /^luacsforbarotrauma/i.test(m.name || ''));
    mods.forEach(m => {
        const deps = [];
        const nm = norm(m.name);
        const isAddon = kwAddon.test(m.name || '') || kwAddon.test(m.zh || '');
        // 1) 脚本框架
        if (luaFrame && luaFrame.id !== m.id && !isFrame(m) && (m.hasLua || m.hasCs)) {
            deps.push({ id: luaFrame.id, name: luaFrame.name, why: 'Lua/C# 脚本需要框架' });
        }
        // 2) 系列本体：本 mod 名字以某个非补丁类 mod 的名字开头
        if (isAddon) {
            const base = mods
                .filter(x => x.id !== m.id && !isFrame(x) && !kwAddon.test(x.name || ''))
                .map(x => ({ m: x, n: norm(x.name) }))
                .filter(x => x.n.length >= 4 && nm.indexOf(x.n) === 0)
                .sort((a, b) => b.n.length - a.n.length)[0];
            if (base) deps.push({ id: base.m.id, name: base.m.name, why: '扩展/补丁需要本体' });
        }
        // 去重
        const seen = new Set();
        m.deps = deps.filter(d => !seen.has(d.id) && seen.add(d.id));
        m.depsNames = m.deps.map(d => d.name);
    });
}

// ---------- mod 更新检测（离线：对比本机会话的版本快照）----------

function loadVersions() {
    try { return JSON.parse(fs.readFileSync(VERSIONS, 'utf8')); } catch (e) { return null; }
}
function saveVersions(v) {
    writeFileAtomic(VERSIONS, JSON.stringify(v, null, 2), 'utf8');
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
        // 本地 mod（LocalMods）也要参与，不能只查工坊目录
        let dir = modDirOf(m);
        if (!fs.existsSync(path.join(dir, 'filelist.xml'))) dir = path.join(W, String(m.id));
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
function loadShare() { try { return JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch (e) { return {}; } }
function saveShare(o) { writeFileAtomic(SHARE_FILE, JSON.stringify(o, null, 2), 'utf8'); }
function __escShare(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function __isWs(id) { return /^[0-9]{5,}$/.test(String(id == null ? '' : id).trim()); }
// 模型翻译返回的键偶尔会丢空格/标点（如 DontOpenDebugConsoleOnErrors），
// 显示时按去掉空格标点后的键兜底匹配，避免译文看起来像没保存
function __normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, ''); }
// 默认就放在软件自己的文件夹里
function defaultShareFolder() {
    const nw = EXPORT_DIR;
    const old = path.join(DATA_DIR, '导出的mod');
    try { if (!fs.existsSync(nw) && fs.existsSync(old)) fs.renameSync(old, nw); } catch (e) { }
    return nw;
}
// 没填就用记住的，再没有就用软件目录内的默认文件夹
function resolveShareFolder(f) { return (f && String(f).trim()) || loadShare().folder || defaultShareFolder(); }

// ---------- mod 方案存档：一套启用列表存一个文件，换存档时来回切换 ----------
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
    const clen = parseInt(req.headers['content-length'] || '0', 10);
    if (clen > MAX_BODY) {
        return send(res, 413, JSON.stringify({ ok: false, error: '请求体过大（上限 ' + Math.round(MAX_BODY / 1048576) + ' MB），已拒绝' }));
    }

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
                const notes = sortedEnabled.notes || [];

                const disabledMods = list.filter(x => !x.enabled).map(x => byId[x.id]).filter(Boolean);
                sortByPinyin(disabledMods);
                const out = sortedEnabled.map(m => ({ id: m.id, enabled: true }))
                    .concat(disabledMods.map(m => ({ id: m.id, enabled: false })));
                send(res, 200, JSON.stringify({ ok: true, list: out, notes: notes }));
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
                    const depNames = (m.depsNames && m.depsNames.length)
                        ? m.depsNames
                        : (m.deps || []).map(d => (d && d.name) || d);
                    depNames.forEach(dep => {
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
                writeFileAtomic(USER_ZH, JSON.stringify(store, null, 2), 'utf8');
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
            // 路径失效时 scanModVersions 会返回空，此时写基线会把所有 mod 记成「已移除」
            if (prev && Object.keys(prev).length && Object.keys(current).length === 0) {
                return send(res, 200, JSON.stringify({ ok: true, warn: '这次没扫描到任何 mod（路径可能失效），原有版本基线未改动', updated: [], added: [], removed: [], count: Object.keys(prev).length }));
            }
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
    // ---------- 存档管理 ----------
    // 单人存档在游戏存档根目录（*.save），多人存档在 Multiplayer 子目录里；
    // 一个存档槽 = <名字>.save + 可选的 <名字>_CharacterData.xml

    function saveDirs() {
        const inst = getPaths().INSTALLED;
        const root = inst ? path.resolve(inst, '..', '..') : '';
        return { root, single: root, multi: root ? path.join(root, 'Multiplayer') : '' };
    }
    function listSaves(dir) {
        const map = {};
        if (!dir || !fs.existsSync(dir)) return [];
        const all = fs.readdirSync(dir);
        const files = all.filter(f => f[0] !== '.' && fs.statSync(path.join(dir, f)).isFile());
        files.filter(f => /\.save$/i.test(f)).forEach(f => {
            const n = f.slice(0, -5);
            const st = fs.statSync(path.join(dir, f));
            map[n] = { name: n, files: [f], size: st.size, mtime: st.mtime.getTime() };
        });
        files.forEach(f => {
            Object.keys(map).forEach(n => {
                if (f.indexOf(n + '_') === 0 && /\.(xml|xml\.bk\d*)$/i.test(f)) {
                    const st = fs.statSync(path.join(dir, f));
                    map[n].files.push(f);
                    map[n].size += st.size;
                    map[n].mtime = Math.max(map[n].mtime, st.mtime.getTime());
                }
            });
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => b.mtime - a.mtime);
    }
    function safeBackupPath(id) {
        const p = path.resolve(BACKUP_ROOT, String(id || '').replace(/^[/\\]+/, ''));
        if (p !== BACKUP_ROOT && !p.startsWith(BACKUP_ROOT + path.sep)) return '';
        return p;
    }
    function walkBackups() {
        const out = [];
        if (!fs.existsSync(BACKUP_ROOT)) return out;
        ['single', 'multi'].forEach(kind => {
            const kd = path.join(BACKUP_ROOT, kind);
            if (!fs.existsSync(kd)) return;
            fs.readdirSync(kd).forEach(slot => {
                const sd = path.join(kd, slot);
                if (!fs.statSync(sd).isDirectory()) return;
                fs.readdirSync(sd).forEach(ts => {
                    const td = path.join(sd, ts);
                    if (!fs.statSync(td).isDirectory()) return;
                    let size = 0, count = 0;
                    fs.readdirSync(td).forEach(f => {
                        const st = fs.statSync(path.join(td, f));
                        size += st.size; count++;
                    });
                    out.push({ id: kind + '/' + slot + '/' + ts, kind, name: slot, ts, size, count });
                });
            });
        });
        return out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    }

    if (url === '/api/saves') {
        try {
            const D = saveDirs();
            send(res, 200, JSON.stringify({
                ok: true, dirSingle: D.single, dirMulti: D.multi,
                single: listSaves(D.single), multi: listSaves(D.multi),
                backups: walkBackups(), backupRoot: BACKUP_ROOT, dataDir: DATA_DIR,
            }));
        } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        return;
    }
    if (url === '/api/saves/backup' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const D = saveDirs();
                const dir = b.kind === 'multi' ? D.multi : D.single;
                if (!dir || !fs.existsSync(dir)) throw new Error('找不到存档目录');
                const slot = listSaves(dir).find(x => x.name === b.name);
                if (!slot) throw new Error('没找到这个存档：' + b.name);
                const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) +
                    '-' + String(Date.now() % 1000).padStart(3, '0');
                const dest = path.join(BACKUP_ROOT, b.kind === 'multi' ? 'multi' : 'single', b.name, stamp);
                fs.mkdirSync(dest, { recursive: true });
                slot.files.forEach(f => fs.copyFileSync(path.join(dir, f), path.join(dest, f)));
                send(res, 200, JSON.stringify({ ok: true, dest, count: slot.files.length }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    if (url === '/api/saves/restore' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const src = safeBackupPath(b.id);
                if (!src || !fs.existsSync(src)) throw new Error('备份不存在');
                const parts = String(b.id).split('/');
                const kind = parts[0], slotName = parts[1];
                const D = saveDirs();
                const dir = kind === 'multi' ? D.multi : D.single;
                if (!dir || !fs.existsSync(dir)) throw new Error('找不到存档目录');
                // 恢复前先把当前状态另存一份，避免覆盖后回不去
                const cur = listSaves(dir).find(x => x.name === slotName);
                if (cur) {
                    const stamp = ('__自动备份_' + new Date().toISOString()).replace(/[:T]/g, '-').slice(0, 40);
                    const dest = path.join(BACKUP_ROOT, kind, slotName, stamp);
                    fs.mkdirSync(dest, { recursive: true });
                    cur.files.forEach(f => fs.copyFileSync(path.join(dir, f), path.join(dest, f)));
                }
                let n = 0;
                fs.readdirSync(src).forEach(f => {
                    fs.copyFileSync(path.join(src, f), path.join(dir, f));
                    n++;
                });
                send(res, 200, JSON.stringify({ ok: true, restored: n }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    if (url === '/api/saves/delete' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const p = safeBackupPath(b.id);
                if (!p || !fs.existsSync(p)) throw new Error('备份不存在');
                fs.rmSync(p, { recursive: true, force: true });
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    if (url === '/api/saves/open' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const D = saveDirs();
                let dir = BACKUP_ROOT;
                if (b.target === 'single') dir = D.single;
                else if (b.target === 'multi') dir = D.multi;
                else fs.mkdirSync(BACKUP_ROOT, { recursive: true });
                if (dir && fs.existsSync(dir)) {
                    try { spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref(); }
                    catch (e) { exec('explorer "' + dir.replace(/"/g, '') + '"', () => { }); }
                }
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // 联机自检：游戏联机时用的是 Installed 目录（不是工坊下载目录），
    // mod 没同步过去、或两边版本不一致，加入别人游戏就会被要求重新下载
    // 覆盖关系：已启用 mod 之间谁覆盖了谁（按真实标识符，不靠名字猜）
    // 覆盖关系：扫描很贵，按「启用清单 + 各 mod 版本」缓存，列表没变就直接复用
    if (url === '/api/overrides') {
        try {
            const data = buildData();
            const enabled = data.active;                 // 已是当前加载顺序
            const ck = enabled.map(m => String(m.id) + ':' + String(m.modversion || '-')).join(',');
            if (__ovCache.key === ck && __ovCache.out) {
                return send(res, 200, JSON.stringify(Object.assign({ ok: true, cached: true }, __ovCache.out)));
            }
            const map = collectIdentifiers(enabled);
            const pos = {};
            enabled.forEach((m, i) => { pos[String(m.id)] = i; });
            const pairs = {};
            Object.keys(map).forEach(ident => {
                const ids = map[ident];
                if (ids.length < 2) return;
                const ord = ids.map(x => pos[x]).filter(i => i !== undefined).sort((a, b) => a - b);
                for (let i = 0; i + 1 < ord.length; i++) {
                    const A = enabled[ord[i]], B = enabled[ord[i + 1]];
                    if (!A || !B) continue;
                    const key = String(A.id) + '>' + String(B.id);
                    if (!pairs[key]) pairs[key] = {
                        a: { id: A.id, name: A.zh || A.name },
                        b: { id: B.id, name: B.zh || B.name },
                        idents: [],
                    };
                    pairs[key].idents.push(ident);
                }
            });
            const out = Object.keys(pairs).map(k => ({
                a: pairs[k].a, b: pairs[k].b,
                count: pairs[k].idents.length,
                idents: pairs[k].idents.slice(0, 8),
            })).sort((x, y) => y.count - x.count).slice(0, 30);
            __ovCache = { key: ck, out: { pairs: out, scanned: enabled.length } };
            send(res, 200, JSON.stringify({ ok: true, pairs: out, scanned: enabled.length }));
        } catch (e) {
            send(res, 500, JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // 数据目录：现在在哪、还能换到哪
    if (url === '/api/datadir') {
        send(res, 200, JSON.stringify({
            ok: true, dataDir: DATA_DIR,
            fromEnv: !!((process.env.BARO_DATA || '').trim()),
            candidates: candidateDrives().map(c => ({ drive: c.drive, dir: c.dir, freeGB: Math.round(c.free / 1073741824) })),
        }));
        return;
    }
    if (url === '/api/datadir/set' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw) || {};
                let dir = String(b.dir || '').trim();
                if (!dir) { send(res, 400, JSON.stringify({ ok: false, error: '没填目录' })); return; }
                dir = path.resolve(dir);
                try {
                    fs.mkdirSync(dir, { recursive: true });
                    const probe = path.join(dir, '.write_test');
                    fs.writeFileSync(probe, '1'); fs.unlinkSync(probe);
                } catch (e) { send(res, 400, JSON.stringify({ ok: false, error: '这个目录建不了或没权限写：' + e.message })); return; }
                const moved = migrateUserData(DATA_DIR);   // 旧目录的东西搬过去（只复制，不删旧的）
                applyDataDir(dir);
                const saved = regSetDataDir(dir);
                send(res, 200, JSON.stringify({ ok: true, dataDir: DATA_DIR, moved, saved }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // 配置历史（每次保存到游戏前自动留一份）
    if (url === '/api/config/history') {
        try {
            const hd = path.join(DATA_DIR, 'confighistory');
            const items = [];
            if (fs.existsSync(hd)) {
                fs.readdirSync(hd).filter(f => /^config_.*\.xml$/.test(f)).sort().reverse().forEach(f => {
                    let txt = '';
                    try { txt = fs.readFileSync(path.join(hd, f), 'utf8'); } catch (e) { return; }
                    const m = txt.match(/<regularpackages>([\s\S]*?)<\/regularpackages>/);
                    let count = 0;
                    if (m) { const re = /<package\s/g; while (re.exec(m[1])) count++; }
                    const names = [];
                    const nre = /<!--([\s\S]*?)-->/g;
                    let r;
                    while ((r = nre.exec(txt)) !== null) { const s2 = r[1].trim(); if (s2) names.push(s2); }
                    items.push({
                        file: f,
                        time: f.replace(/^config_/, '').replace(/\.xml$/, '').replace('-', ' '),
                        count, names: names.slice(0, 4),
                    });
                });
            }
            send(res, 200, JSON.stringify({ ok: true, items }));
        } catch (e) {
            send(res, 500, JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    if (url === '/api/config/restore' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const file = String((b && b.file) || '');
                if (!/^config_[A-Za-z0-9\-_]+\.xml$/.test(file)) return send(res, 400, JSON.stringify({ ok: false, error: '备份名不合法' }));
                const hd = path.join(DATA_DIR, 'confighistory');
                const f = path.join(hd, file);
                if (!fs.existsSync(f)) return send(res, 404, JSON.stringify({ ok: false, error: '找不到这份备份' }));
                const cp = configPath();
                try { fs.writeFileSync(cp + '.bak', fs.readFileSync(cp, 'utf8')); } catch (e) { }
                const txt = fs.readFileSync(f, 'utf8');
                writeFileAtomic(cp, txt, 'utf8');
                const m = txt.match(/<regularpackages>([\s\S]*?)<\/regularpackages>/);
                let count = 0;
                if (m) { const re = /<package\s/g; while (re.exec(m[1])) count++; }
                send(res, 200, JSON.stringify({ ok: true, count }));
            } catch (e) {
                send(res, 200, JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }
    if (url === '/api/joincheck') {
        try { send(res, 200, JSON.stringify(Object.assign({ ok: true }, joinCheck()))); }
        catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        return;
    }
    function joinCheck() {
        const P = getPaths();
        const W = P.WORKSHOP || '', I = P.INSTALLED || '', LM = P.LOCALMODS || '';
        const data = buildData();
        const readV = (p) => {
            try { const t = fs.readFileSync(p, 'utf8'); return (/modversion="([^"]*)"/i.exec(t) || [, '-'])[1]; }
            catch (e) { return '-'; }
        };
        const problems = [];
        (data.active || []).forEach(m => {
            const id = String(m.id);
            const inW = W ? fs.existsSync(path.join(W, id, 'filelist.xml')) : false;
            const inL = LM ? fs.existsSync(path.join(LM, id, 'filelist.xml')) : false;
            const inI = I ? fs.existsSync(path.join(I, id, 'filelist.xml')) : false;
            const nm = m.zh || m.name;
            if (!inW && !inL) { problems.push({ id, name: nm, kind: 'missing', why: '本机没有这个 mod 的文件（Steam 还没下载完，或被取消订阅）' }); return; }
            if (!inI) { problems.push({ id, name: nm, kind: 'notinstalled', why: '还没同步到游戏加载目录，启动一次单人游戏才会复制过去' }); return; }
            if (inW) {
                const vw = readV(path.join(W, id, 'filelist.xml'));
                const vi = readV(path.join(I, id, 'filelist.xml'));
                if (vw !== vi) problems.push({ id, name: nm, kind: 'stale', why: '游戏加载目录是 v' + vi + '，工坊最新是 v' + vw + '，联机会被要求重新下载' });
            }
        });
        return { total: (data.active || []).length, problems };
    }

    if (url === '/api/paths/rescan' && req.method === 'POST') {
        try {
            const P = refreshPaths();
            VANILLA = null;                // 重新检测后原版标识符缓存作废
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
                VANILLA = null;            // 换了游戏目录，原版标识符缓存作废
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
        send(res, 200, JSON.stringify({ ok: true, folder: sh.folder || defaultShareFolder(), minimize: sh.minimize === true }));
        return;
    }

    if (url === '/api/share/set' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw);
                const prev = loadShare();
                saveShare({ folder: (b.folder || '').trim(), minimize: b.minimize === undefined ? (prev.minimize === true) : !!b.minimize });
                send(res, 200, JSON.stringify({ ok: true }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // 导出：把当前已启用的 mod 整个目录复制到共享文件夹，并写一份 manifest.json
    if (url === '/api/share/export' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', async () => {
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
                    // 导出目录不能落在游戏 / 创意工坊 / 已安装 / 本地 mod 目录里，否则下面的清理会删掉真正的 mod
                    const PG = getPaths();
                    const rf = path.resolve(folder).toLowerCase();
                    const risky = [PG.GAME, PG.WORKSHOP, PG.INSTALLED, PG.LOCALMODS]
                        .filter(Boolean).map(d => path.resolve(d).toLowerCase());
                    if (!risky.some(d => rf === d || rf.startsWith(d + path.sep))) {
                        for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
                            if (!e.isDirectory()) continue;
                            if (keep.has(e.name)) continue;
                            if (!safeModId(e.name)) continue;
                            rmDirSync(path.join(folder, e.name));
                            cleaned++;
                        }
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
                    const wsList = (b.list || []).filter(m => __isWs(m && m.id))
                        .map(m => ({ id: String(m.id), name: m.name || '', zh: m.zh || '' }));
                    if (wsList.length) {
                        // 失效的（被作者删除/转私密）不能进订阅清单，否则对方点了就是 404 报错页
                        const aliveMap = await new Promise(resolve => checkWsAlive(wsList.map(m => m.id), resolve));
                        const liveList = aliveMap ? wsList.filter(m => aliveMap.get(m.id) !== false) : wsList;
                        if (liveList.length) {
                            const genAt2 = new Date().toLocaleString('zh-CN', { hour12: false });
                            fs.writeFileSync(path.join(folder, 'subscribe.html'), subHtmlFor(liveList, genAt2), 'utf8');
                        }
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
                        // 只清自己生成过的 zip；outDir 是用户目录时不扫不删，避免误删别人的文件
                        const defExp = path.resolve(EXPORT_DIR);
                        const canClean = path.resolve(outDir) === defExp || path.resolve(outDir) === path.resolve(__dirname);
                        if (canClean) {
                            try {
                                for (const f of fs.readdirSync(outDir)) {
                                    if (/^BarotraumaMods-\d+mods-\d{8}-\d{4}\.zip$/i.test(f) || f.toLowerCase() === 'mods_pack.zip') {
                                        try { fs.unlinkSync(path.join(outDir, f)); } catch (e) { }
                                    }
                                }
                            } catch (e) { }
                        }
                        try {
                            const cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path ' +
                                Q_(path.join(folder, '*')) + ' -DestinationPath ' + Q_(zipPath) +
                                ' -CompressionLevel Optimal -Force"';
                            const e1 = await runCmd(cmd, 900000);
                            if (e1) {
                                // Compress-Archive 对超 2GB / 超长路径会失败，回退到系统自带 tar
                                zipError = String(e1).slice(0, 80);
                                const e2 = await runCmd('tar -a -c -f ' + Q_(zipPath) + ' -C ' + Q_(folder) + ' .', 900000);
                                zipError = e2 ? String(e2).slice(0, 120) : '';
                            }
                        } catch (e) { zipError = String(e.message || e).slice(0, 120); }
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
                // browser：直接用默认浏览器打开（订阅清单页面），绕开浏览器对同名本地文件的缓存
                if (b.browser && b.select && fs.existsSync(String(b.select))) {
                    const sel0 = String(b.select);
                    const furl = 'file:///' + sel0.split('\\').join('/').replace(/^\/+/, '');
                    const Q0 = String.fromCharCode(34);
                    try { exec('cmd /c start ' + Q0 + Q0 + ' ' + Q0 + furl + Q0, () => { }); } catch (e) { }
                    send(res, 200, JSON.stringify({ ok: true, opened: sel0 }));
                    return;
                }
                const folder = resolveShareFolder(b.folder);
                fs.mkdirSync(folder, { recursive: true });
                // Windows：调用独立脚本打开文件夹并强制置前（后台进程直接开 explorer 会被挡在后面）
                const Q = String.fromCharCode(34);
                const minimizeAll = (typeof b.minimize === 'boolean') ? b.minimize : (loadShare().minimize === true);
                // select：导出完要直接选中那个 zip，省得再找
                const sel = (b.select && fs.existsSync(String(b.select))) ? String(b.select) : '';
                // 用参数数组启动（不用拼字符串），路径里的引号不会被当成命令的一部分
                try {
                    if (process.platform === 'win32') {
                        const ps1 = path.join(__dirname, 'openFolder.ps1');
                        if (fs.existsSync(ps1)) {
                            const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Folder', folder];
                            if (minimizeAll) args.push('-Minimize', '1');
                            if (sel) args.push('-Select', sel);
                            spawn('powershell', args, { detached: true, stdio: 'ignore' }).unref();
                        } else {
                            spawn('explorer', [sel ? ('/select,' + sel) : folder], { detached: true, stdio: 'ignore' }).unref();
                        }
                    } else {
                        spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' }).unref();
                    }
                } catch (e) { /* 打开文件夹失败不影响导出结果 */ }
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
            const stampT = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
            const tmpD = path.join(W, id + '.tmp_' + stampT);
            const oldD = path.join(W, id + '.old_' + stampT);
            rmDirSync(tmpD);
            try { copyDir(src, tmpD); }
            catch (e) { rmDirSync(tmpD); throw new Error('复制失败（原来的 mod 没动）：' + e.message); }
            let renamed = false;
            if (fs.existsSync(dest)) {
                try { fs.renameSync(dest, oldD); renamed = true; }
                catch (e) { /* 被占用时退化为直接覆盖 */ }
            }
            try { fs.renameSync(tmpD, dest); }
            catch (e) {
                if (renamed) { try { fs.renameSync(oldD, dest); } catch (e2) { } }
                rmDirSync(tmpD);
                throw new Error('替换失败（已还原原来的 mod）：' + e.message);
            }
            if (renamed) rmDirSync(oldD);
            imported++;
        }
        return { imported: imported, skipped: skipped, active: ids, items: items };
    }

    // 对方发来的 zip：解压后直接导入（不用先手动解压、再跑到路径设置里填路径）
    if (url === '/api/share/import-zip' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', async () => {
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
                const e1 = await runCmd('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path ' +
                    Q_(zp) + ' -DestinationPath ' + Q_(ex) + ' -Force"', 900000);
                if (e1) {
                    const e2 = await runCmd('tar -x -f ' + Q_(zp) + ' -C ' + Q_(ex), 900000);
                    if (e2) throw new Error('解压失败：' + String(e2).slice(0, 160));
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
    // 生成订阅清单页面：一条链接对应一个 mod，另有一个「一键订阅全部」按钮
    // 网页端订阅脚本：完全不用 steam:// 协议，纯 AJAX。注意接口是 /sharedfiles/subscribe（不带尾斜杠，带斜杠会 401）；
    // 优先用页面自带的 jQuery（与 Steam 官方订阅按钮同款通道），没有 jQuery 才用 fetch。
    function webSubScript(ids) {
        return [
            "(function(){",
            "  var IDS = [" + ids.join(",") + "];",
            "  if (!window.g_sessionID) { console.log(\"%c请在 steamcommunity.com 页面登录 Steam 后再运行\", \"color:#f66;font-size:14px\"); return; }",
            "  var ok = 0, fail = [], i = 0;",
            "  function next(){",
            "    if (i >= IDS.length) { console.log(\"%c完成：订阅成功 \" + ok + \" 个，失败 \" + fail.length + \" 个\", \"color:#0f0;font-size:16px\"); if (fail.length) console.log(\"失败 ID：\" + fail.join(\",\")); return; }",
            "    var id = IDS[i++];",
            "    var done = function (j) { if (j && (j.success == 1 || j.success == \"1\")) ok++; else fail.push(id); };",
            "    var step = function () { console.log((ok + fail.length) + \"/\" + IDS.length + \" ...\"); setTimeout(next, 600); };",
            "    if (window.jQuery) {",
            "      jQuery.ajax({ url: \"/sharedfiles/subscribe\", method: \"POST\", headers: { \"X-Requested-With\": \"XMLHttpRequest\" }, data: { id: id, sessionid: window.g_sessionID, appid: 602960 } })",
            "        .done(function (j) { done(j); })",
            "        .fail(function () { fail.push(id); })",
            "        .always(step);",
            "    } else {",
            "      fetch(\"/sharedfiles/subscribe\", { method: \"POST\", credentials: \"include\", body: new URLSearchParams({ id: id, sessionid: window.g_sessionID }) })",
            "        .then(function (r) { return r.json(); })",
            "        .then(function (j) { done(j); }, function () { fail.push(id); })",
            "        .then(step);",
            "    }",
            "  }",
            "  next();",
            "})();"
        ].join("\n");
    }

    function subHtmlFor(list, genAt) {
        const items = list.map(m => '<li><a class="sub" href="steam://subscribe/' + m.id + '">Steam 订阅</a> <b>' +
            __escShare(m.zh || m.name || m.id) + '</b> <code>' + m.id + '</code> <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.id + '">网页打开</a></li>').join('');
        const ids = list.map(m => m.id);
        const one = 'steam://subscribe/' + ids.join(',');
        return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><meta http-equiv="Pragma" content="no-cache"><meta http-equiv="Expires" content="0"><title>一键订阅 mod</title><style>' +
            'body{font-family:"Microsoft YaHei",sans-serif;background:#111827;color:#e5e7eb;padding:24px;line-height:1.7}' +
            'a{color:#818cf8}a.sub{background:#6366f1;color:#fff;padding:3px 10px;border-radius:6px;text-decoration:none;margin-right:8px}' +
            'li{margin:6px 0}code{color:#9ca3af}button{background:#6366f1;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer}' +
            'input{background:#0f1626;color:#e6e9ef;border:1px solid #2a3346;border-radius:6px;padding:6px 9px;width:min(760px,90%)}' +
            '</style></head><body><h2>共 ' + list.length + ' 个创意工坊 mod</h2>' + (genAt ? '<div style="color:#9ca3af;font-size:12px;margin:2px 0 10px">生成时间：' + genAt + '</div>' : '') +
            '<div class="pbtns"><button id="all">一键订阅全部</button>' +
            '<a class="sub" href="' + one + '">Steam 合并链接（部分版本只认第一个）</a></div>' +
            '<p><input id="one" readonly value="' + one + '"></p>' +
            '<details style="margin:12px 0;border:1px solid #2a3346;border-radius:8px;padding:8px 12px"><summary style="cursor:pointer;color:#818cf8">电脑不支持 steam:// 时点这里：用脚本在网页上一键订阅全部（推荐）</summary>' +
            '<p style="font-size:13px">打开任意 steamcommunity.com 页面并登录 Steam → F12 → Console → 粘贴下面的脚本并回车 → 自动把全部 ' + list.length + ' 个 mod 订阅上，全程不依赖 steam:// 协议。</p>' +
            '<textarea id="ws" readonly rows="9" style="width:100%;max-width:900px;background:#0f1626;color:#cbd5e1;border:1px solid #2a3346;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:12px">' + __escShare(webSubScript(ids)) + '</textarea>' +
            '<p><button id="cpws" style="background:#4f46e5">复制脚本</button> <span id="cpwsmsg" style="color:#9ca3af;font-size:12px"></span></p></details>' +
            '<ol>' + items + '</ol>' +
            '<p>点「Steam 订阅」会拉起 Steam 客户端并弹出订阅确认；也可以点「网页打开」在社区页手动点「+ 订阅」。</p>' +
            '<p style="color:#9ca3af;font-size:12px">第一次点「Steam 订阅」时，浏览器会弹「此站点正在尝试打开 Steam」——点「打开」即可，并可勾选「始终允许」，之后就不会再问；点了没反应的话，确认 Steam 已启动并已登录。</p>' +
            '<p style="color:#9ca3af;font-size:12px">若打开后提示「该物品不存在」：先确认浏览器里已登录 Steam；短时间内点太多条也会被 Steam 限流，隔一会儿再点即可。</p>' +
            '<div id="filewarn" style="display:none;background:#78350f;color:#fde68a;border:1px solid #b45309;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:13px">你正在用「本地文件」方式打开本页（地址栏是 file:///D:/... 开头）。这种页面里的 steam:// 链接会被浏览器<b>静默拦截</b>——点「Steam 订阅」「一键订阅全部」都会毫无反应。请回到工具面板重新点「订阅链接」（会用 http 方式打开），或直接用上面的「网页一键订阅脚本」。</div>' +
            '<script>var ids=' + JSON.stringify(ids) + ';' +
            'if (location.protocol === "file:") { var fw = document.getElementById("filewarn"); if (fw) fw.style.display = "block"; }' +
            'document.getElementById("all").onclick=function(){ids.forEach(function(id,i){setTimeout(function(){location.href="steam://subscribe/"+id;},i*1200);});};' +
            'var o=document.getElementById("one");o.onclick=function(){o.select();};' +
            '</script></body></html>';
    }

    // 向 Steam 查询这些创意工坊物品是否还存在（作者删除 / 转私密会查不到）
    // 成功返回 { map: Map(id->bool) }；网络失败返回 null（此时不做过滤）
    function checkWsAlive(ids, cb) {
        const body = 'itemcount=' + ids.length + ids.map((id, i) => '&publishedfileids%5B' + i + '%5D=' + encodeURIComponent(id)).join('');
        const req = https.request({
            host: 'api.steampowered.com',
            path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/?format=json',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
                        timeout: 8000,
            // 只读的公开接口；本机常挂着会替换证书的代理，严格校验会连不上
            rejectUnauthorized: false,
        }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    const arr = (j && j.response && j.response.publishedfiledetails) || [];
                    const map = new Map();
                    for (const it of arr) map.set(String(it.publishedfileid), it.result === 1);
                    cb(map);
                } catch (e) { cb(null); }
            });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) { } cb(null); });
        req.on('error', () => cb(null));
        req.write(body);
        req.end();
    }

    // 逐个打开社区页面，确认链接真的打得开（私密 / 地区限制 / 被移除 / 被限流都会在网页上表现为报错）
    // 注意：每个工坊页都内嵌一段「This item has been removed...」的隐藏模板，不能拿它当失效依据
    function checkWsWebAlive(ids, cb) {
        const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'zh-CN,zh' };
        const one = (id, retry) => new Promise(resolve => {
            const rq = https.request('https://steamcommunity.com/sharedfiles/filedetails/?id=' + id, {
                method: 'GET', timeout: 15000, rejectUnauthorized: false, headers: UA
            }, r => {
                let b = ''; let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    const t = (b.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
                    // bannedNotification 是每页都带的隐藏模板，只有真的被移除时才是 display:block
                    const bn = b.indexOf('bannedNotification');
                    const banned = bn >= 0 && /display:\s*block/.test(b.slice(bn, bn + 300));
                    const err = /::\s*Error\s*$/.test(t) || t.indexOf('错误') >= 0 ||
                        b.indexOf('抱歉！处理您的请求时遇到错误') >= 0 || b.indexOf('该物品不存在') >= 0 ||
                        b.indexOf('The item does not exist') >= 0 || b.indexOf('No item could be found') >= 0 ||
                        b.indexOf('It is only visible to you') >= 0 || banned;
                    resolve({ id: id, status: r.statusCode, title: t.slice(0, 80), err: err, limited: r.statusCode === 429 });
                };
                r.setEncoding('utf8');
                r.on('data', c => { b += c; if (b.length > 60000) { try { r.destroy(); } catch (e) { } finish(); } });
                r.on('end', finish);
                r.on('close', finish);
            });
            rq.on('timeout', () => { try { rq.destroy(); } catch (e) { } resolve({ id: id, status: 'TIMEOUT', limited: true }); });
            rq.on('error', e => resolve({ id: id, status: 'ERR' + (e.code || e.message), limited: true }));
            rq.end();
        }).then(r => {
            const needRetry = r.limited || r.status === 'TIMEOUT' || String(r.status).indexOf('ERR') === 0;
            if (needRetry && retry > 0) return new Promise(s => setTimeout(s, 2500)).then(() => one(id, retry - 1));
            return r;
        });
        const out = [];
        let i = 0;
        const step = () => {
            if (i >= ids.length) return Promise.resolve();
            const batch = ids.slice(i, i + 2); i += 2;
            return Promise.all(batch.map(id => one(id, 2)))
                .then(rs => { rs.forEach(r => out.push(r)); return new Promise(s => setTimeout(s, 800)).then(step); });
        };
        step().then(() => cb(out));
    }

    if (url === '/api/steam/websub-script' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const ids = (b.list || []).map(m => String((m && m.id) == null ? '' : m.id).trim()).filter(x => __isWs(x));
                if (!ids.length) throw new Error('没有可订阅的工坊 mod');
                send(res, 200, JSON.stringify({ ok: true, count: ids.length, script: webSubScript(ids) }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    if (url === '/api/steam/verify-links' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', () => {
            try {
                const b = JSON.parse(raw || '{}');
                const src = (b.list || []).map(m => ({
                    id: String((m && m.id) == null ? '' : m.id).trim(),
                    name: (m && (m.zh || m.name)) || '',
                }));
                const ids = src.filter(m => __isWs(m.id)).map(m => m.id);
                if (!ids.length) throw new Error('没有可校验的工坊 mod');
                checkWsWebAlive(ids, arr => {
                    const bad = [];
                    const unknown = [];
                    arr.forEach(r => {
                        const m = src.find(x => x.id === r.id) || {};
                        const limited = r.status === 429 || r.status === 'TIMEOUT' || String(r.status).indexOf('ERR') === 0;
                        if (limited) { unknown.push({ id: r.id, name: m.name || '', status: r.status }); return; }
                        if (!(r.status === 200 && !r.err)) bad.push({ id: r.id, name: m.name || '', status: r.status, title: r.title || '' });
                    });
                    send(res, 200, JSON.stringify({ ok: true, total: ids.length, checked: arr.length, bad: bad, unknown: unknown }));
                });
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // 生成可发给别人的订阅链接（steam:// 协议 / 社区网页 / 订阅清单页面）
    // 订阅清单用 http 方式打开：file:// 页面里的 steam:// 链接会被浏览器静默拦截（点了毫无反应）
    if (url === '/subscribe') {
        if (!LAST_SUB_HTML) {
            send(res, 404, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#111827;color:#e5e7eb;padding:24px"><p>还没有生成订阅清单。请回到工具面板点一次「订阅链接」。</p>', 'text/html; charset=utf-8');
            return;
        }
        send(res, 200, LAST_SUB_HTML, 'text/html; charset=utf-8');
        return;
    }

    if (url === '/api/steam/link' && req.method === 'POST') {
        let raw = '';
        req.on('data', d => { raw += d; });
        req.on('end', async () => {
            try {
                const b = JSON.parse(raw || '{}');
                const all = (b.list || []).map(m => ({
                    id: String((m && m.id) == null ? '' : m.id).trim(),
                    name: (m && (m.name || '')) || '',
                    zh: (m && (m.zh || '')) || '',
                }));
                const ws = all.filter(m => __isWs(m.id));
                if (!ws.length) throw new Error('当前这套里没有可订阅的创意工坊 mod（本地 mod 只能发文件）');
                // 先校验哪些 mod 在创意工坊还能打开，失效的从链接里剔除（本机还能用，只是订阅不了）
                const alive = await new Promise(resolve => checkWsAlive(ws.map(m => m.id), resolve));
                let dead = [];
                let live = ws;
                if (alive) {
                    dead = ws.filter(m => alive.get(m.id) === false).map(m => ({ id: m.id, name: m.zh || m.name || m.id }));
                    live = ws.filter(m => alive.get(m.id) !== false);
                    if (!live.length) throw new Error('这套里的工坊 mod 全部已从创意工坊失效（被作者删除/转私密），订阅链接生成不了');
                }
                const steam = live.map(m => 'steam://subscribe/' + m.id);
                const web = live.map(m => 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.id);
                const text = live.map(m => (m.zh || m.name || m.id) + '  ' + 'steam://subscribe/' + m.id).join('\n');
                // 顺手把订阅清单页面写到导出文件夹，方便连文件一起发
                let html = '';
                let htmlOpen = '';
                const ts = Date.now();
                const genAt = new Date(ts).toLocaleString('zh-CN', { hour12: false });
                try {
                    const folder = resolveShareFolder(b.folder);
                    fs.mkdirSync(folder, { recursive: true });
                    LAST_SUB_HTML = subHtmlFor(live, genAt);
                    html = path.join(folder, 'subscribe.html');
                    fs.writeFileSync(html, LAST_SUB_HTML, 'utf8');
                    // 同名文件会被浏览器缓存，导致点开的还是旧的一版；另存一份带时间戳的副本专门用于打开
                    htmlOpen = path.join(folder, 'subscribe-' + ts + '.html');
                    fs.writeFileSync(htmlOpen, LAST_SUB_HTML, 'utf8');
                    try {
                        const olds = fs.readdirSync(folder).filter(f => /^subscribe-\d+\.html$/i.test(f)).sort();
                        for (let i = 0; i < olds.length - 2; i++) fs.unlinkSync(path.join(folder, olds[i]));
                    } catch (e) { }
                } catch (e) { html = ''; htmlOpen = ''; }
                send(res, 200, JSON.stringify({
                    ok: true, count: live.length, local: all.length - ws.length, dead: dead, unchecked: alive ? 0 : 1,
                    ts: ts, genAt: genAt, htmlOpen: htmlOpen, liveIds: live.map(m => m.id),
                    steam: steam.join('\n'), steamAll: 'steam://subscribe/' + live.map(m => m.id).join(','),
                    web: web.join('\n'), text: text, html: html,
                }));
            } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // steam:// 协议关联有可能失效（点了没反应）；直接用 Steam.exe 打开 URL 更可靠
    let STEAM_EXE_CACHE = '';
    function steamExePath() {
        if (STEAM_EXE_CACHE) return STEAM_EXE_CACHE;
        const keys = ['HKCU\\Software\\Classes\\steam\\shell\\open\\command', 'HKLM\\Software\\Classes\\steam\\shell\\open\\command'];
        for (const k of keys) {
            try {
                const out = execSync('reg query "' + k + '" /ve', { windowsHide: true, timeout: 4000 }).toString();
                const m = out.match(/"([^"]+[\\/]steam\.exe)"/i);
                if (m && fs.existsSync(m[1])) { STEAM_EXE_CACHE = m[1]; return STEAM_EXE_CACHE; }
            } catch (e) { /* 继续试下一个 key */ }
        }
        STEAM_EXE_CACHE = '';
        return '';
    }
    function openSteamUrl(u) {
        const exe = steamExePath();
        try {
            exec(exe ? ('cmd /c start "" "' + exe + '" "' + u + '"') : ('cmd /c start "" "' + u + '"'), () => { });
        } catch (e) { /* 忽略 */ }
        return !!exe;
    }

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
                const viaExe = openSteamUrl('steam://subscribe/' + ids[0]);
                // 分批慢发：连着几十条打给 Steam 会被限流，之后社区页会变成各种报错页（包括「该物品不存在」）
                const SIZE = 8, GAP = 800, CHUNK_GAP = 6000;
                ids.forEach((id, i) => {
                    const u = useWeb ? ('https://steamcommunity.com/sharedfiles/filedetails/?id=' + id) : ('steam://subscribe/' + id);
                    const wait = (i % SIZE) * GAP + Math.floor(i / SIZE) * CHUNK_GAP;
                    setTimeout(() => {
                        if (useWeb) { try { exec('cmd /c start "" "' + u + '"'); } catch (e) { /* 忽略 */ } return; }
                        openSteamUrl(u);
                    }, wait);
                });
                const chunks = Math.ceil(ids.length / SIZE);
                send(res, 200, JSON.stringify({
                    ok: true, count: ids.length, mode: useWeb ? 'web' : 'steam', chunks: chunks, viaExe: viaExe, exe: steamExePath(),
                    seconds: Math.round((((ids.length % SIZE) || SIZE) - 1) * GAP / 1000 + (chunks - 1) * CHUNK_GAP / 1000),
                }));
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
                writeFileAtomic(file, JSON.stringify(data, null, 2), 'utf8');
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
            try { spawn('explorer', [PRESET_DIR], { detached: true, stdio: 'ignore' }).unref(); }
    catch (e) { exec('cmd /c explorer "' + PRESET_DIR + '"'); }
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
    try { fs.writeFileSync(path.join(__dirname, 'server.port'), String(port), 'utf8'); }
    catch (e) { console.error('写 server.port 失败：' + e.message); }
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
