// ------------------------------------------------ where a read may go unasked
// Reading never changes anything, so on a turn someone else started (hold.ts)
// reads ran unasked. But what is read can be repeated in the room, and the
// reply guard only matches patterns, so a colleague could get the owner's
// Claude memory, settings or keys read and paraphrased. So:
//
//   - a turn someone else started reads inside the session's project unasked,
//     and anything outside it (another project, ~/.claude, ~/.ssh …) or a
//     secret-looking file anywhere waits for the owner's card;
//   - inside an approved task, reads stay free except the owner's private data
//     (~/.claude, ~/.ssh, cloud credentials, secret-looking files), which waits
//     for the card, and so does a shell command that names those places.
//
// Paths are compared as text after resolving `~`, `.` and `..`; symlinks are
// not followed (a link inside the project pointing out is still "inside").

// Under the home folder: the owner's Claude data and credentials.
const PRIVATE_HOME = ['.claude', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.config/gcloud', '.config/gh', '.azure', '.oci', 'Library/Keychains', 'Library/Application Support/Claude']
// Anywhere: files that usually hold secrets.
const SECRET_NAME = /(^|\/)((\.env|[^/]+\.env)(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|\.?secrets?(\.(json|ya?ml|env|txt|toml))?)$/i

// Tools that read, and where their path is.
const PATH_KEYS: Record<string, string[]> = {
  Read: ['file_path'], NotebookRead: ['notebook_path'], LS: ['path'], Grep: ['path'], Glob: ['path', 'pattern'],
}

export function normalize(p: string, base: string, home: string): string {
  let s = String(p ?? '').trim()
  if (!s) return base
  if (s === '~' || s.startsWith('~/')) s = home + s.slice(1)
  if (!s.startsWith('/')) s = `${base}/${s}`
  const out: string[] = []
  for (const part of s.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop(); else out.push(part)
  }
  return '/' + out.join('/')
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

// A glob's fixed leading folders ("/Users/x/.claude/**/*.md" -> "/Users/x/.claude").
function globBase(pattern: string): string {
  const parts = pattern.split('/')
  const i = parts.findIndex((x) => /[*?[{]/.test(x))
  return i < 0 ? pattern : parts.slice(0, i).join('/') || '/'
}

// The paths a read tool call touches (absolute); [] for tools that read no path.
export function readPaths(tool: string, input: Record<string, unknown>, root: string, home: string): string[] {
  const keys = PATH_KEYS[tool]
  if (!keys) return []
  const out: string[] = []
  for (const k of keys) {
    const v = input[k]
    if (typeof v !== 'string' || !v) continue
    if (tool === 'Glob' && k === 'pattern') {
      if (v.startsWith('/') || v.startsWith('~')) out.push(normalize(globBase(v), root, home))
      else if (/(^|\/)\.\.(\/|$)/.test(v)) out.push(normalize(globBase(v), (typeof input.path === 'string' && input.path) ? normalize(input.path, root, home) : root, home))
      continue
    }
    out.push(normalize(v, root, home))
  }
  // Grep / Glob / LS with no path read the project.
  if (!out.length && (tool === 'Grep' || tool === 'Glob' || tool === 'LS')) out.push(root)
  return out
}

export function isPrivate(p: string, home: string): boolean {
  return PRIVATE_HOME.some((d) => within(p, `${home}/${d}`)) || SECRET_NAME.test(p)
}

// Why this read waits for the owner on a turn someone else started, or null.
export function heldTurnRead(tool: string, input: Record<string, unknown>, root: string, home: string): string | null {
  for (const p of readPaths(tool, input, root, home)) {
    if (isPrivate(p, home)) return `it reads ${p}, which may hold private data`
    if (!within(p, root)) return `it reads ${p}, outside this session's project`
  }
  return null
}

// Why this call inside an approved task waits for the owner, or null: reads of
// the owner's private data, and shell commands that name those places.
export function taskPrivateAccess(tool: string, input: Record<string, unknown>, root: string, home: string): string | null {
  for (const p of readPaths(tool, input, root, home)) if (isPrivate(p, home)) return `it reads ${p}, which may hold private data`
  if (tool === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command
    const homes = [home, '~', '$HOME', '${HOME}']
    for (const h of homes) for (const d of PRIVATE_HOME) {
      if (cmd.includes(`${h}/${d}`)) return `the command touches ${h}/${d}, which may hold private data`
    }
    if (/(^|[\s'"=/])(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa)|[\w.-]+\.(pem|p12|pfx|key))(?=$|[\s'";|&)>])/.test(cmd)) return 'the command names a secret-looking file'
  }
  return null
}
