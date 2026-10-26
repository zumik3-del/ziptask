export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [message => /^Release v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(message.trim())]
}
