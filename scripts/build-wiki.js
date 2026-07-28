import fs from 'node:fs'
import path from 'node:path'

const WIKI_SOURCE = process.env.WIKI_SOURCE || '../personal-wiki/wiki'
const REDACTION_DIR = 'wiki-redactions'
const OUT_DIR = 'helium_wiki'

function walkMarkdown(dir) {
    const files = []
    const items = fs.readdirSync(dir, { withFileTypes: true })

    for (const item of items) {
        const fullPath = path.join(dir, item.name)
        if (item.isDirectory()) {
            files.push(...walkMarkdown(fullPath))
        } else if (item.name.endsWith('.md')) {
            files.push(fullPath)
        }
    }
    return files
}

function loadExcludeList() {
    const excludePath = path.join(REDACTION_DIR, 'EXCLUDE')
    if (!fs.existsSync(excludePath)) return new Set()

    return new Set(
        fs.readFileSync(excludePath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
    )
}

function main() {
    if (!fs.existsSync(WIKI_SOURCE)) {
        console.error(`WIKI_SOURCE not found: ${WIKI_SOURCE}`)
        console.error('Set WIKI_SOURCE, or check that personal-wiki is cloned as a sibling of helium.')
        process.exit(1)
    }

    const excludeSet = loadExcludeList()

    fs.rmSync(OUT_DIR, { recursive: true, force: true })
    fs.mkdirSync(OUT_DIR, { recursive: true })

    const sourceFiles = walkMarkdown(WIKI_SOURCE)
    let copied = 0, redacted = 0, excluded = 0

    for (const file of sourceFiles) {
        const relPath = path.relative(WIKI_SOURCE, file)

        if (excludeSet.has(relPath)) {
            console.log(`EXCLUDED ${relPath}`)
            excluded++
            continue
        }

        const outPath = path.join(OUT_DIR, relPath)
        fs.mkdirSync(path.dirname(outPath), { recursive: true })

        const redactionPath = path.join(REDACTION_DIR, relPath)
        if (fs.existsSync(redactionPath)) {
            fs.copyFileSync(redactionPath, outPath)
            console.log(`REDACTED ${relPath}`)
            redacted++
        } else {
            fs.copyFileSync(file, outPath)
            console.log(`copied   ${relPath}`)
            copied++
        }
    }

    console.log(`\n${copied} copied, ${redacted} redacted, ${excluded} excluded → ${OUT_DIR}/`)
}

main()
