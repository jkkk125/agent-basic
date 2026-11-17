import pfs from 'node:fs/promises'
import path from 'node:path'

const SKILLS_DIR = '.agents/skills'

/** 读取每个 skill 的 frontmatter（name / description），只把摘要放进系统提示，正文由模型按需 read_file */
export const loadSkillsFrontmatter = async () => {
  const entries = await pfs.readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => [])
  const skills = await Promise.all(
    entries.filter(e => e.isDirectory()).map(async ({ name: dir }) => {
      const file = path.join(SKILLS_DIR, dir, 'SKILL.md')
      const text = await pfs.readFile(file, 'utf-8').catch(() => null)
      const frontmatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
      if (!frontmatter) return null
      // 只取第一个冒号切分，description 里含冒号也不会被截断
      const meta = Object.fromEntries(
        frontmatter.split(/\r?\n/).map(line => {
          const i = line.indexOf(':')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
      )
      return `- name: ${meta.name}\n  description: ${meta.description}\n  path: ${file}`
    }),
  )
  return skills.filter(Boolean).join('\n\n')
}
