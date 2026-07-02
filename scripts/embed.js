import 'dotenv/config'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY})
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

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
    const files = getWikiFiles('wiki')
    
    for (const file of files){
        const content = fs.readFileSync(file, 'utf8')
        const stripped = content.replace(/^---[\s\S]*?---\n/, '')
        const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: stripped
    })
    const vector = response.data[0].embedding
    const { error } = await supabase.from('wiki_chunks').insert({
        filename: file.replace('wiki/', '').replace('.md', ''),
        title: null,
        tags: null,
        content: stripped,
        embedding: vector
    })
    
    if (error) console.error('Error inserting', file, error)
    else console.log('Inserted:', file)
    }
}
main()