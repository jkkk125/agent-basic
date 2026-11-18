import { styleText } from 'node:util'
import type { OpenAI } from 'openai'
import type { AgentEvent } from './types.ts'

/** 终端里只预览工具输出的前 N 个字符，完整内容仍会回传给模型 */
const TOOL_OUTPUT_PREVIEW_CHARS = 200

/** 模型的流式事件 → 终端输出 */
function renderStreamEvent(chunk: OpenAI.Responses.ResponseStreamEvent) {
  switch (chunk.type) {
    case 'response.created': // 流式输出第一个事件
      process.stdout.write(styleText('blueBright', `开始生成回答； \n`))
      break

    case 'response.in_progress':
      process.stdout.write(styleText('blueBright', '响应正在生成中； \n'))
      break

    case 'response.output_item.added':
      process.stdout.write(styleText('greenBright', `开始构建output数组第 ${chunk.output_index } 位元素，类型为${chunk.item.type}； \n`))
      break

    case 'response.output_item.done':
      process.stdout.write(styleText('greenBright', `构建output数组第 ${chunk.output_index} 位元素，类型为${chunk.item.type}，构建结束（此时可以拿到此轮输出的output数组）； \n`))
      break

    case 'response.content_part.added':
      process.stdout.write(styleText('greenBright', `开始构建output数组第 ${chunk.output_index} 位元素的content数组第 ${chunk.content_index} 位元素，类型为${chunk.part.type}； \n`))
      break

    case 'response.content_part.done':
      process.stdout.write(styleText('greenBright', `构建output数组第 ${chunk.output_index} 位元素的content数组第 ${chunk.content_index} 位元素，类型为${chunk.part.type}，构建结束（此时可以拿到此轮输出的content数组）； \n`))
      break

    case 'response.reasoning_text.delta':
      process.stdout.write(styleText('cyan', chunk.delta))
      break
    case 'response.reasoning_text.done':
      process.stdout.write(styleText('cyan', `思考过程结束； \n`))
      break

    case 'response.output_text.delta':
      process.stdout.write(`${chunk.delta}`)
      break

    case 'response.output_text.done':
      process.stdout.write('回答文本结束； \n')
      break

    case 'response.function_call_arguments.delta':
      process.stdout.write(styleText('magenta', chunk.delta))
      break

    case 'response.function_call_arguments.done':
      process.stdout.write(styleText('magenta', `函数调用参数结束； \n`))
      break

    case 'response.custom_tool_call_input.delta':
      process.stdout.write(styleText('magenta', chunk.delta))
      break

    case 'response.custom_tool_call_input.done':
      process.stdout.write(styleText('magenta', `自定义工具调用输入结束； \n`))
      break

    case 'response.incomplete':
      process.stdout.write(styleText('yellow', '响应未完成（incomplete），本轮提前结束，保留已产生的中间过程\n'))
      console.log(chunk.response.usage)
      break

    case 'response.failed':
      process.stdout.write(styleText('redBright', `响应失败：${chunk.response.error?.message ?? '未知错误'}\n`))
      break

    case 'response.completed': {
      const { response } = chunk
      console.log(response.usage)
      break
    }
  }
}

/** 把 agent 循环发出的事件打印到终端；只负责展示，不改变任何状态 */
export function renderEvent(event: AgentEvent) {
  switch (event.type) {
    case 'stream':
      renderStreamEvent(event.event)
      break

    case 'tool_start': {
      const { call } = event
      // custom 工具的输入已经在流式阶段完整打印过，这里不再重复
      if (call.type === 'function_call') {
        process.stdout.write(styleText('magenta', `调用工具：${call.name}，参数：${call.arguments}\n`))
      }
      break
    }

    case 'tool_end': {
      const { call, output: result } = event
      if (call.type === 'function_call') {
        const preview = result.length > TOOL_OUTPUT_PREVIEW_CHARS ? `${result.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)}…` : result
        process.stdout.write(styleText('magenta', `工具调用结束，输出：${result.length} 个字符\n${preview}\n`))
      } else {
        process.stdout.write(styleText('magenta', `${result}\n`))
      }
      break
    }

    case 'round_end':
      process.stdout.write(styleText('blueBright', '本轮回答生成完成\n'))
      process.stdout.write(styleText('blueBright', `${'-'.repeat(100)}\n`))
      break

    case 'turn_end':
      process.stdout.write(styleText('blueBright', `工具调用结束\n`))
      break

    case 'max_rounds_reached':
      process.stdout.write(styleText('yellow', '已达到最大轮数仍未得到最终回答，保留已产生的中间过程\n'))
      break

    case 'summary':
      console.log(event.text)
      break
  }
}
