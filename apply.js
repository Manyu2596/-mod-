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
const { analyze, classify, WORKSHOP } = sort;

// 路径现取（sort.js 里 GAME/INSTALLED 是加载时的快照，换环境会失效）
const P = (typeof sort.getPaths === 'function') ? sort.getPaths() : { GAME: sort.GAME, INSTALLED: sort.INSTALLED };
const CONFIG = path.join(P.GAME, 'config_player.xml');
const DISABLE_TIER = 99; // sort.js 里给"旧框架/已废弃"打的档位

// 按当前环境重新拼出某个创意工坊 mod 的 filelist.xml 路径。
// 改过 Windows 用户名 / 换过 Steam 库之后，配置里残留的旧绝对路径会全部失效，
// 游戏找不到文件就会表现为"mod 没启用"。所以这里一律重新生成，不沿用旧值。
// 游戏配置里分隔符是正斜杠，因此统一转换。
function rebuildPath(id) {
    return path.join(P.INSTALLED, String(id), 'filelist.xml').replace(/\\/g, '/');
}

function main() {
    if (!fs.existsSync(CONFIG)) { console.error('找不到配置:', CONFIG); process.exit(1); }

    const xml = fs.readFileSync(CONFIG, 'utf8');

    // 抓出 <regularpackages>...</regularpackages> 整段
    const blockRe = /(<regularpackages>)([\s\S]*?)(<\/regularpackages>)/i;
    const m = blockRe.exec(xml);
    if (!m) { console.error('配置里找不到 <regularpackages>'); process.exit(1); }
    const [, open, inner, close] = m;

    // 解析每个 <package> 及其前面的注释
    const pkgRe = /<package\s+path="([^"]*)"\s*\/>/g;
    const pkgs = [];
    let p;
    while ((p = pkgRe.exec(inner)) !== null) {
        // 注释是可选的：没有注释也要解析出来，否则这个 mod 会被静默丢掉
        const cm = /<!--([\s\S]*?)-->\s*$/.exec(inner.slice(0, p.index));
        const comment = cm ? cm[1].trim() : '';
        const pkgPath = p[1];
        const idm = /Installed[/\\](\d+)[/\\]/i.exec(pkgPath);
        const id = idm ? idm[1] : null;
        // 创意工坊 mod：按当前 INSTALLED 目录重建路径
        // （改过用户名/换过电脑后，配置里残留的旧绝对路径会全部失效，
        //   导致游戏找不到 mod 而"看起来没启用"）
        const path = id ? rebuildPath(id) : pkgPath;
        pkgs.push({ id, path, comment, stale: id && path !== pkgPath });
    }
    if (!pkgs.length) { console.error('没解析到任何 package'); process.exit(1); }

    const staleCount = pkgs.filter(x => x.stale).length;
    if (staleCount) {
        console.log(`⚠ ${staleCount} 个 mod 的旧路径已失效，将按当前环境重建：`);
        console.log(`  ${INSTALLED}`);
    }

    // 给每个已启用 mod 计算分类
    const items = pkgs.map(pkg => {
        let tier = 5, cat = '⑤ 功能', name = pkg.comment || pkg.id || '?';
        if (pkg.id) {
            const a = analyze(pkg.id);
            if (a) {
                name = a.name;
                const c = classify(a);
                const patchBonus = /补丁|patch/i.test(a.name) ? -0.5 : 0;
                // 旧框架 / 废弃（tier 99）不参与减档，否则会因为名字带「补丁」被重新启用
                tier = c.tier >= DISABLE_TIER ? c.tier : c.tier + patchBonus;
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

    // 注释里不能出现 -- ；同时转义 &<>
    const escCmt = s => String(s == null ? '' : s)
        .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
        .replace(/-{2,}/g, '-');
    const indent = '      ';
    const lines = active.map(x =>
        `${indent}<!--${escCmt(x.name)}-->\n${indent}<package\n${indent}  path="${x.path}" />`
    );
    disabled.forEach(x => {
        lines.push(`${indent}<!-- DISABLED by sorter: ${escCmt(x.name)} (${escCmt(x.cat)}) -->`);
        lines.push(`${indent}<!--<package path="${x.path}" />-->`);
    });

    const newInner = '\n' + lines.join('\n') + '\n    ';
    const newBlock = open + newInner + close;

    // 备份
    const bak = CONFIG + '.bak';
    try {
        if (fs.existsSync(bak)) fs.copyFileSync(bak, CONFIG + '.bak1');
        fs.copyFileSync(CONFIG, bak);          // 每次都留一份当前配置，不只第一次
    } catch (e) { console.error('备份失败，已中止：' + e.message); process.exit(1); }

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
