/**
 * 把排序结果直接写入游戏配置 config_player.xml 的 <regularpackages>
 * - 先自动备份为 config_player.xml.bak
 * - 只重排"当前已启用"的 mod（不动未启用的）
 * - 汉化/文本覆盖排到最底部（后加载覆盖先加载）
 * - 补丁类紧挨在本体下方
 * - 被分类为"旧框架/已废弃"(tier 99) 的 mod 会被注释禁用，避免覆盖新框架
 */

const fs = require('fs');
const path = require('path');
const sort = require('./sort.js');
const { analyze, classify, WORKSHOP, INSTALLED } = sort;

const CONFIG = path.join(sort.GAME, 'config_player.xml');
const DISABLE_TIER = 99; // sort.js 里给"旧框架/已废弃"打的档位

function main() {
    if (!fs.existsSync(CONFIG)) { console.error('找不到配置:', CONFIG); process.exit(1); }

    const xml = fs.readFileSync(CONFIG, 'utf8');

    // 抓出 <regularpackages>...</regularpackages> 整段
    const blockRe = /(<regularpackages>)([\s\S]*?)(<\/regularpackages>)/i;
    const m = blockRe.exec(xml);
    if (!m) { console.error('配置里找不到 <regularpackages>'); process.exit(1); }
    const [, open, inner, close] = m;

    // 解析每个 <package> 及其前面的注释
    const pkgRe = /<!--([\s\S]*?)-->\s*<package\s+path="([^"]*)"\s*\/>/g;
    const pkgs = [];
    let p;
    while ((p = pkgRe.exec(inner)) !== null) {
        const comment = p[1].trim();
        const pkgPath = p[2];
        const idm = /Installed[/\\](\d+)[/\\]/i.exec(pkgPath);
        const id = idm ? idm[1] : null;
        pkgs.push({ id, path: pkgPath, comment });
    }
    if (!pkgs.length) { console.error('没解析到任何 package'); process.exit(1); }

    // 给每个已启用 mod 计算分类
    const items = pkgs.map(pkg => {
        let tier = 5, cat = '⑤ 功能', name = pkg.comment || pkg.id || '?';
        if (pkg.id) {
            const a = analyze(pkg.id);
            if (a) {
                name = a.name;
                const c = classify(a);
                const patchBonus = /补丁|patch/i.test(a.name) ? -0.5 : 0;
                tier = c.tier + patchBonus;
                cat = c.cat;
            }
        }
        return { ...pkg, tier, cat, name };
    });

    // 按档位排序（升序=从上到下加载）
    items.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, 'zh'));

    // 补丁类：紧挨在本体下方
    items.filter(x => /补丁/.test(x.name)).forEach(pat => {
        const base = pat.name.replace(/Lua补丁|补丁/g, '').trim();
        if (!base) return;
        const main = items.find(x => x !== pat && !/补丁/.test(x.name) && x.name.includes(base));
        if (!main) return;
        items.splice(items.indexOf(pat), 1);
        items.splice(items.indexOf(main) + 1, 0, pat);
    });

    // 分出"应禁用"的旧框架/废弃 mod
    const disabled = items.filter(x => x.tier >= DISABLE_TIER);
    const active = items.filter(x => x.tier < DISABLE_TIER);

    const indent = '      ';
    const lines = active.map(x =>
        `${indent}<!--${x.name}-->\n${indent}<package\n${indent}  path="${x.path}" />`
    );
    disabled.forEach(x => {
        lines.push(`${indent}<!-- DISABLED by sorter: ${x.name} (${x.cat}) -->`);
        lines.push(`${indent}<!--<package path="${x.path}" />-->`);
    });

    const newInner = '\n' + lines.join('\n') + '\n    ';
    const newBlock = open + newInner + close;

    // 备份
    const bak = CONFIG + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(CONFIG, bak);

    if (process.argv.includes('--dry')) {
        console.log('=== DRY RUN（未写入）===');
        console.log(newBlock);
        console.log(`\n启用 ${active.length} 个，禁用 ${disabled.length} 个`);
        return;
    }

    const newXml = xml.replace(blockRe, newBlock);
    fs.writeFileSync(CONFIG, newXml, 'utf8');

    console.log(`已写入 ${CONFIG}`);
    console.log(`启用顺序(${active.length}):`);
    active.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)} [${x.cat}] ${x.name}`));
    if (disabled.length) {
        console.log(`\n已禁用(${disabled.length}，已注释在文件末尾):`);
        disabled.forEach(x => console.log(`  ✗ ${x.name} (${x.cat})`));
    }
    console.log(`\n原配置已备份为 config_player.xml.bak`);
}

main();
