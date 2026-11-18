import { applyPatch } from './applyDiff.ts'
import type { AgentTool } from './types.ts'
import { WORKSPACE_ROOT } from './workspace.ts'

/** custom 工具：模型直接输出整段补丁文本（不是 JSON 参数），由 applyDiff.ts 解析并落盘 */
export const applyPatchTool: AgentTool = {
  name: 'apply_patch',
  spec: {
    type: 'custom',
    name: 'apply_patch',
  },
  execute: async (input) => {
    try {
      return await applyPatch(input as string, WORKSPACE_ROOT)
    } catch (e) {
      return `apply_patch 失败: ${(e as Error).message}`
    }
  },
}
