import { OpenAI } from 'openai';
import { z } from 'zod'
import 'dotenv/config'
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod'

const openai = new OpenAI(
  {
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  }
);

const Step = z.object({
  explanation: z.string(),
  output: z.string(),
})

const MathReasoning = z.object({
  steps: z.array(Step),
  final_answer: z.string(),
})

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
  ],
  text: {
    format: zodTextFormat(MathReasoning, 'json_schema'),
  }
})

console.log(response.output_text)

