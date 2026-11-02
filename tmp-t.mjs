import { readFileSync, writeFileSync } from 'node:fs'
const file = 'tests/heat.mjs'
let s = readFileSync(file, 'utf8')
s = s.replace(
  "text: '这是很久以前的一句很长的话，占地方'",
  "text: '这是很久以前的一句很长的话，占地方' + '，后面还跟着一长串早就没人提的细节和补充说明，足够把八十字的预算撑满'".repeat(2)",
)
s = s.replace(
  "assert.ok(!text.includes('这是很久以前的一句很长的话'), '冷的应当先让位（预算不够时）')",
  "assert.ok(!text.includes('这是很久以前的一句很长的话'), '冷的应当先让位（预算不够时）：' + text)",
)
writeFileSync(file, s)
