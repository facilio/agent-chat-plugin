// Where this plugin was installed from, read off its folder: a marketplace
// install lives at <claude config>/plugins/cache/<marketplace>/<plugin>/<version>.
// /agent-chat update runs the claude CLI for exactly that, since /plugin isn't
// offered over Remote Control.
export function marketplaceInstall(root: string): { market: string; plugin: string } | null {
  const m = /\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(String(root ?? ''))
  return m && m[1] && m[2] ? { market: m[1], plugin: m[2] } : null
}

// The CLI commands that update it, in order.
export function updateCommands(i: { market: string; plugin: string }): string[][] {
  return [['plugin', 'marketplace', 'update', i.market], ['plugin', 'update', `${i.plugin}@${i.market}`]]
}
