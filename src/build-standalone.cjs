const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'index.html');
let page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

for (const filename of ['go-engine.js', 'winrate-panel.js', 'go-record.js', 'go-ending.js']) {
  const tag = `<script src="./${filename}"></script>`;
  if (!page.includes(tag)) throw new Error(`找不到脚本标签：${filename}`);
  const script = fs.readFileSync(path.join(__dirname, filename), 'utf8')
    .replace(/<\/script/gi, '<\\/script');
  page = page.replace(tag, () => `<script>\n${script}\n</script>`);
}

fs.writeFileSync(output, page);
console.log(`单文件网页：${output}`);
