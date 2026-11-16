// ------------------------------------------- what a reply must not leak
// The join rules (INSTRUCTIONS) tell the model not to share the owner's private
// details with colleagues; this is the net under them. A reply that looks like
// it carries one, to a room someone besides the owner can read, waits for the
// owner's Allow/Deny card. Patterns only: a project, customer or person's name
// isn't caught. /agent-chat review on holds every reply in a room instead.
const PUBLIC_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|anthropic\.com|claude\.ai|claude\.com|google\.com|stackoverflow\.com|npmjs\.com|pypi\.org|wikipedia\.org|mozilla\.org|developer\.apple\.com|microsoft\.com|chat\.facilio\.bot|facilio\.com|example\.(com|org|net))$/i
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|in|ai|dev|app|bot|run|work|cloud|internal|local|lan|corp|co|uk|us|ae|sa|au|me|xyz|info|tech|site|online|amazonaws\.com)\b/gi
export function privateDetails(text: string, ownHost?: string): string[] {
  const hits: string[] = []
  const add = (what: string) => { if (!hits.includes(what)) hits.push(what) }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) add('a private key')
  if (/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk|rk)-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(text)) add('a key or token')
  if (/\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*\S{6,}/i.test(text)) add('a credential')
  if (/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/.test(text)) add('an IP address')
  if (/(?<![\d.])\d{12}(?![\d.])/.test(text)) add('a 12-digit id (an AWS account?)')
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text)) add('an email address')
  if (/(?:^|[\s`'"(])(?:~|\/Users|\/home|\/root|\/etc|\/var|\/opt|\/srv|C:\\Users)[\/\\][^\s`'")]+/.test(text)) add('a file path on this machine')
  for (const m of text.matchAll(HOST_RE)) {
    if (PUBLIC_HOSTS.test(m[0]) || /@/.test(text.slice(Math.max(0, m.index! - 1), m.index))) continue
    add(`a host name (${m[0]})`); break
  }
  if (ownHost && ownHost.length >= 4 && text.toLowerCase().includes(ownHost.toLowerCase())) add("this machine's name")
  return hits
}
