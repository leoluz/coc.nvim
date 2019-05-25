import { Buffer, Neovim } from '@chemzqm/neovim'
import { Highlight, getHiglights } from '../util/highlight'
import { characterIndex, byteLength } from '../util/string'
import { group } from '../util/array'
import { Documentation, Fragment } from '../types'
import workspace from '../workspace'
import { Chars } from './chars'
import { deepClone } from '../util/object'
const logger = require('../util/logger')('model-floatBuffer')

export default class FloatBuffer {
  private lines: string[] = []
  private highlights: Highlight[]
  private chars = new Chars('@,48-57,_192-255,<,>,$,#,-,`,*')
  private positions: [number, number, number?][] = []
  private enableHighlight = true
  public width = 0
  constructor(
    public buffer: Buffer,
    private nvim: Neovim,
    private joinLines = true) {
    let config = workspace.getConfiguration('coc.preferences')
    this.enableHighlight = config.get<boolean>('enableFloatHighlight', true)
  }

  public getHeight(docs: Documentation[], maxWidth: number): number {
    this.calculateFragments(docs, maxWidth)
    return this.lines.length
  }

  public get valid(): Promise<boolean> {
    return this.buffer.valid
  }

  public get highlightOffset(): number {
    if (this.positions.length == 0) return 0
    let vals = this.positions.map(s => s[1] - 1)
    return Math.min(...vals)
  }

  public calculateFragments(docs: Documentation[], maxWidth: number): Fragment[] {
    let fragments: Fragment[] = []
    let idx = 0
    let currLine = 0
    let newLines: string[] = []
    let fill = false
    let positions = this.positions = []
    for (let doc of docs) {
      let lines: string[] = []
      let content = doc.content.replace(/\s+$/, '')
      let arr = content.split(/\r?\n/)
      let inBlock = false
      if (['Error', 'Info', 'Warning', 'Hint'].indexOf(doc.filetype) !== -1) {
        fill = true
      }
      if (this.joinLines) {
        // join the lines when necessary
        arr = arr.reduce((list, curr) => {
          if (!curr) return list
          if (/^\s*```/.test(curr)) {
            inBlock = !inBlock
          }
          if (list.length) {
            let pre = list[list.length - 1]
            if (!inBlock && !isSingleLine(pre) && !isBreakCharacter(curr[0])) {
              list[list.length - 1] = pre + ' ' + curr
              return list
            }
          }
          list.push(curr)
          return list
        }, [])
      }
      let start = doc.active ? doc.active[0] : null
      let end = doc.active ? doc.active[1] : null
      // let [start, end] = doc.active || []
      for (let str of arr) {
        let len = byteLength(str)
        if (len > maxWidth - 2) {
          // don't split on word
          let parts = this.softSplit(str, maxWidth - 2)
          if (start != null) {
            let count = 0
            let inLine = false
            let idx = 1
            let total = end - start
            for (let line of parts) {
              if (count >= total) break
              if (!inLine && start < line.length) {
                inLine = true
                let len = line.length > end ? total : line.length - start
                count = len
                positions.push([currLine + idx, start + 2, len])
              } else if (inLine && total > count) {
                let len = (total - count) > line.length ? line.length : total - count
                count = count + len
                positions.push([currLine + idx, 2, len])
              } else if (!inLine) {
                start = start - line.length
                end = end - line.length
              }
              idx = idx + 1
            }
          }
          lines.push(...parts)
        } else {
          lines.push(str)
          if (start != null) positions.push([currLine + 1, start + 2, end - start])
        }
      }
      lines = lines.map(s => s.length ? ' ' + s : '')
      fragments.push({
        start: currLine,
        lines,
        filetype: doc.filetype
      })
      newLines.push(...lines.filter(s => !/^\s*```/.test(s)))
      if (idx != docs.length - 1) {
        newLines.push('—')
        currLine = newLines.length
      }
      idx = idx + 1
    }
    let width = this.width = Math.max(...newLines.map(s => byteLength(s))) + 1
    this.lines = newLines.map(s => {
      if (s == '—') return '—'.repeat(width)
      if (fill) return s + ' '.repeat(width - byteLength(s))
      return s
    })
    return fragments
  }

  public async setDocuments(docs: Documentation[], maxWidth: number): Promise<void> {
    let fragments = this.calculateFragments(docs, maxWidth)
    let filetype = await this.nvim.eval('&filetype') as string
    fragments = fragments.reduce((p, c) => {
      p.push(...this.splitFragment(c, filetype))
      return p
    }, [])
    if (this.enableHighlight) {
      let arr = await Promise.all(fragments.map(f => {
        return getHiglights(f.lines, f.filetype).then(highlights => {
          return highlights.map(highlight => {
            return Object.assign({}, highlight, { line: highlight.line + f.start })
          })
        })
      }))
      this.highlights = arr.reduce((p, c) => p.concat(c), [])
    } else {
      this.highlights = []
    }
  }

  public splitFragment(fragment: Fragment, defaultFileType: string): Fragment[] {
    let res: Fragment[] = []
    let filetype = fragment.filetype
    let lines: string[] = []
    let curr = fragment.start
    let inBlock = false
    for (let line of fragment.lines) {
      let ms = line.match(/^\s*```\s*(\w+)?/)
      if (ms != null) {
        if (lines.length) {
          res.push({ lines, filetype: this.fixFiletype(filetype), start: curr - lines.length })
          lines = []
        }
        inBlock = !inBlock
        filetype = inBlock ? ms[1] || defaultFileType : fragment.filetype
      } else {
        lines.push(line)
        curr = curr + 1
      }
    }
    if (lines.length) {
      res.push({ lines, filetype: this.fixFiletype(filetype), start: curr - lines.length })
      lines = []
    }
    return res
  }

  private fixFiletype(filetype: string): string {
    if (filetype == 'ts') return 'typescript'
    if (filetype == 'js') return 'javascript'
    if (filetype == 'bash') return 'sh'
    return filetype
  }

  public get height(): number {
    return this.lines.length
  }

  public setLines(): void {
    let { buffer, lines, nvim, highlights } = this
    nvim.call('clearmatches', [], true)
    buffer.clearNamespace(-1, 0, -1)
    buffer.setLines(lines, { start: 0, end: -1, strictIndexing: false }, true)
    if (highlights.length) {
      let positions: [number, number, number?][] = []
      for (let highlight of highlights) {
        nvim.call('matchaddpos', [highlight.hlGroup, [[highlight.line + 1, highlight.colStart + 1, highlight.colEnd - highlight.colStart]], 10], true)
        if (highlight.isMarkdown) {
          let line = lines[highlight.line]
          let before = line[characterIndex(line, highlight.colStart)]
          let after = line[characterIndex(line, highlight.colEnd) - 1]
          if (before == after && ['_', '`', '*'].indexOf(before) !== -1) {
            positions.push([highlight.line + 1, highlight.colStart + 1])
            positions.push([highlight.line + 1, highlight.colEnd])
          }
          if (highlight.colEnd - highlight.colStart == 2 && before == '\\') {
            positions.push([highlight.line + 1, highlight.colStart + 1])
          }
        }
      }
      for (let arr of group(positions, 8)) {
        nvim.call('matchaddpos', ['Conceal', arr, 11], true)
      }
    }
    if (this.positions.length) {
      for (let pos of this.positions) {
        buffer.addHighlight({
          srcId: -1,
          hlGroup: 'CocUnderline',
          line: pos[0] - 1,
          colStart: pos[1] - 1,
          colEnd: pos[1] + pos[2] - 1
        }).catch(_e => {
          // noop
        })
      }
    }
  }

  private softSplit(line: string, maxWidth: number): string[] {
    let { chars } = this
    let res: string[] = []
    let finished = false
    let start = 0
    do {
      let len = 0
      let lastNonKeyword = 0
      for (let i = start; i < line.length; i++) {
        let ch = line[i]
        let code = ch.charCodeAt(0)
        let iskeyword = code < 255 && chars.isKeywordCode(code)
        if (len >= maxWidth) {
          if (iskeyword && lastNonKeyword) {
            res.push(line.slice(start, lastNonKeyword + 1))
            start = lastNonKeyword + 1
          } else {
            let end = len == maxWidth ? i : i - 1
            res.push(line.slice(start, end))
            start = end
          }
          break
        }
        len = len + byteLength(ch)
        if (!iskeyword) lastNonKeyword = i
        if (i == line.length - 1) {
          let content = line.slice(start, i + 1)
          if (content.length) res.push(content)
          finished = true
        }
      }
    } while (!finished)
    return res
  }
}

function isSingleLine(line: string): boolean {
  if (line.trim().length == 0) return true
  let str = line.trim()
  if (str.startsWith('```') || str.length == 0) return true
  if (str.startsWith('-')) return true
  if (str.startsWith('*')) return true
  if (str.startsWith('#')) return true
  return false
}

function isBreakCharacter(ch: string): boolean {
  let code = ch.charCodeAt(0)
  if (code > 255) return false
  if (code >= 48 && code <= 57) return false
  if (code >= 97 && code <= 122) return false
  if (code >= 65 && code <= 90) return false
  return true
}
