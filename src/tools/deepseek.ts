import { z } from 'zod'
import { defineFunctionTool } from './types.ts'

const deepseekWebSearchQueryDescription = [
  '搜索词，1～128 个 Unicode 字符，不能全为空白，支持下方列出的搜索语法。',
  '搜索语法：',
  'query 中的搜索语法会原样传递给搜索服务。下列示例将操作符与搜索词组合使用；你可以在一个 query 中组合多个操作符。',

  `操作符：site:
示例：DeepSeek site:github.com
说明：将结果限制在指定站点，指定多个时用空格分隔并通过 OR 连接，例如 DeepSeek site:github.com OR site:huggingface.co。`,

  `操作符：-site:
示例：DeepSeek -site:example.com
说明：排除指定站点，指定多个时用空格分隔。`,

  `操作符：-
示例：DeepSeek -广告
说明：排除包含指定关键词的网页，指定多个时用空格分隔。`,

  `操作符：-"..."
示例：DeepSeek -"release notes"
说明：排除包含指定短语的网页，短语内可以包含空格，指定多个时用空格分隔。`,

  `操作符："..."
示例：DeepSeek "精确短语"
说明：精确匹配指定短语，指定多个时用空格分隔。`,

  `操作符：lang:
示例：DeepSeek lang:zh,en
说明：将结果限制在指定语言，多种语言用逗号分隔，例如 lang:zh,en。`,

  `操作符：after:
示例：DeepSeek after:2025 或 DeepSeek after:2025-01-01
说明：将结果限制在指定日期之后发布的网页。`,

  `操作符：before:
示例：DeepSeek before:2026 或 DeepSeek before:2026-06-01
说明：将结果限制在指定日期之前发布的网页。`,
];

/** 客户端执行的联网搜索，调用次数记到 usage 的 tool_search */
export function createDeepseekWebSearchTool(getApiKey: () => string | undefined) {
  return defineFunctionTool({
    name: 'deepseek_web_search',
    description: '按 query 搜索网页，返回结构化结果',
    parameters: z.object({
      query: z.string().describe(deepseekWebSearchQueryDescription.join('\n')),
      count: z.number().describe('返回条数，1～50，默认 10'),
    }),
    usageKey: 'tool_search',
    execute: async (args) => {
      const { query, count } = args
      if (!query) {
        return '请提供搜索关键词'
      }
      if (count < 1 || count > 50) {
        return '返回条数必须在 1～50 之间'
      }

      const apiKey = getApiKey()
      if (!apiKey) {
        return '当前模型未配置 API Key'
      }

      const DeepseekSearchResult = z.object({
        rerank_score: z.number(), // 0～3，≥1.5 为优质
        title: z.string(),
        url: z.string(),
        snippet: z.string(), // 短摘要，通常 100～200 字符
        summary: z.string(), // 长摘要，通常 600～800 字符
        content: z.string(), // need_content=false 或缺失时为 ""
        site_name: z.string().nullable(),
        site_icon: z.string().nullable(),
        date: z.string().nullable(), // RFC 3339 UTC，未知为 null
        authority: z.number().int(), // 0～4，-1 表示未知
      })

      const DeepseekSearchResponse = z.object({
        results: z.array(DeepseekSearchResult),
      })

      const response = await fetch('https://api.deepseek.com/v1/tools/search', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
          query,
          count
        })
      }).then(res => res.json())

      const parsedResponse = DeepseekSearchResponse.parse(response)

      return JSON.stringify(parsedResponse, null, 2)
    }
  })
}

/** 客户端执行的网页抓取，调用次数记到 usage 的 tool_fetch */
export function createDeepseekReadUrlTool(getApiKey: () => string | undefined) {
  return defineFunctionTool({
    name: 'deepseek_read_url',
    description: '抓取单个网页，以 Markdown 文本返回页面内容。',
    parameters: z.object({
      url: z.string().describe('要抓取的网页地址，长度不超过 8192；必须为含 host 的 HTTP/HTTPS URL，且不能携带用户名或密码。')
    }),
    usageKey: 'tool_fetch',
    execute: async (args) => {
      const { url } = args
      if (!url) {
        return '请提供网页地址'
      }
      if (url.length > 8192) {
        return '网页地址长度不能超过 8192 个字符'
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return '网页地址必须以 http:// 或 https:// 开头'
      }
      if (url.includes('@')) {
        return '网页地址不能包含用户名或密码'
      }
      const apiKey = getApiKey()
      if (!apiKey) {
        return '当前模型未配置 API Key'
      }
      const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
          url
        })
      }).then(res => res.json())

      const DeepseekReadUrlResult = z.object({
        title: z.string(),
        content: z.string(),
      })

      const parsedResponse = DeepseekReadUrlResult.parse(response)

      return JSON.stringify(parsedResponse, null, 2)
    }
  })
}
