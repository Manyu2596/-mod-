/**
 * 用途分析：不依赖 Steam 简介（接口被墙），直接从 mod 实际内容判断它具体干什么。
 * 依据：filelist.xml 声明的内容类型与数量、依赖关系、是否含 Lua/C# 脚本，
 *      并抽样读取内容文件里真实定义的标识符。
 * 输出：purpose.json
 */
const fs = require('fs');
const path = require('path');
const lib = require('./sort.js');

const WORKSHOP = lib.getPaths().WORKSHOP;

function readXml(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

// 抽样：读取 mod 里实际定义的内容名称，让用途更具体
function sampleNames(modDir, fileListXml, kind, limit) {
    const re = new RegExp('<' + kind + '\\s+file="([^"]+)"', 'g');
    const out = [];
    let m;
    while ((m = re.exec(fileListXml)) !== null && out.length < limit * 3) {
        const rel = m[1].replace('%ModDir%', '').replace(/^[/\\]/, '');
        const p = path.join(modDir, rel);
        if (!fs.existsSync(p)) continue;
        const s = readXml(p);
        const hits = [...s.matchAll(/\b(?:identifier|name)="([^"]+)"/g)]
            .map(x => x[1])
            .filter(v => v && v.length <= 36 && !v.startsWith('%'));
        out.push(...hits.slice(0, 2));
    }
    return [...new Set(out)].slice(0, limit);
}

const KIND_ZH = {
    Character: '角色/怪物', Item: '物品装备', Submarine: '潜艇船只', Text: '文本',
    Talents: '天赋', TalentTrees: '天赋树', Jobs: '职业', Afflictions: '症状状态',
    Missions: '任务', RandomEvents: '随机事件', NPCSets: 'NPC', Factions: '派系',
    Structure: '建筑结构', Sounds: '音效', Particles: '粒子特效', UIStyle: '界面样式',
    Decals: '贴图', LocationTypes: '地点类型', Orders: '指令', Wreck: '沉船',
    EnemySubmarine: '敌方潜艇', BeaconStation: '信标站', OutpostConfig: '前哨站',
    UpgradeModules: '升级模块', StartItems: '初始物品', Corpses: '尸体',
    ServerExecutable: '服务端程序', LevelGeneration: '关卡生成',
};

function purposeOf(m, samples) {
    const t = m.tags || {};
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    const n = m.name || '';

    // 框架类
    if (/luacsforbarotrauma/i.test(n)) return '前置框架：让游戏支持 Lua+C# 脚本类 mod，必须最先加载';
    if (/luacsclientside/i.test(n)) return '前置框架：强制客户端加载 Lua 脚本（联机用）';
    if (/^csforbarotrauma/i.test(n)) return '旧版脚本框架（已被 LuaCs 取代，不应启用）';

    // 汉化 / 文本
    if (/汉化|简体|Chinese|CN_zh/i.test(n)) return '汉化覆盖：把文本替换为中文，应放最后加载';

    // 有依赖 → 多半是补丁/扩展
    if (m.deps && m.deps.length) {
        const base = m.deps.join('、');
        if (/补丁|兼容/i.test(n)) return '兼容补丁：配合「' + base + '」使用，解决内容冲突';
        if (/补丁|patch|expansion|拓展|扩展/i.test(n)) return '扩展补丁：基于「' + base + '」追加内容';
    }
    if (/补丁|patch/i.test(n)) return '补丁/修正类：调整或修复现有内容';

    // 纯脚本（无内容文件）
    if (total === 0 && (m.hasLua || m.hasCs)) {
        const lang = [m.hasLua ? 'Lua' : '', m.hasCs ? 'C#' : ''].filter(Boolean).join('+');
        return '脚本机制类：不新增内容，用 ' + lang + ' 改游戏机制/性能';
    }

    const rank = Object.entries(t).sort((a, b) => b[1] - a[1]);

    // 按“数量 × 权重”判断主用途（潜艇单体价值高给 12，角色给 4，其余按数量）
    const c = {
        '潜艇船只': ((t.Submarine || 0) + (t.EnemySubmarine || 0)) * 12,
        '角色内容': (t.Character || 0) * 4,
        '职业/天赋': (t.Jobs || 0) + (t.Talents || 0) + (t.TalentTrees || 0),
        '物品装备': t.Item || 0,
        '症状机制': t.Afflictions || 0,
        'NPC/派系': (t.NPCSets || 0) + (t.Factions || 0) + (t.NPCConversations || 0),
        '事件/任务': (t.RandomEvents || 0) + (t.Missions || 0) + (t.LocationTypes || 0),
        '文本覆盖': t.Text || 0,
        '音效/特效': (t.Sounds || 0) + (t.Particles || 0) + (t.Decals || 0),
    };
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
    const unit = {
        '潜艇船只': '艘潜艇', '角色内容': '个角色/怪物', '职业/天赋': '项职业或天赋',
        '物品装备': '件物品', '症状机制': '项状态效果', 'NPC/派系': '项 NPC/派系',
        '事件/任务': '项事件或任务', '文本覆盖': '处文本', '音效/特效': '项音效/特效',
    };

    const best = Object.entries(c).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
    let s;
    if (!best) {
        s = '其他内容：' + rank.slice(0, 3).map(([k, v]) => (KIND_ZH[k] || k) + '×' + v).join('、');
    } else {
        s = best[0] + '：新增/改动 ' + raw[best[0]] + ' ' + unit[best[0]];
        const others = Object.entries(raw)
            .filter(([k, v]) => k !== best[0] && v > 0)
            .sort((a, b) => b[1] - a[1]).slice(0, 2)
            .map(([k, v]) => k + '×' + v);
        if (others.length) s += '（另含 ' + others.join('、') + '）';
    }

    if (m.hasLua || m.hasCs) {
        s += '；含' + [m.hasLua ? 'Lua' : '', m.hasCs ? 'C#' : ''].filter(Boolean).join('+') + '脚本';
    }
    if (samples && samples.length) s += '（例：' + samples.join('、') + '）';
    return s;
}

function main() {
    let ids = [];
    try {
        ids = fs.readdirSync(WORKSHOP)
            .filter(d => { try { return fs.statSync(path.join(WORKSHOP, d)).isDirectory(); } catch (e) { return false; } });
    } catch (e) {
        console.error('读不了工坊目录 ' + WORKSHOP + '：' + e.message);
        process.exit(1);
    }
    const out = {};
    ids.forEach(id => {
        const m = lib.analyze(id);
        if (!m) return;
        const xml = readXml(path.join(WORKSHOP, id, 'filelist.xml'));
        const samples = sampleNames(path.join(WORKSHOP, id), xml, 'Item', 3);
        out[id] = {
            name: m.name,
            purpose: purposeOf(m, samples),
            content: m.topTags,
            deps: m.deps,
        };
    });
    fs.writeFileSync(path.join(__dirname, 'purpose.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log('已分析 ' + Object.keys(out).length + ' 个 mod -> purpose.json\n');
    Object.values(out).forEach(v => {
        console.log(v.name.slice(0, 24).padEnd(26) + ' => ' + v.purpose);
    });
}

main();
