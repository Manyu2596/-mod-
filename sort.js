/**
 * 潜渊症 (Barotrauma) Mod 排序助手 v2
 * 分类依据：读取每个 mod 的 filelist.xml，看它实际改了什么
 * （Character / Item / Submarine / Text / 脚本 等），而不是靠名字猜
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------- 自动探测本机路径（换台电脑也能直接用，无需改代码）----------
// 注册表里拿到的路径经常是 d:/steam 这种（小写盘符 + 正斜杠）。
// 不统一的话：界面上一会儿小写一会儿大写，手动填的 D:\\Steam 和自动探测的 d:/steam
// 明明是同一个目录却比对不上。这里一律归一成 D:\\Steam 形式。
function normDir(p) {
    if (!p) return '';
    let s = String(p).trim().replace(/\//g, '\\');
    s = s.replace(/^([a-zA-Z]):\\*/, function (m, d) { return d.toUpperCase() + ':\\'; });
    s = s.replace(/\\{2,}/g, '\\').replace(/\\+$/, '');
    // 目录真实存在的话顺带取磁盘上的真实大小写：注册表只给盘符不给大小写（d:/steam），
    // 显示出来像是另一个地方
    try {
        if (s.length > 3 && fs.existsSync(s)) {
            const real = fs.realpathSync.native(s);
            if (real && real.length) s = real;
        }
    } catch (e) { /* 取不到就用原值 */ }
    return s;
}

function readSteamPath() {
    const outs = [];
    const tries = [
        ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
        ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
        ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
    ];
    for (const [key, val] of tries) {
        try {
            const out = execSync(`reg query "${key}" /v ${val}`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).toString();
            const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(out);
            if (m) outs.push(normDir(m[1].trim()));
        } catch (e) { /* 该注册表项不存在，继续试下一个 */ }
    }
    return outs;
}

function listSteamLibraries(steamPath) {
    const libs = [];
    if (steamPath) libs.push(steamPath);
    try {
        const vdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
        if (fs.existsSync(vdf)) {
            const txt = fs.readFileSync(vdf, 'utf8');
            const re = /"path"\s+"([^"]+)"/g;
            let m;
            while ((m = re.exec(txt)) !== null) libs.push(normDir(m[1]));
        }
    } catch (e) { /* 忽略解析失败 */ }
    return libs;
}

// 判定某个目录确实是潜渊症：以前只认 config_player.xml，但那个文件要等第一次
// 进过游戏才生成 —— 「刚装好、还没开过游戏」的用户会被检测不到，掉回 D:\\Steam 兜底路径，
// 明明 Steam 装在别的盘也照样读不到 mod。这里放宽到「目录在 + 有游戏本体文件」。
function looksLikeGame(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    const marks = ['Barotrauma.exe', 'filelist.xml', 'config_player.xml', 'Submarines', 'LocalMods'];
    for (const m of marks) { if (fs.existsSync(path.join(dir, m))) return true; }
    return false;
}

function detectGame() {
    for (const sp of readSteamPath()) {
        for (const lib of listSteamLibraries(sp)) {
            const game = normDir(path.join(lib, 'steamapps', 'common', 'Barotrauma'));
            if (looksLikeGame(game)) {
                return {
                    game,
                    workshop: normDir(path.join(lib, 'steamapps', 'workshop', 'content', '602960')),
                };
            }
        }
    }
    // 上面的多库都没命中；再兜一次：游戏装在主库的常见位置，但工作坊内容在别的库的情况
    return null;
}

const DEFAULT_GAME = 'D:\\Steam\\steamapps\\common\\Barotrauma';
const DEFAULT_WORKSHOP = 'D:\\Steam\\steamapps\\workshop\\content\\602960';
// 用户手动指定的路径保存在这里（优先级最高，重新检测也不会被覆盖）
const PATHS_FILE = path.join(__dirname, 'paths.json');

function defaultInstalled() {
    return path.join(process.env.LOCALAPPDATA || '', 'Daedalic Entertainment GmbH', 'Barotrauma', 'WorkshopMods', 'Installed');
}

// 非 Steam 版 / 手动放的 mod：游戏目录下的 LocalMods
function defaultLocalMods(gameDir) { return path.join(gameDir || '', 'LocalMods'); }

function loadUserPaths() {
    try {
        const j = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8')) || {};
        return { game: j.game || '', workshop: j.workshop || '', installed: j.installed || '', localmods: j.localmods || '' };
    } catch (e) {
        return { game: '', workshop: '', installed: '', localmods: '' };
    }
}

function saveUserPaths(o) {
    const cur = loadUserPaths();
    const mk = (v, curV) => v === undefined ? curV : (String(v).trim() ? normDir(v) : '');
    const next = {
        game: mk(o.game, cur.game),
        workshop: mk(o.workshop, cur.workshop),
        installed: mk(o.installed, cur.installed),
        localmods: mk(o.localmods, cur.localmods),
    };
    fs.writeFileSync(PATHS_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

// 优先级：手动设置 > 环境变量 > 自动探测 > 原硬编码兜底
function computePaths() {
    const U = loadUserPaths();
    const D = detectGame();
    const game = U.game || process.env.BARO_GAME || (D && D.game) || DEFAULT_GAME;
    return {
        game,
        workshop: U.workshop || process.env.BARO_WORKSHOP || (D && D.workshop) || DEFAULT_WORKSHOP,
        installed: U.installed || process.env.BARO_INSTALLED || defaultInstalled(),
        localmods: U.localmods || process.env.BARO_LOCALMODS || defaultLocalMods(game),
    };
}

let GAME, WORKSHOP, INSTALLED, LOCALMODS;
function applyPaths(p) { GAME = normDir(p.game); WORKSHOP = normDir(p.workshop); INSTALLED = normDir(p.installed); LOCALMODS = normDir(p.localmods || ''); }
applyPaths(computePaths());

// 运行时可重新探测（比如刚装好游戏 / 改了 Steam 库位置）
function refreshPaths() { applyPaths(computePaths()); return getPaths(); }
function getPaths() { return { GAME, WORKSHOP, INSTALLED, LOCALMODS }; }

const GAME_VERSION = '1.13.4.0';
const OUT = path.join(__dirname, 'report.html');

// 中文翻译表（离线手写），以及可选从 Steam 官方接口拉取的元数据
const ZH = loadJson(path.join(__dirname, 'zh.json'), {});
const META = loadJson(path.join(__dirname, 'workshop_meta.json'), {});

function loadJson(p, def) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}
function hasCJK(s) { return /[一-鿿]/.test(s || ''); }
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---------- 从游戏配置读出"已启用"的 mod ----------
function loadEnabledIds() {
    const set = new Set();
    const f = path.join(GAME, 'config_player.xml');
    if (!fs.existsSync(f)) return set;
    const txt = fs.readFileSync(f, 'utf8');
    let m;
    const reNum = /Installed[/\\](\d+)[/\\]/gi;
    while ((m = reNum.exec(txt)) !== null) set.add(m[1]);
    // 本地 mod：取 filelist.xml 的上一级目录名（LocalMods/<名字>/filelist.xml）
    const reAny = /path="([^"]*?)[/\\]([^/\\]+)[/\\]filelist\.xml"/gi;
    while ((m = reAny.exec(txt)) !== null) set.add(m[2]);
    return set;
}

// ---------- 解析单个 mod ----------
function analyze(id, base) {
    const dir = path.join(base || WORKSHOP, id);
    const fl = path.join(dir, 'filelist.xml');
    if (!fs.existsSync(fl)) return null;

    const txt = fs.readFileSync(fl, 'utf8');
    const name = (/<contentpackage\s+[^>]*?name="([^"]*)"/i.exec(txt) || [, '(?)'])[1];
    const modversion = (/modversion="([^"]*)"/i.exec(txt) || [, '-'])[1];
    const gameversion = (/gameversion="([^"]*)"/i.exec(txt) || [, '-'])[1];

    // 统计它改了哪些类型的东西
    const tags = {};
    const re = /<([A-Za-z]+)\s+file=/g;
    let m;
    while ((m = re.exec(txt)) !== null) tags[m[1]] = (tags[m[1]] || 0) + 1;

    const hasLua = fs.existsSync(path.join(dir, 'Lua')) || /Lua[/\\]/i.test(txt);
    const hasCs = fs.existsSync(path.join(dir, 'CSharp')) || /CSharp[/\\]/i.test(txt);

    const deps = [];
    const dm = txt.match(/<Dependencies>([\s\S]*?)<\/Dependencies>/i);
    if (dm) {
        const dre = /<Dependency\s+([^>]*?)\/?>/g;
        let r;
        while ((r = dre.exec(dm[1])) !== null) {
            const nm = /name="([^"]*)"/.exec(r[1]);
            if (nm) deps.push(nm[1]);
        }
    }

    const topTags = Object.entries(tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(e => `${e[0]}:${e[1]}`)
        .join('  ');

    return {
        id, name, modversion, gameversion, tags, hasLua, hasCs, deps, topTags,
        installed: /^\d{1,20}$/.test(String(id)) ? fs.existsSync(path.join(INSTALLED, id)) : true,
    };
}

// ---------- 按实际内容分类 ----------
function classify(mod) {
    const n = mod.name.toLowerCase();
    const t = mod.tags;
    const item = t.Item || 0;
    const ch = t.Character || 0;
    const sub = t.Submarine || 0;
    const text = t.Text || 0;
    const hasContent = item + ch + sub > 0;
    const gameplay = (t.RandomEvents || 0) + (t.Missions || 0) + (t.NPCSets || 0) +
                     (t.Talents || 0) + (t.Jobs || 0) + (t.Afflictions || 0);

    // 角色类关键词
    const roleKw = /角色|character|waifu|anime|archive|arona|阿罗娜|普拉娜|外骨格|exomaiden|萌化/i.test(mod.name);

    // ① 原版核心
    if (String(mod.core).toLowerCase() === 'true') return { tier: 1, cat: '① 原版核心' };

    // ② 前置框架 / 依赖库（必须最先加载）
    if (/luacsforbarotrauma/.test(n)) return { tier: 2.0, cat: '② 前置框架' };
    if (/luacsclientside/.test(n)) return { tier: 2.1, cat: '② 前置框架' };
    if (/^csforbarotrauma/.test(n)) return { tier: 99, cat: '✗ 旧框架·禁用' };

    // ✗ 作者已声明废弃/被取代
    if (/已被.{0,10}取代|废弃|已弃用|deprecated|不再维护/i.test(mod.name)) {
        return { tier: 99, cat: '✗ 作者已声明废弃' };
    }

    // ⑧ 汉化（必须最先于"补丁"判断，否则被关键词截走）
    if (/汉化|简体|中文|chinese|cn_zh|zh_cn|_zh\b/i.test(mod.name)) return { tier: 8, cat: '⑧ 汉化覆盖' };

    // ⑦ 附加包 / 兼容补丁（排在本体之后）
    //    注意：名字里带「兼容/补丁」但内容量很大的是大型内容 mod，归 ⑦ 会被排在真正的本体前面，这里放行走 ⑥
    const bigContent = item >= 60 || ch >= 30 || (sub > 0 && item <= 10);
    if (/补丁|expansion kit|附加|兼容/i.test(mod.name) && !bigContent) return { tier: 7, cat: '⑦ 附加包/补丁' };

    // ③ 性能优化：分两种
    //   · 纯脚本/机制类（不新增内容）→ ③ 靠前加载
    //   · 带原版内容覆写的（如「原版物品优化」）→ ④，与原版微调同层，避免盖掉大型内容 mod 的新增项
    if (/performance|修复|优化|fix|bugfix|fps|lag|卡顿|帧数|性能/.test(n)) {
        if (hasContent || text > 0) return { tier: 4.5, cat: '④ 原版优化' };
        return { tier: 3, cat: '③ 性能优化' };
    }

    // ⑤ 功能 / QoL / 界面（只新增，冲突少）
    if (/display|显示|customizer|qol|health|kill|血量|提示|immersion|bot ai|reload/.test(n)) {
        return { tier: 5, cat: '⑤ 功能/QoL' };
    }

    // ⑥ 大型内容 / 玩法 / 角色 / 船只
    const isShip = sub > 0 && item <= 10;   // 潜艇是主体才算船，否则只是附带
    if (ch >= 30 || item >= 60 || isShip || roleKw || (gameplay > 0 && item <= 15)) {
        if (isShip) return { tier: 6, cat: '⑥ 船只潜艇' };
        if (roleKw) return { tier: 6, cat: '⑥ 角色内容' };
        return { tier: 6, cat: '⑥ 大型内容' };
    }
    if (sub > 0) return { tier: 6, cat: '⑥ 大型内容' };

    // ④ 原版机制 / 物品微调（覆写原版，排在大型内容之前）
    if (item > 0) return { tier: 4, cat: '④ 原版微调' };

    if (text > 0) return { tier: 8, cat: '⑧ 文本覆盖' };
    return { tier: 5, cat: '⑤ 功能' };
}

// ---------- 冲突检测 ----------
const SERIES = [
    { key: '外骨格乙女|exomaiden', label: '外骨格乙女系列' },
    { key: 'blue archive|arona|阿罗娜|普拉娜|什亭之匣', label: 'Blue Archive 系列' },
    { key: 'last dance|最后一舞', label: 'Last Dance 系列' },
    { key: '东方潜渊', label: '东方系列' },
    { key: 'smarter bot ai', label: 'Smarter Bot AI' },
];

// 去掉"补丁/汉化"这类后缀后的本体名
function stripAddon(name) {
    return name.replace(/Lua补丁|自用汉化|汉化补丁|汉化|补丁|Lua\s*Patch|Patch/gi, '').trim();
}

function detectSeries(mods) {
    return SERIES.map(s => {
        const hit = mods.filter(x => new RegExp(s.key, 'i').test(x.name));
        if (hit.length < 2) return null;

        // 配套关系（本体 + 补丁/汉化/扩展）不是冲突，必须一起用
        // 去后缀后同名 → 配套
        const bases = hit.map(h => stripAddon(h.name));
        const sameBase = bases.every(b => b === bases[0]);

        // 组内存在一个"本体"，其他成员名字都以它开头 → 本体 + 补丁/扩展，配套
        // 同名（不同版本）不算配套，否则真正的重复冲突会被吞掉
        const base = hit.find(h => hit.every(o => o === h || (o.name !== h.name && o.name.startsWith(h.name))));

        return {
            label: s.label,
            names: hit.map(h => `${h.zhName} (${h.modversion})`),
            addon: sameBase || !!base,
        };
    }).filter(Boolean);
}

// ---------- 主流程 ----------
function main() {
    if (!fs.existsSync(WORKSHOP)) {
        console.log('找不到目录: ' + WORKSHOP);
        return;
    }

    const enabledIds = loadEnabledIds();

    const mods = [];
    let dirIds = [];
    try { dirIds = fs.readdirSync(WORKSHOP); }
    catch (e) { console.log('读不了目录 ' + WORKSHOP + '：' + e.message); return; }
    dirIds.forEach(id => {
        try { if (!fs.statSync(path.join(WORKSHOP, id)).isDirectory()) return; }
        catch (e) { return; }   // 坏链接 / 无权限的目录跳过
        const a = analyze(id);
        if (!a) return;
        const c = classify(a);
        // 补丁类排在同类的最前面（优先级更高才能覆盖）
        const patchBonus = /补丁|patch/i.test(a.name) ? -0.5 : 0;
        const zh = ZH[a.id] || {};
        const meta = META[a.id] || {};
        const zhName = zh.zh || (hasCJK(meta.title) ? meta.title : null) || a.name;
        const zhDesc = zh.desc || (meta.description ? stripTags(meta.description).slice(0, 200) : '');
        const workshop = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + a.id;
        mods.push(Object.assign(a, {
            tier: c.tier + patchBonus,
            cat: c.cat,
            old: a.gameversion !== GAME_VERSION,
            enabled: enabledIds.has(a.id),
            zhName, zhDesc, workshop,
        }));
    });

    // 已启用的在前（真正参与加载），未启用的列在最后仅作提醒
    mods.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.tier - b.tier || a.name.localeCompare(b.name, 'zh');
    });

    // 补丁/覆盖类：后加载才能盖住主 mod → 紧跟主 mod 下方
    mods.filter(m => /补丁/.test(m.name)).forEach(p => {
        const base = p.name.replace(/Lua补丁|补丁/g, '').trim();
        if (!base) return;
        const main = mods.find(m => m !== p && !/补丁/.test(m.name) && m.name.includes(base));
        if (!main) return;
        mods.splice(mods.indexOf(p), 1);
        mods.splice(mods.indexOf(main) + 1, 0, p);   // 始终紧邻主 mod 下方
    });

    // 冲突只在"已启用"的 mod 之间才会真正发生
    const active = mods.filter(m => m.enabled);
    const idle = mods.filter(m => !m.enabled);
    const groups = detectSeries(active);
    const conflicts = groups.filter(g => !g.addon);
    const addons = groups.filter(g => g.addon);
    const oldCount = mods.filter(m => m.old).length;
    const installedCount = mods.filter(m => m.enabled).length;

    const rowHtml = (m, i) => {
        const flags = [];
        if (m.old) flags.push(`<span class="tag warn">适用 ${m.gameversion}</span>`);
        if (/csforbarotrauma/i.test(m.name) && !/luacs/i.test(m.name)) {
            flags.push('<span class="tag danger">旧框架·建议禁用</span>');
        }
        if (/已被.{0,10}取代|废弃|已弃用|deprecated/i.test(m.name)) {
            flags.push('<span class="tag danger">作者已声明废弃</span>');
        }
        if (m.hasLua) flags.push('<span class="tag info">Lua</span>');
        if (m.hasCs) flags.push('<span class="tag info">C#</span>');
        if (m.deps.length) flags.push(`<span class="tag info">依赖 ${m.deps.join(',')}</span>`);
        flags.push(m.enabled
            ? '<span class="tag ok">已启用</span>'
            : '<span class="tag off">未启用</span>');
        const orig = (m.zhName && m.zhName !== m.name) ? `<div class="orig">原名：${esc(m.name)}</div>` : '';
        const desc = m.zhDesc ? `<div class="desc">${esc(m.zhDesc)}</div>` : '';
        return `<tr>
            <td class="num">${i}</td>
            <td><div class="zhname">${esc(m.zhName)}</div>${orig}${desc}</td>
            <td>${m.cat}</td>
            <td class="dim">${m.topTags || '-'}</td>
            <td>${m.modversion}</td>
            <td>${flags.join(' ')}</td>
            <td><a class="wsbtn" href="${m.workshop}" target="_blank" rel="noopener">创意工坊 ↗</a></td>
        </tr>`;
    };

    const rowsActive = active.map((m, i) => rowHtml(m, i + 1)).join('\n');
    const rowsIdle = idle.map((m, i) => rowHtml(m, i + 1)).join('\n');

    const conflictHtml = conflicts.map(w => `
        <div class="alert">
            <b>⚠ ${w.label}</b> 共 ${w.names.length} 个，可能是同一 mod 的不同版本，同时启用易冲突：
            <ul>${w.names.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
            建议只保留一个。
        </div>`).join('\n');

    const addonHtml = addons.map(w => `
        <div class="addon">
            <b>🔗 ${w.label}</b>：本体 + 补丁/汉化，属于<b>配套关系，需要同时启用</b>，顺序已排好，不必担心
            <ul>${w.names.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>`).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>潜渊症 Mod 排序 v2</title>
<style>
body{background:#0f1219;color:#e6e9ef;font-family:"Microsoft YaHei",sans-serif;margin:0;padding:24px}
h1{font-size:20px}.sub{color:#8b94a8;font-size:13px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{background:#1a2030;padding:8px;text-align:left;border-bottom:1px solid #2a3346}
td{padding:7px 8px;border-bottom:1px solid #1e2534}
tr:hover td{background:#161c28}
.num{color:#8b94a8;width:36px}.dim{color:#7f8aa0;font-size:11.5px}
.tag{font-size:11px;padding:2px 7px;border-radius:10px}
.warn{background:#4a3a12;color:#f5c451}.danger{background:#4a1a1e;color:#f87171}
.info{background:#1c2c3a;color:#7dd3fc}
.ok{background:#12301e;color:#4ade80}
.off{background:#2c2c2c;color:#9ca3af}
h2.sec{font-size:15px;margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid #2a3346}
h2.sec span{color:#8b94a8;font-size:12.5px;font-weight:normal;margin-left:8px}
.cols{display:flex;gap:22px;align-items:flex-start}
.col{flex:1;min-width:0}
.col table{font-size:12px}
.col td,.col th{padding:6px 6px}
@media(max-width:1100px){.cols{flex-direction:column}}
.alert{background:#1e1a2e;border-left:3px solid #a78bfa;padding:11px 14px;margin:10px 0;border-radius:6px;font-size:13px}
.addon{background:#12261c;border-left:3px solid #4ade80;padding:11px 14px;margin:10px 0;border-radius:6px;font-size:13px}
.alert ul{margin:6px 0 0 18px}
.stat{display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap}
.stat div{background:#161c28;padding:8px 14px;border-radius:8px;font-size:12.5px}
.hint{background:#12261c;border-left:3px solid #4ade80;padding:11px 14px;border-radius:6px;font-size:13px;margin-bottom:16px}
.zhname{font-size:13.5px;color:#e6e9ef;font-weight:600}
.orig{font-size:11px;color:#7f8aa0;margin-top:2px}
.desc{font-size:11.5px;color:#aeb6c6;margin-top:3px;line-height:1.4;max-width:360px}
.wsbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:6px 0 14px}
.wsbig{background:#1b3a5c;color:#7dd3fc;border:1px solid #2a5b86;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13.5px;font-weight:600}
.wsbig:hover{background:#234c74}
.wstip{font-size:12px;color:#8b94a8}
.wsbtn{display:inline-block;background:#1c2c3a;color:#7dd3fc;border:1px solid #2a4156;padding:4px 10px;border-radius:7px;text-decoration:none;font-size:12px;white-space:nowrap}
.wsbtn:hover{background:#274055}
.tag.ok{background:#12301e;color:#4ade80}
.tag.off{background:#2c2c2c;color:#9ca3af}
</style></head><body>
<h1>潜渊症 Mod 加载顺序（按实际内容分析）</h1>
<div class="sub">游戏 ${GAME_VERSION} · ${mods.length} 个 mod · ${new Date().toLocaleString('zh-CN')}</div>
<div class="wsbar">
  <a class="wsbig" href="https://steamcommunity.com/app/602960/workshop/" target="_blank" rel="noopener">🌐 打开潜渊症创意工坊</a>
  <span class="wstip">点每个 mod 右侧的「创意工坊 ↗」可直达该 mod 页面（订阅 / 取消订阅 / 看说明）。已启用=绿，未启用=灰。</span>
</div>
<div class="stat">
  <div>Mod：<b>${mods.length}</b></div>
  <div>已启用（参与加载）：<b>${installedCount}</b></div>
  <div>未启用（需去游戏内勾选）：<b>${mods.length - installedCount}</b></div>
  <div>版本不匹配：<b>${oldCount}</b></div>
  <div>疑似冲突：<b>${conflicts.length}</b></div>
  <div>配套组合：<b>${addons.length}</b></div>
</div>
<div class="hint">
按表格<b>从上到下</b>照排。<b>加载顺序自上而下，后加载的覆盖先加载的</b>。<br>
分层：<b>① 原版核心 → ② 前置框架 → ③ 性能优化（纯脚本） → ④ 原版微调/优化覆写 → ⑤ 功能/QoL → ⑥ 大型内容/玩法 → ⑦ 附加包/补丁 → ⑧ 汉化覆盖</b>
</div>
${conflictHtml}
${addonHtml}
${idle.length ? `
<div class="addon">
    <b>提示</b>：上面第 ② 组想启用的话，去游戏 Mods 页面勾选即可。
    <br>其中<b>外骨格乙女</b>有 6 个版本、<b>Blue Archive</b> 有 2 个，<b>同系列只能勾选一个</b>，否则会重复定义导致报错。
</div>` : ''}
<div class="cols">
  <div class="col">
    <h2 class="sec">① 已启用 · ${active.length} 个<span>按此顺序排列，当前真正生效</span></h2>
    <table>
    <tr><th>#</th><th>Mod（中文名 / 原名）</th><th>类别</th><th>实际内容</th><th>版本</th><th>提示</th><th>创意工坊</th></tr>
    ${rowsActive}
    </table>
  </div>
  <div class="col">
    <h2 class="sec">② 未启用 · ${idle.length} 个<span>没勾选，不参与加载</span></h2>
    <table>
    <tr><th>#</th><th>Mod（中文名 / 原名）</th><th>类别</th><th>实际内容</th><th>版本</th><th>提示</th><th>创意工坊</th></tr>
    ${rowsIdle}
    </table>
  </div>
</div>
<div class="sub" style="margin-top:16px">只读分析，不修改任何游戏文件。</div>
</body></html>`;

    fs.writeFileSync(OUT, html, 'utf8');

    // 同时输出纯文本清单，方便对照拖拽
    const txt = mods.map((m, i) =>
        `${String(i + 1).padStart(2, '0')}  [${m.cat}]  ${m.enabled ? '√已启用' : '×未启用'}  ${m.name}  v${m.modversion}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'sorted.txt'), txt, 'utf8');

    // 机器可读的顺序（workshop id 数组），供 apply.js 写入游戏配置
    fs.writeFileSync(
        path.join(__dirname, 'order.json'),
        JSON.stringify(mods.map(m => m.id), null, 2),
        'utf8'
    );

    console.log('已生成 ' + OUT);
    console.log(`Mod ${mods.length} | 版本不匹配 ${oldCount} | 疑似冲突 ${conflicts.length} | 配套 ${addons.length}`);
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- 重新排序（供网页管理器在启用后再次排序使用）----------
// 规则（后加载覆盖先加载，所以“越靠后优先级越高”）：
//   ① 脚本框架置顶 → ② 按分层 tier 升序 → ③ 补丁/扩展紧跟本体 → ④ 依赖排在使用方之前（拓扑）
//   → ⑤ 汉化覆盖沉底 → ⑥ 旧框架 / 作者已废弃 沉底
// list: 含 { id, name, tier, deps } 的数组；返回重排后的新数组（数组上带 .notes 说明本次做了哪些调整）
function resortActive(list) {
    const nm = (m) => String((m && m.name) || '');
    const isLuaFrame = m => /luacsforbarotrauma/i.test(nm(m));
    const isClientSide = m => /luacsclientside/i.test(nm(m));
    const isOldFrame = m => /^csforbarotrauma/i.test(nm(m)) && !/luacs/i.test(nm(m));
    const isDead = m => /已被.{0,10}取代|废弃|已弃用|deprecated|不再维护/i.test(nm(m));
    const isZh = m => /汉化|简体|chinese|cn_zh/i.test(nm(m));
    const isAddon = m => /(补丁|patch|扩展|拓展|expansion|extra|add-?on|兼容|compat)/i.test(nm(m));

    const head = [];
    list.forEach(m => {
        if ((isLuaFrame(m) || isClientSide(m)) && head.indexOf(m) < 0) head.push(m);   // 去重：避免同一个 mod 被启用两次
    });
    const tail = list.filter(m => isOldFrame(m) || isDead(m));
    const zh = list.filter(m => isZh(m) && tail.indexOf(m) < 0);
    let rest = list.filter(m => head.indexOf(m) < 0 && tail.indexOf(m) < 0 && zh.indexOf(m) < 0);

    const notes = [];
    if (head.length) notes.push('脚本框架置顶 ' + head.length + ' 个（Lua/C# 依赖它）');

    // ① 分层：tier 小的先加载；同层按名称，保证结果稳定可复现
    const byTier = (a, b) => (a.tier - b.tier) || nm(a).localeCompare(nm(b), 'zh');
    rest.sort(byTier);
    zh.sort(byTier);

    // ② 补丁 / 扩展 / 兼容包紧跟本体：后加载才能盖住本体（汉化单独沉底，不参与）
    let addonMoved = 0;
    const restIds = new Set(rest.map(m => m.id));
    rest.filter(isAddon).forEach(p => {
        let base = null;
        const dep = (p.deps || []).filter(d => d && restIds.has(d.id))[0];
        if (dep) base = rest.filter(m => m.id === dep.id)[0];
        if (!base) {
            const b = nm(p).replace(/Lua补丁|自用汉化|汉化补丁|汉化|补丁|Lua\s*Patch|Patch/gi, '').trim();
            if (b) base = rest.filter(m => m !== p && !isAddon(m) && nm(m).indexOf(b) === 0)[0];
        }
        if (!base) return;
        const bi = rest.indexOf(base), pi = rest.indexOf(p);
        if (pi === bi + 1) return;                       // 已经紧邻本体，不用动
        rest.splice(pi, 1);
        rest.splice(rest.indexOf(base) + 1, 0, p);
        addonMoved++;
    });
    if (addonMoved) notes.push('补丁/扩展归位到本体之后 ' + addonMoved + ' 个');

    // ③ 依赖拓扑：前置（框架 / 系列本体）必须排在使用它的 mod 之前
    const all = rest.concat(zh);
    const restLen = rest.length;
    const idx = new Map();
    const reindex = () => { idx.clear(); all.forEach((m, i) => idx.set(m.id, i)); };
    reindex();
    let depMoved = 0, guard = all.length * all.length + 20;
    for (let i = 0; i < all.length && guard-- > 0; i++) {
        const m = all[i];
        if (isZh(m)) continue;                           // 汉化永远留在最后一段，不能前移
        const ds = (m.deps || []).filter(d => d && idx.has(d.id) && idx.get(d.id) > i);
        if (!ds.length) continue;
        const target = Math.max.apply(null, ds.map(d => idx.get(d.id)));
        all.splice(i, 1);                                 // 移除后 target 下标左移一位
        all.splice(target, 0, m);                         // 插到最靠后的依赖之后
        reindex();
        i = -1;                                           // 变动后重新扫一遍
        depMoved++;
    }
    if (depMoved) notes.push('依赖顺序修正 ' + depMoved + ' 处（前置排到使用方之前）');

    // 按「是不是汉化」重新划分，不能按下标切：拓扑调整会打乱位置
    const zhIds = new Set(zh.map(m => m.id));
    rest = all.filter(m => !zhIds.has(m.id));
    const zhOut = all.filter(m => zhIds.has(m.id));

    if (zhOut.length) notes.push('汉化覆盖沉底 ' + zhOut.length + ' 个（最后加载才能盖住原文）');
    if (tail.length) notes.push('旧框架/已废弃沉底 ' + tail.length + ' 个（建议停用）');

    const out = head.concat(rest, zhOut, tail);
    out.notes = notes;
    return out;
}

// 作为库被 server.js 复用时不自动执行
if (require.main === module) {
    main();
}

module.exports = {
    analyze, classify, loadEnabledIds, stripAddon, esc, resortActive, detectSeries,
    GAME_VERSION, getPaths, refreshPaths, saveUserPaths, loadUserPaths, PATHS_FILE,
    // 兼容旧用法（初始快照，运行时请用 getPaths()）
    GAME, WORKSHOP, INSTALLED, LOCALMODS,
};
