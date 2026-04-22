import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadEnvLocal() {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.+)$/)
      if (match) process.env[match[1].trim()] = match[2].trim()
    }
  } catch {}
}

loadEnvLocal()

export default defineConfig({
  test: {},
})
