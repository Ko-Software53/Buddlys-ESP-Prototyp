import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { supabase } from '../src/supabase.js';
import { generateEmbedding } from '../src/rag.js';

/**
 * Basic script to ingest a document into the global_knowledge table.
 * Usage: npx tsx scripts/ingest.ts <path-to-file> <title>
 */

async function main() {
  const filePath = process.argv[2];
  const title = process.argv[3];

  if (!filePath || !title) {
    console.error('Usage: npx tsx scripts/ingest.ts <path-to-file> <title>');
    process.exit(1);
  }

  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  
  // Simple chunking by double newlines (paragraphs)
  // In a real production scenario, use a proper markdown chunker (e.g. LangChain's RecursiveCharacterTextSplitter)
  const chunks = content
    .split(/\n\s*\n/)
    .map(c => c.trim())
    .filter(c => c.length > 50); // Ignore very short fragments

  console.log(`Split document into ${chunks.length} chunks. Generating embeddings...`);

  if (!supabase) {
    console.error('Supabase client not initialized. Check your .env file.');
    process.exit(1);
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      console.log(`[${i + 1}/${chunks.length}] Embedding chunk...`);
      const embedding = await generateEmbedding(chunk);
      
      const { error } = await supabase.from('global_knowledge').insert({
        title: title,
        content: chunk,
        embedding: embedding,
      });

      if (error) {
        console.error(`Failed to insert chunk ${i + 1}:`, error.message);
      }
    } catch (err: any) {
      console.error(`Error processing chunk ${i + 1}:`, err.message);
    }
    
    // Brief sleep to avoid hitting API rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Ingestion complete!');
}

main().catch(console.error);
