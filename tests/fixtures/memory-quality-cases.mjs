/**
 * 人工合成的记忆质量题集（通用记忆行为，不含任何真实记忆原文）。
 * 加题：往 qualityFacts 追加事实、往 qualityCases 追加查询；query 的每个空格分词必须是期望事实正文的连续子串。
 */
export const qualityFacts = [
  { id: 'qf-1', text: '回答统一用中文，不硬缩成短句', status: 'approved' },
  { id: 'qf-2', text: '解释概念先举例子，再下结论', status: 'approved' },
  { id: 'qf-3', text: '退役记忆要留痕，但前端不主动提示', status: 'approved' },
  { id: 'qf-4', text: '英文术语顺手带一句白话解释', status: 'approved' },
  { id: 'qf-5', text: '调用命令前先问过用户本人', status: 'approved' },
  { id: 'qf-6', text: '索引只存词元和位置，不复制正文', status: 'approved' },
  { id: 'qf-7', text: '弱证据不要加引号，先标出来是假设', status: 'approved' },
  { id: 'qf-8', text: '涉及删除覆盖装东西，先问用户', status: 'approved' },
  { id: 'qf-9', text: '版本号每次只加一位', status: 'approved' },
  { id: 'qf-10', text: '识别图片用本地识图，不用云', status: 'approved' },
]

export const qualityCases = [
  { id: 'c-1', query: '中文 硬缩', expect: ['qf-1'] },
  { id: 'c-2', query: '举例子 结论', expect: ['qf-2'] },
  { id: 'c-3', query: '留痕 前端', expect: ['qf-3'] },
  { id: 'c-4', query: '术语 白话', expect: ['qf-4'] },
  { id: 'c-5', query: '调用命令 问过', expect: ['qf-5'] },
  { id: 'c-6', query: '弱证据 引号', expect: ['qf-7'] },
  { id: 'c-7', query: '删除 覆盖', expect: ['qf-8'] },
  { id: 'c-neg-1', query: '蓝鲸 烘焙 许可证', expect: [] },
  { id: 'c-neg-2', query: '量子 葡萄 腌菜', expect: [] },
]
