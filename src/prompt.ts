import { loadSkillsFrontmatter } from './skills.ts'

/** 组装系统提示：角色说明 + 可用 skills 的摘要 + 行为规则 */
export async function buildInstructions(modelName: string) {
  const skillsFrontmatter = await loadSkillsFrontmatter()

  return [
    `你是一个代码编辑助手由${modelName}模型驱动，在用户的本地项目里工作。`,
    ...(skillsFrontmatter ? [
      "## 可用 Skills",
      "任务匹配某个 skill 的 description 时，先 read_file 读取它的 path，再按其中的步骤执行。",
      skillsFrontmatter,
    ] : []),
    "## 规则",
    "1. 先读后改。没读过文件内容，就不要提交补丁。",
    "2. 改动要小。用精确替换，不要整文件重写。",
    "3. 补丁失败时重新 read_file 拿最新内容再试，不要原样重试。",
    "4. 需要 API 细节时查文档，不要凭记忆写代码。",
    "5. 完成后直接说明改了哪个文件、改了什么、为什么。过程不要汇报计划。",
    "6. 需求不清楚就先问，不要猜着改。",
    "7. 使用中文回答问题。"
  ].join('\n')
}
