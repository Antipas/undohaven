/**
 * A small YAML 1.2 subset parser for cordis patch files.
 * Enough for the layouts dsh actually writes: nested maps and sequences,
 * flow collections, quoted scalars, !!tags, and | / > block scalars.
 * Tabs in indentation are a hard error — that matches the YAML spec and
 * is one of the doctor checks.
 */

export class YamlError extends Error {
  constructor(message, line = 0) {
    super(line ? `YAML line ${line}: ${message}` : message)
    this.name = 'YamlError'
    this.line = line
  }
}

export function parseYaml(input) {
  if (typeof input !== 'string') throw new TypeError('YAML input must be a string')
  if (input.charCodeAt(0) === 0xfeff) throw new YamlError('UTF-8 BOM is not allowed', 1)
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parser = new Parser(text)
  const value = parser.parseNode(0)
  return value === undefined ? null : value
}

class Parser {
  constructor(text) {
    this.lines = text.split('\n')
    this.i = 0
  }

  parseNode(minIndent) {
    const peeked = this.peek()
    if (!peeked || peeked.indent < minIndent) return undefined
    if (peeked.text === '-' || peeked.text.startsWith('- ')) return this.parseSeq(peeked.indent)
    if (looksLikeKey(peeked.text)) return this.parseMap(peeked.indent)
    this.i = peeked.index + 1
    return parseScalar(peeked.text, peeked.line)
  }

  parseSeq(indent) {
    const arr = []
    while (true) {
      const peeked = this.peek()
      if (!peeked || peeked.indent !== indent) break
      if (peeked.text !== '-' && !peeked.text.startsWith('- ')) break
      this.i = peeked.index + 1
      const rest = peeked.text === '-' ? '' : peeked.text.slice(1).trim()
      if (rest === '') {
        const next = this.peek()
        arr.push(next && next.indent > indent ? this.parseNode(next.indent) : null)
        continue
      }
      const indicator = blockIndicator(rest)
      if (indicator && !looksLikeKey(rest)) {
        arr.push(this.parseBlock(indicator, peeked.indent, peeked.line))
        continue
      }
      if (looksLikeKey(rest)) {
        const map = {}
        this.readEntry(map, rest, indent, peeked.line)
        this.readMapKeys(map, indent + 2)
        arr.push(map)
        continue
      }
      arr.push(parseScalar(rest, peeked.line))
    }
    return arr
  }

  parseMap(indent) {
    const map = {}
    this.readMapKeys(map, indent)
    return map
  }

  readMapKeys(map, indent) {
    while (true) {
      const peeked = this.peek()
      if (!peeked || peeked.indent !== indent) break
      if (peeked.text === '-' || peeked.text.startsWith('- ')) break
      if (!looksLikeKey(peeked.text)) break
      this.i = peeked.index + 1
      const { key, value } = splitKey(peeked.text, peeked.line)
      this.assignValue(map, key, value, indent, peeked.line)
    }
  }

  readEntry(map, text, seqIndent, line) {
    const { key, value } = splitKey(text, line)
    this.assignValue(map, key, value, seqIndent + 2, line)
  }

  assignValue(map, key, value, keyIndent, line) {
    const indicator = blockIndicator(value)
    if (indicator) {
      map[key] = this.parseBlock(indicator, keyIndent, line)
      return
    }
    if (value === '') {
      const next = this.peek()
      map[key] = next && next.indent > keyIndent ? this.parseNode(next.indent) : null
      return
    }
    map[key] = parseScalar(value, line)
  }

  parseBlock(indicator, parentIndent, line) {
    const lines = []
    let contentIndent = indicator.explicit
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]
      if (raw.trim() === '') {
        let j = this.i + 1
        while (j < this.lines.length && this.lines[j].trim() === '') j += 1
        if (j >= this.lines.length) break
        this.assertIndent(this.lines[j], j + 1)
        const nextIndent = leadingSpaces(this.lines[j])
        const min = contentIndent ?? parentIndent + 1
        if (nextIndent < min) break
        while (this.i < j) {
          lines.push('')
          this.i += 1
        }
        continue
      }
      this.assertIndent(raw, this.i + 1)
      const indent = leadingSpaces(raw)
      if (contentIndent === null) {
        if (indent <= parentIndent) break
        contentIndent = indent
      }
      if (indent < contentIndent) break
      lines.push(raw.slice(contentIndent))
      this.i += 1
    }
    if (lines.length === 0 && indicator.explicit === null) {
      /* an empty block is valid */
    }
    let text = ''
    if (indicator.fold) {
      for (const entry of lines) {
        if (entry === '') text += '\n'
        else if (text === '' || text.endsWith('\n')) text += entry
        else text += ` ${entry}`
      }
    } else {
      text = lines.join('\n')
    }
    if (indicator.chomp === 'strip') return text.replace(/\n+$/, '')
    if (indicator.chomp === 'keep') return text
    if (text === '') return ''
    return `${text.replace(/\n*$/, '')}\n`
  }

  peek() {
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]
      const line = this.i + 1
      this.assertIndent(raw, line)
      const stripped = stripComment(raw)
      if (stripped.trim() === '' || stripped.trim() === '---' || stripped.trim() === '...') {
        this.i += 1
        continue
      }
      const indent = leadingSpaces(stripped)
      const text = stripped.slice(indent).trim()
      return { indent, text, line, index: this.i }
    }
    return null
  }

  assertIndent(raw, line) {
    if (/^\t/.test(raw) || /^ +\t/.test(raw)) {
      throw new YamlError('tabs are not allowed in indentation', line)
    }
  }
}

function leadingSpaces(raw) {
  let n = 0
  while (raw[n] === ' ') n += 1
  return n
}

function stripComment(line) {
  let single = false
  let double = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (c === "'" && !double) {
      if (single && line[i + 1] === "'") {
        i += 1
        continue
      }
      single = !single
    } else if (c === '"' && !single) {
      if (line[i - 1] !== '\\') double = !double
    } else if (c === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line.trimEnd()
}

function blockIndicator(value) {
  const match = /^([>|])([1-9])?([+-])?$/.exec(value)
  if (!match) return null
  return {
    fold: match[1] === '>',
    explicit: match[2] ? Number(match[2]) : null,
    chomp: match[3] === '-' ? 'strip' : match[3] === '+' ? 'keep' : 'clip',
  }
}

function looksLikeKey(text) {
  try {
    splitKey(text, 0)
    return true
  } catch {
    return false
  }
}

function splitKey(text, line) {
  let single = false
  let double = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "'" && !double) single = !single
    else if (c === '"' && !single) double = !double
    else if (c === ':' && !single && !double) {
      const rest = text.slice(i + 1)
      if (rest === '' || rest.startsWith(' ')) {
        const key = text.slice(0, i).trim()
        if (!key) throw new YamlError('empty key', line)
        return { key: unquotePlain(key), value: rest.trim() }
      }
    }
  }
  throw new YamlError('expected a key', line)
}

function unquotePlain(key) {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return parseScalar(key, 0)
  }
  return key
}

function parseScalar(text, line) {
  let value = text.trim()
  const tag = /^!!\S+\s+/.exec(value)
  if (tag) value = value.slice(tag[0].length).trim()
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value)
    } catch {
      throw new YamlError(`bad double-quoted string ${value.slice(0, 40)}`, line)
    }
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((part) => parseScalar(part, line))
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim()
    const map = {}
    if (!inner) return map
    for (const part of splitFlow(inner)) {
      const { key, value: item } = splitKey(part, line)
      map[key] = item === '' ? null : parseScalar(item, line)
    }
    return map
  }
  if (/^-?(0|[1-9]\d*)$/.test(value)) return Number(value)
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return Number(value)
  return value
}

function splitFlow(inner) {
  const parts = []
  let current = ''
  let single = false
  let double = false
  let depth = 0
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]
    if (c === "'" && !double) single = !single
    else if (c === '"' && !single) double = !double
    if (!single && !double && (c === '[' || c === '{')) depth += 1
    if (!single && !double && (c === ']' || c === '}')) depth -= 1
    if (!single && !double && depth === 0 && c === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
