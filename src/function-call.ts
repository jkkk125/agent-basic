import { OpenAI } from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import 'dotenv/config'

const tool: OpenAI.Responses.FunctionTool = {
  type: 'function',
  name: 'get_patient',
  description: '根据患者 ID 查询患者基本资料',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      patientId: {
        type: 'string',
      },
    },
    required: ['patientId'],
    additionalProperties: false,
  },

  // output_schema: { // output_schema 是告诉模型这个tool的返回值格式是什么样子
  // openai 支持 deepseek不支持
  //   type: 'object',
  //   properties: {
  //     name: {
  //       type: 'string',
  //     },
  //     age: {
  //       type: 'number',
  //     },
  //   },
  //   required: ['name', 'age'],
  //   additionalProperties: false,
  // },
};


const getPatient = (patientId: string) => {
  const dataMap = [
    {
      id: '1',
      name: 'John Doe',
      age: 30,
      gender: 'male',
      phone: '1234567890',
      email: 'john.doe@example.com',
    },
    {
      id: '2',
      name: 'Jane Doe',
      age: 25,
      gender: 'female',
      phone: '0987654321',
      email: 'jane.doe@example.com',
    },
    {
      id: '3',
      name: 'Jim Doe',
      age: 35,
      gender: 'male',
      phone: '1111111111',
      email: 'jim.doe@example.com',
    },
  ];

  const res = dataMap.find(item => item.id === patientId);

  if (!res) {
    return {
      error: '患者不存在',
    };
  }

  return {
    name: res.name,
    // age: res.age,
  }
};

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
})

const input: OpenAI.Responses.ResponseInput = [
  {
    role: 'user',
    content: '请查询患者 ID 为 1 的患者基本资料',
  }
]

const response = await openai.responses.create({
  model: process.env.MODEL_NAME as string,
  input,
  tools: [tool],
})

input.push(...toResponseInputItems(response.output))

if (Array.isArray(response.output) && response.output.length > 0) {
  for (const item of response.output) {
    if (item.type === 'function_call') {
      const args = JSON.parse(item.arguments)
      const toolResult = getPatient(args.patientId)
      const stringifyToolResult = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
      input.push({
        type: 'function_call_output',
        call_id: item.call_id,
        output: stringifyToolResult
      })
    }
  }
}

const finalResponse = await openai.responses.create({
  model: process.env.MODEL_NAME as string,
  input,
  tools: [tool],
})

console.log(finalResponse.output_text)
