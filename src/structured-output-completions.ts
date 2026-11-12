import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import 'dotenv/config';

const openai = new OpenAI(
  {
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  }
);

const MathReasoning = z.object({
  steps: z.array(
    z.object({
      explanation: z.string(),
      output: z.string(),
    })
  ),
  final_answer: z.string(),
});

const chatCompletion = await openai.chat.completions.parse({
  model: process.env.MODEL_NAME as string,

  messages: [
    {
      role: 'system',
      content: '您是一位非常有帮助的数学辅导老师。请逐步指导用户解决难题。',
    },
    {
      role: 'user',
      content: '如何求解方程 8x + 7 = -23？',
    },
  ],

  response_format: zodResponseFormat(
    MathReasoning,
    'math_reasoning'
  ),
});

const result = chatCompletion.choices[0]?.message.parsed;

console.log(result);