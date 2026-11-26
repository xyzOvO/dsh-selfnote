/**
 * 人工合成的记忆质量题集（虚构的中性生活/办公事实，不含任何真实记忆原文）。
 * 加题：往 qualityFacts 追加事实、往 qualityCases 追加查询；query 的每个空格分词必须是期望事实正文的连续子串。
 */
export const qualityFacts = [
  { id: 'qf-1', text: '红色钥匙藏在门口地垫下面', status: 'approved' },
  { id: 'qf-2', text: '烤箱做面包之前要先预热十分钟', status: 'approved' },
  { id: 'qf-3', text: '旧家具处理之前先拍照片留档', status: 'approved' },
  { id: 'qf-4', text: '翻译菜单的时候保留原文菜名', status: 'approved' },
  { id: 'qf-5', text: '进入机房之前要登记访客信息', status: 'approved' },
  { id: 'qf-6', text: '值班钥匙由当天的同事负责保管', status: 'approved' },
  { id: 'qf-7', text: '天气预报说周五有雨记得带伞', status: 'approved' },
  { id: 'qf-8', text: '会议室投影仪用完记得关电源', status: 'approved' },
  { id: 'qf-9', text: '走廊的绿植每周浇水一次', status: 'approved' },
  { id: 'qf-10', text: '快递包裹统一放在前台代收', status: 'approved' },
]

export const qualityCases = [
  { id: 'c-1', query: '红色 地垫', expect: ['qf-1'] },
  { id: 'c-2', query: '烤箱 预热', expect: ['qf-2'] },
  { id: 'c-3', query: '旧家具 照片', expect: ['qf-3'] },
  { id: 'c-4', query: '菜单 菜名', expect: ['qf-4'] },
  { id: 'c-5', query: '机房 访客', expect: ['qf-5'] },
  { id: 'c-6', query: '天气 带伞', expect: ['qf-7'] },
  { id: 'c-7', query: '投影仪 电源', expect: ['qf-8'] },
  { id: 'c-8', query: '绿植 浇水', expect: ['qf-9'] },
  { id: 'c-neg-1', query: '蓝鲸 烘焙 许可证', expect: [] },
  { id: 'c-neg-2', query: '量子 葡萄 腌菜', expect: [] },
]
