import 'dotenv/config'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY})

// Deleting rows needs a privileged key if RLS is on; the deployed function only
// ever reads, so it stays on the anon key. This script prefers the service-role
// key locally and falls back to anon (works if RLS allows anon writes).
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey)

function getWikiFiles(dir){
    const Files = []
    const items = fs.readdirSync(dir, {withFileTypes: true})

    for (const item of items){
        const fullPath = path.join(dir, item.name)
        if (item.isDirectory()){
            Files.push(...getWikiFiles(fullPath))
        } else if (item.name.endsWith('.md')){
            Files.push(fullPath)
        }
    }
    return Files
}

async function main(){
    const files = getWikiFiles('helium_wiki')

    // Truncate before inserting: this is a rebuild, not an accumulation. A file
    // removed from the source (or newly excluded for privacy) must stop being
    // servable — upsert-by-filename can't do that, it only ever adds or updates.
    // .not('id', 'is', null) matches every row regardless of id's type/values.
    const { error: deleteError, count: deletedCount } = await supabase
        .from('wiki_chunks')
        .delete({ count: 'exact' })
        .not('id', 'is', null)

    if (deleteError) {
        const looksLikeRLS =
            deleteError.code === '42501' ||
            /permission|policy|rls/i.test(deleteError.message)

        if (looksLikeRLS) {
            console.error(
                'Delete failed — looks like it was blocked by Row Level Security.\n' +
                'Add SUPABASE_SERVICE_ROLE_KEY to your local .env (Supabase dashboard →\n' +
                'Settings → API → service_role key). Keep it local only — never add it to\n' +
                'the deployed function\'s env, which should stay read-only on the anon key.'
            )
        }
        throw new Error(deleteError.message)
    }
    console.log(`Deleted ${deletedCount ?? 'all'} existing rows from wiki_chunks`)

    let inserted = 0
    for (const file of files){
        const content = fs.readFileSync(file, 'utf8')
        const stripped = content.replace(/^---[\s\S]*?---\n/, '')
        const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: stripped
        })
        const vector = response.data[0].embedding
        const { error } = await supabase.from('wiki_chunks').insert({
            filename: file.replace('helium_wiki/', '').replace('.md', ''),
            title: null,
            tags: null,
            content: stripped,
            embedding: vector
        })

        if (error) {
            console.error('Error inserting', file, error)
        } else {
            console.log('Inserted:', file)
            inserted++
        }
    }

    console.log(`\nDone: deleted ${deletedCount ?? 'all'} old rows, inserted ${inserted}/${files.length} files.`)
}
main()
