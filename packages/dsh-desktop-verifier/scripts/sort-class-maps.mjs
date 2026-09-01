const CLASS_LINE = /^(\s*)"([A-Za-z0-9_$]+)": "([^"]+)",?$/

export function sortClassMaps(code) {
  const lines = code.split('\n')
  let sorted = 0
  for (let start = 0; start < lines.length; start++) {
    const first = CLASS_LINE.exec(lines[start] ?? '')
    if (first === null || !first[3].endsWith(first[2]) || first[3] === first[2]) continue
    const prefix = first[3].slice(0, first[3].length - first[2].length)
    let end = start
    while (end + 1 < lines.length) {
      const next = CLASS_LINE.exec(lines[end + 1] ?? '')
      if (next === null || next[1] !== first[1] || next[3] !== prefix + next[2]) break
      end++
    }
    if (end > start) {
      const entries = lines.slice(start, end + 1).map(line => CLASS_LINE.exec(line))
      const commas = lines.slice(start, end + 1).map(line => line.endsWith(','))
      entries.sort((a, b) => (a?.[2] ?? '').localeCompare(b?.[2] ?? '', 'en'))
      const run = entries.map((entry, index) =>
        `${entry?.[1] ?? ''}"${entry?.[2] ?? ''}": "${entry?.[3] ?? ''}"${commas[index] === true ? ',' : ''}`)
      lines.splice(start, run.length, ...run)
      sorted += run.length
    }
    start = end
  }
  return { code: sorted > 0 ? lines.join('\n') : code, sorted }
}
