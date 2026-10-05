/**
 * 精确冲突检测
 * 排除原版(Vanilla)已存在的 identifier，只报告"多个 mod 抢着定义同一个新东西"
 * 同时列出"多个 mod 覆盖同一原版物品"的情况（不算错，但只有最后加载的生效）
 */

const fs = require('fs');
const path = require('path');

const GAME = 'D:\\Steam\\steamapps\\common\\Barotrauma';
const CONTENT = path.join(GAME, 'Content');
const INSTALLED = 'C:\\Users\\满余\\AppData\\Local\\Daedalic Entertainment GmbH\\Barotrauma\\WorkshopMods\\Installed';
const OUT = path.join(__dirname, 'conflicts.txt');

const KINDS = /(Item|Character|Jobs|TalentTrees|Talents|Afflictions|NPCSets|NPCConversations|Structure|Submarine)/i;

function walk(dir, cb) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, cb);
        else cb(full);
    });
}

function idsIn(text) {
    const out = [];
    let m;
    const a = /\bidentifier\s*=\s*"([^"]+)"/gi;
    while ((m = a.exec(text)) !== null) out.push(m[1]);
    const b = /<Jobs?\s+name="([^"]+)"/gi;
    while ((m = b.exec(text)) !== null) out.push('job:' + m[1]);
    const c = /<TalentTrees?\s+name="([^"]+)"/gi;
    while ((m = c.exec(text)) !== null) out.push('tree:' + m[1]);
    return out;
}

// 原版 identifier
function loadVanilla() {
    const set = new Set();
    walk(CONTENT, f => {
        if (!/\.xml$/i.test(f)) return;
        let body;
        try {
            body = fs.readFileSync(f, 'utf8');
        } catch (e) {
            return;
        }
        idsIn(body).forEach(i => set.add(i));
    });
    return set;
}

function modName(id) {
    const fl = path.join(INSTALLED, id, 'filelist.xml');
    if (!fs.existsSync(fl)) return null;
    const m = /<contentpackage\s+[^>]*?name="([^"]*)"/i.exec(fs.readFileSync(fl, 'utf8'));
    return m ? m[1] : null;
}

function collectIds(id) {
    const dir = path.join(INSTALLED, id);
    const fl = path.join(dir, 'filelist.xml');
    if (!fs.existsSync(fl)) return [];
    const txt = fs.readFileSync(fl, 'utf8');
    const out = [];
    const re = /<([A-Za-z]+)\s+file="([^"]+)"/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
        if (!KINDS.test(m[1])) continue;
        const rel = m[2].replace('%ModDir%', '').replace(/^[/\\]/, '');
        const file = path.join(dir, rel);
        if (!fs.existsSync(file)) continue;
        let body;
        try {
            body = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue;
        }
        idsIn(body).forEach(i => out.push(i));
    }
    return out;
}

function main() {
    console.log('扫描原版内容...');
    const vanilla = loadVanilla();
    console.log('原版 identifier: ' + vanilla.size + ' 个');

    const mods = fs.readdirSync(INSTALLED).filter(d =>
        fs.statSync(path.join(INSTALLED, d)).isDirectory()
    );

    const owner = {};
    mods.forEach(id => {
        const name = modName(id);
        if (!name) return;
        collectIds(id).forEach(k => {
            (owner[k] = owner[k] || new Set()).add(name);
        });
    });

    const real = [];
    const override = [];
    Object.entries(owner).forEach(([k, set]) => {
        if (set.size < 2) return;
        const modsList = Array.from(set);
        (vanilla.has(k) ? override : real).push({ k, modsList });
    });

    // 按"涉及 mod 数量"排序，多的在前
    real.sort((a, b) => b.modsList.length - a.modsList.length);
    override.sort((a, b) => b.modsList.length - a.modsList.length);

    const lines = [];
    lines.push(`===== 真冲突（多个 mod 抢着定义同一个新东西）=====`);
    lines.push(`共 ${real.length} 处\n`);
    if (!real.length) {
        lines.push('无。各 mod 新增的物品/角色互不撞车。\n');
    } else {
        // 按 mod 组合聚合，避免刷屏
        const grouped = {};
        real.forEach(r => {
            const key = r.modsList.slice().sort().join(' ｜ ');
            (grouped[key] = grouped[key] || []).push(r.k);
        });
        Object.entries(grouped).forEach(([combo, ids]) => {
            lines.push(`【${combo}】`);
            lines.push(`  重复定义 ${ids.length} 个：`);
            lines.push('    ' + ids.slice(0, 25).join(', '));
            if (ids.length > 25) lines.push(`    ...另有 ${ids.length - 25} 个`);
            lines.push('');
        });
    }

    lines.push(`\n===== 原版覆盖（正常，但只有列表最靠后的生效）=====`);
    lines.push(`共 ${override.length} 处\n`);
    override.slice(0, 15).forEach(o => {
        lines.push(`${o.k}`);
        lines.push(`    被 ${o.modsList.length} 个 mod 修改: ${o.modsList.join(' ｜ ')}`);
        lines.push('');
    });
    if (override.length > 15) lines.push(`...另有 ${override.length - 15} 处\n`);

    const out = lines.join('\n');
    fs.writeFileSync(OUT, out, 'utf8');
    console.log(out);
}

main();
