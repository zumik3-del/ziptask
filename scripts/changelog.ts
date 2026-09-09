import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = 'zumik3-del/ziptask'
process.chdir(resolve(import.meta.dir, '..'))

function gitStatus(): string {
  return execSync('git status --porcelain', { encoding: 'utf8' }).trim()
}

function fail(msg: string): never {
  process.stderr.write(`\nERROR: ${msg}\n\n`)
  process.exit(1)
}

function niceDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

const porcelain = gitStatus()
if (porcelain.length) {
  fail('Git sandbox has local changes. Please commit before updating changelog.')
}

const tags = execSync('git tag --list --sort=creatordate', { encoding: 'utf8' }).trim().split(/\n/)
if (tags.length < 2) {
  fail('Need at least 2 tags to generate changelog.')
}

let md = '# Changelog'

for (let i = tags.length - 1; i >= 1; i--) {
  const tag = tags[i]
  const prevTag = tags[i - 1]
  const cmd = `git log ${prevTag}..${tag} --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short`
  const output = execSync(cmd, { encoding: 'utf8' }).trim()
  if (!output) continue

  let section = `\n## ${tag}\n\n`
  const lines = output.split('\n')
  let first = true

  for (const line of lines) {
    const parts = line.split('|')
    if (parts.length < 4) continue
    const shortHash = parts[0]
    const fullHash = parts[1]
    const date = parts[2]
    const subject = parts.slice(3).join('|')

    if (subject.match(/\b(CHANGELOG|Version)\b/)) continue

    if (first) {
      section += `> ${niceDate(date)}\n\n`
      first = false
    }

    section += `- [\`${shortHash}\`](https://github.com/${REPO}/commit/${fullHash}): ${subject}\n`
  }

  if (first) continue
  md += section
}

const oldestTag = tags[0]
const oldestDate = execSync(`git log -1 --format='%ad' --date=short ${oldestTag}`, { encoding: 'utf8' }).trim()
md += `\n## ${oldestTag}\n\n> ${niceDate(oldestDate)}\n\n- Initial release\n`

writeFileSync('CHANGELOG.md', md)

if (!gitStatus().length) {
  console.log('Changelog unchanged, skipping commit.')
  process.exit(0)
}

execSync('git add CHANGELOG.md && git commit --no-verify -m "docs: update CHANGELOG.md" && git push', { stdio: 'inherit' })
console.log('CHANGELOG.md updated and committed.')
