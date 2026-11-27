import type { Interface } from 'node:readline/promises'
import { styleText } from 'node:util'
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getActiveModelConfig,
  getProviderByName,
  listProviders,
  listProvidersWithModels,
  maskApiKey,
  setActiveModel,
  updateProvider,
} from '../config.ts'
import type { CommandContext, SlashCommand } from './types.ts'

function printInfo(text: string) {
  process.stdout.write(styleText('blueBright', `${text}\n`))
}

function printSuccess(text: string) {
  process.stdout.write(styleText('greenBright', `${text}\n`))
}

function printWarn(text: string) {
  process.stdout.write(styleText('yellowBright', `${text}\n`))
}

function printError(text: string) {
  process.stdout.write(styleText('redBright', `${text}\n`))
}

function printUsage() {
  printInfo([
    '用法：',
    '  /model                        查看所有供应商与模型（含当前激活项）',
    '  /model use <别名>             切换当前激活模型并立即生效',
    '  /model add                    交互式添加模型（可同时新建供应商）',
    '  /model rm <别名>              删除指定模型',
    '  /model provider               查看所有供应商',
    '  /model provider add           交互式添加供应商',
    '  /model provider edit <名称>   修改供应商的 Base URL 或 API Key',
    '  /model provider rm <名称>     删除供应商及其旗下模型',
  ].join('\n'))
}

function printModelList() {
  const groups = listProvidersWithModels()
  if (groups.length === 0) {
    printWarn('当前还没有任何供应商和模型配置，请运行 /model add 添加。')
    return
  }

  const lines: string[] = []
  for (const group of groups) {
    lines.push(`${group.name}  (${group.base_url}, key: ${maskApiKey(group.api_key)})`)
    if (group.models.length === 0) {
      lines.push('  （暂无模型）')
      continue
    }
    for (const model of group.models) {
      const marker = model.is_active ? '*' : '-'
      const suffix = model.is_active ? '  [当前]' : ''
      const idPart = model.name === model.model_id ? '' : ` (${model.model_id})`
      lines.push(`  ${marker} ${model.name}${idPart}${suffix}`)
    }
  }

  printInfo(lines.join('\n'))
}

function printProviderList() {
  const groups = listProvidersWithModels()
  if (groups.length === 0) {
    printWarn('当前还没有任何供应商配置，请运行 /model provider add 或 /model add 添加。')
    return
  }

  const lines = groups.map(
    (g) => `- ${g.name}  (${g.base_url}, key: ${maskApiKey(g.api_key)}, 模型数: ${g.models.length})`,
  )
  printInfo(lines.join('\n'))
}

async function promptRequired(rl: Interface, label: string): Promise<string | null> {
  const value = (await rl.question(`${label}（直接回车取消）> `)).trim()
  if (!value) {
    printWarn('已取消操作')
    return null
  }
  return value
}

async function handleAddProvider(rl: Interface) {
  const name = await promptRequired(rl, '供应商名称（如 deepseek / openai）')
  if (!name) return

  const baseUrl = await promptRequired(rl, 'Base URL（如 https://api.deepseek.com）')
  if (!baseUrl) return

  const apiKey = await promptRequired(rl, 'API Key')
  if (!apiKey) return

  const created = createProvider({ name, baseUrl, apiKey })
  printSuccess(`已添加供应商：${created.name} (${created.base_url}, key: ${maskApiKey(created.api_key)})`)
}

async function handleEditProvider(name: string | undefined, ctx: CommandContext) {
  if (!name) {
    printWarn('用法：/model provider edit <名称>')
    return
  }

  const existing = getProviderByName(name)
  if (!existing) {
    printError(`未找到供应商 "${name}"`)
    return
  }

  printInfo(`正在修改供应商 ${existing.name}（留空直接回车表示保持原值）：`)
  const baseUrl = (await ctx.rl.question(`Base URL [${existing.base_url}] > `)).trim()
  const apiKey = (await ctx.rl.question(`API Key [${maskApiKey(existing.api_key)}] > `)).trim()

  if (!baseUrl && !apiKey) {
    printWarn('未做任何修改')
    return
  }

  const updated = updateProvider(name, {
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
  })
  printSuccess(`已更新供应商：${updated.name} (${updated.base_url}, key: ${maskApiKey(updated.api_key)})`)

  // 若当前激活模型正好属于该供应商，立即热刷新客户端和工具里的 API Key
  const active = getActiveModelConfig()
  if (active?.providerName === updated.name) {
    await ctx.reloadRuntime()
    printInfo(`当前激活模型 ${active.alias} 已同步应用最新供应商配置`)
  }
}

async function handleRemoveProvider(name: string | undefined, ctx: CommandContext) {
  if (!name) {
    printWarn('用法：/model provider rm <名称>')
    return
  }

  const group = listProvidersWithModels().find((g) => g.name === name)
  if (!group) {
    printError(`未找到供应商 "${name}"`)
    return
  }

  const confirm = (
    await ctx.rl.question(
      `确认删除供应商 "${name}" 及其旗下的 ${group.models.length} 个模型？(y/N) > `,
    )
  ).trim().toLowerCase()

  if (confirm !== 'y' && confirm !== 'yes') {
    printWarn('已取消删除')
    return
  }

  const { hadActiveModel } = deleteProvider(name)
  printSuccess(`已删除供应商 "${name}"`)
  if (hadActiveModel) {
    await ctx.reloadRuntime()
    printWarn('当前激活模型已随供应商一并删除，请使用 /model use <别名> 或 /model add 重新激活模型')
  }
}

async function handleAddModel(ctx: CommandContext) {
  const { rl } = ctx
  const existingProviders = listProviders()

  let selectedProviderId: string | null = null
  let newProviderDraft: { name: string; baseUrl: string; apiKey: string } | null = null

  if (existingProviders.length === 0) {
    printInfo('当前还没有供应商，先填写供应商信息：')
    const pName = await promptRequired(rl, '供应商名称（如 deepseek / openai）')
    if (!pName) return
    const baseUrl = await promptRequired(rl, 'Base URL（如 https://api.deepseek.com）')
    if (!baseUrl) return
    const apiKey = await promptRequired(rl, 'API Key')
    if (!apiKey) return
    newProviderDraft = { name: pName, baseUrl, apiKey }
  } else {
    const lines = [
      '选择所属供应商：',
      ...existingProviders.map((p, idx) => `  ${idx + 1}. ${p.name} (${p.base_url})`),
      '  0. 新建供应商',
    ]
    printInfo(lines.join('\n'))

    const choice = (await rl.question('输入编号 [默认 1] > ')).trim() || '1'
    if (choice === '0') {
      const pName = await promptRequired(rl, '供应商名称（如 deepseek / openai）')
      if (!pName) return
      const baseUrl = await promptRequired(rl, 'Base URL（如 https://api.deepseek.com）')
      if (!baseUrl) return
      const apiKey = await promptRequired(rl, 'API Key')
      if (!apiKey) return
      newProviderDraft = { name: pName, baseUrl, apiKey }
    } else {
      const index = Number(choice) - 1
      if (!Number.isInteger(index) || index < 0 || index >= existingProviders.length) {
        printError(`无效的供应商编号：${choice}`)
        return
      }
      selectedProviderId = existingProviders[index].id
    }
  }

  const modelId = await promptRequired(rl, 'Model ID（传给 API 的真实模型名，如 deepseek-pro）')
  if (!modelId) return

  const aliasInput = (await rl.question(`模型别名（用于 /model use 切换）[默认 ${modelId}] > `)).trim()
  const alias = aliasInput || modelId

  const hasActive = !!getActiveModelConfig()
  let activate = true
  if (hasActive) {
    const ans = (await rl.question('是否立即设为当前激活模型？(Y/n) > ')).trim().toLowerCase()
    activate = ans !== 'n' && ans !== 'no'
  }

  // 所有字段收集完再统一落库，避免中途取消留下空的供应商记录
  const providerId = selectedProviderId ?? createProvider(newProviderDraft!).id
  const created = createModel({
    providerId,
    name: alias,
    modelId,
    activate,
  })

  if (created.is_active) {
    await ctx.reloadRuntime()
    printSuccess(`已添加并激活模型：${created.name} (${created.model_id})`)
  } else {
    printSuccess(`已添加模型：${created.name} (${created.model_id})`)
  }
}

async function handleUseModel(alias: string | undefined, ctx: CommandContext) {
  if (!alias) {
    printWarn('用法：/model use <别名>')
    return
  }

  const active = setActiveModel(alias)
  await ctx.reloadRuntime()
  printSuccess(`已切换当前模型：${active.alias} (${active.modelId} @ ${active.providerName})`)
}

async function handleRemoveModel(alias: string | undefined, ctx: CommandContext) {
  if (!alias) {
    printWarn('用法：/model rm <别名>')
    return
  }

  const { deleted, wasActive } = deleteModel(alias)
  printSuccess(`已删除模型：${deleted.name} (${deleted.model_id})`)
  if (wasActive) {
    await ctx.reloadRuntime()
    printWarn('被删除的是当前激活模型，请使用 /model use <别名> 或 /model add 激活其他模型')
  }
}

export const modelCommand: SlashCommand = {
  name: '/model',
  description: '管理供应商与模型配置（add / use / rm / provider）',
  execute: async ({ args }, ctx) => {
    const [sub, arg1, arg2] = args

    try {
      if (!sub) {
        printModelList()
        return
      }

      switch (sub) {
        case 'list':
        case 'ls':
          printModelList()
          return

        case 'add':
          await handleAddModel(ctx)
          return

        case 'use':
          await handleUseModel(arg1, ctx)
          return

        case 'rm':
        case 'remove':
          await handleRemoveModel(arg1, ctx)
          return

        case 'provider':
          if (!arg1 || arg1 === 'list' || arg1 === 'ls') {
            printProviderList()
          } else if (arg1 === 'add') {
            await handleAddProvider(ctx.rl)
          } else if (arg1 === 'edit') {
            await handleEditProvider(arg2, ctx)
          } else if (arg1 === 'rm' || arg1 === 'remove') {
            await handleRemoveProvider(arg2, ctx)
          } else {
            printUsage()
          }
          return

        case 'help':
        case '-h':
        case '--help':
          printUsage()
          return

        default:
          printWarn(`未知子命令：/model ${sub}`)
          printUsage()
      }
    } catch (e) {
      printError(`操作失败：${(e as Error).message}`)
    }
  },
}
