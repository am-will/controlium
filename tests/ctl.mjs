// One-shot client for controld.mjs. Usage: node ctl.mjs <tool> '<jsonArgs>'
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const DIR = "/tmp/ctrl";
const name = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const id = Date.now() + "-" + Math.floor(Math.random() * 10000);
writeFileSync(join(DIR, `req-${id}.json`), JSON.stringify({ id, name, args }));
const resP = join(DIR, `res-${id}.json`);
const start = Date.now();
(async () => {
  while (Date.now() - start < 90000) {
    if (existsSync(resP)) { const r = readFileSync(resP, "utf8"); try { unlinkSync(resP); } catch {} console.log(r); process.exit(0); }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error("ctl timeout"); process.exit(1);
})();
