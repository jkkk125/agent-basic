import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import 'dotenv/config';

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
})



const tool: OpenAI.Responses.FunctionTool = {
  type: 'function',
  name: 'print_json_result',
  parameters: {
    
  },
  strict: true
}

const response = await openai.responses.create({
  model: process.env.MODEL_NAME as string,
  input: [
    {
      role: 'system',
      content: '您是一位非常有帮助的数学辅导老师。请逐步指导用户解决难题。',
    },
    {
      role: 'user',
      content: '如何求解方程 8x + 7 = -23？'
    }
  ]
})