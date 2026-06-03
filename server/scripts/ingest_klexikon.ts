import 'dotenv/config';
import { supabase } from '../src/supabase.js';
import { generateEmbeddings } from '../src/rag.js';

/**
 * Ingest the German kids' encyclopedia "Klexikon" into global_knowledge.
 *
 * Klexikon's MediaWiki does NOT have the TextExtracts extension (prop=extracts
 * is rejected), so we pull raw wikitext via prop=revisions and clean it here.
 *
 * Speed/cost optimisations:
 *  - Only real articles (apfilterredir=nonredirects) — Klexikon has ~966, the
 *    rest are redirects we must not embed as if they were content.
 *  - Titles fetched 50 per API request (MediaWiki's per-request title cap).
 *  - Embeddings batched EMBED_BATCH per Mistral request (the only real cost).
 *  - Rows inserted into Supabase in one batch per embed batch.
 */

const KLEXIKON_API = 'https://klexikon.zum.de/api.php';
const TITLES_PER_FETCH = 50;   // MediaWiki caps `titles` at 50 per request
const EMBED_BATCH = 32;        // chunks per mistral-embed request
const EMBED_DELAY_MS = 200;    // gentle pause between embed batches (rate limits)

interface Record {
  title: string;
  content: string;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All non-redirect article titles in the main namespace. */
async function fetchAllPageTitles(): Promise<string[]> {
  const titles: string[] = [];
  let apcontinue: string | undefined;

  console.log('Fetching list of articles from Klexikon...');
  do {
    const url = new URL(KLEXIKON_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allpages');
    url.searchParams.set('aplimit', '500');
    url.searchParams.set('apnamespace', '0');
    url.searchParams.set('apfilterredir', 'nonredirects'); // skip redirect stubs
    url.searchParams.set('format', 'json');
    if (apcontinue) url.searchParams.set('apcontinue', apcontinue);

    const res = await fetch(url.toString());
    const data: any = await res.json();

    for (const page of data?.query?.allpages ?? []) {
      if (page.title && !page.title.startsWith('Klexikon:')) titles.push(page.title);
    }
    apcontinue = data?.continue?.apcontinue;
    console.log(`  ...${titles.length} titles so far`);
  } while (apcontinue);

  return titles;
}

/** Fetch wikitext for up to 50 titles at once; returns title -> wikitext. */
async function fetchArticleTexts(batchTitles: string[]): Promise<Map<string, string>> {
  const url = new URL(KLEXIKON_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('prop', 'revisions');
  url.searchParams.set('rvprop', 'content');
  url.searchParams.set('rvslots', 'main');
  url.searchParams.set('titles', batchTitles.join('|'));
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');

  const res = await fetch(url.toString());
  const data: any = await res.json();

  const out = new Map<string, string>();
  for (const page of Object.values<any>(data?.query?.pages ?? {})) {
    const wikitext = page?.revisions?.[0]?.slots?.main?.['*'];
    if (page?.title && typeof wikitext === 'string') out.set(page.title, wikitext);
  }
  return out;
}

/**
 * Strip MediaWiki markup down to readable plain text. Klexikon articles are
 * written for children and use very little markup, so this stays simple.
 */
function cleanWikitext(raw: string): string {
  let t = raw;

  // Redirect pages (shouldn't appear after the filter, but be safe)
  if (/^\s*#(WEITERLEITUNG|REDIRECT)/i.test(t)) return '';

  t = t.replace(/<!--[\s\S]*?-->/g, '');                 // comments
  t = t.replace(/<ref[^>]*\/>/gi, '');                   // self-closing refs
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');      // ref blocks
  t = t.replace(/<\/?[^>]+>/g, '');                      // any other HTML tags

  // Drop whole image/file/category lines (each is on its own line in Klexikon)
  t = t
    .split('\n')
    .filter((line) => !/^\s*\[\[(Datei|Bild|File|Kategorie|Category):/i.test(line))
    .join('\n');

  // Templates {{...}} — remove repeatedly to catch (shallow) nesting
  let prev: string;
  do {
    prev = t;
    t = t.replace(/\{\{[^{}]*\}\}/g, '');
  } while (t !== prev);

  // Tables {| ... |}
  t = t.replace(/\{\|[\s\S]*?\|\}/g, '');

  // Wikilinks: [[Target|Display]] -> Display, [[Link]] -> Link
  t = t.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1');
  t = t.replace(/\[\[([^\]]+)\]\]/g, '$1');

  // External links: [http://x label] -> label, bare [http://x] -> ''
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');
  t = t.replace(/\[https?:\/\/\S+\]/g, '');

  // Headings ==Text== -> Text (kept as its own line for context)
  t = t.replace(/^=+\s*(.*?)\s*=+\s*$/gm, '$1');

  t = t.replace(/'''?/g, '');                            // bold/italic
  t = t.replace(/^[*#:;]+\s*/gm, '');                    // list/indent markers

  // Collapse whitespace
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * Split cleaned text into ~800-char chunks on paragraph boundaries, each
 * prefixed with the article title so the embedding has topical context.
 */
function chunkText(text: string, title: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 20);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length >= 800) {
      chunks.push(current);
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `[Artikel: ${title}]\n${c}`);
}

/** Embed `records` in batches and bulk-insert into global_knowledge. */
async function embedAndInsert(records: Record[]): Promise<{ inserted: number; failed: number }> {
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i += EMBED_BATCH) {
    const batch = records.slice(i, i + EMBED_BATCH);
    const batchNo = Math.floor(i / EMBED_BATCH) + 1;
    const total = Math.ceil(records.length / EMBED_BATCH);
    try {
      const embeddings = await generateEmbeddings(batch.map((r) => r.content));
      const rows = batch.map((r, j) => ({
        title: r.title,
        content: r.content,
        embedding: embeddings[j],
      }));
      const { error } = await supabase!.from('global_knowledge').insert(rows);
      if (error) {
        console.error(`  [embed ${batchNo}/${total}] insert error:`, error.message);
        failed += batch.length;
      } else {
        inserted += batch.length;
        console.log(`  [embed ${batchNo}/${total}] inserted ${batch.length} chunks (${inserted} total)`);
      }
    } catch (err: any) {
      console.error(`  [embed ${batchNo}/${total}] error:`, err.message);
      failed += batch.length;
    }
    await delay(EMBED_DELAY_MS);
  }
  return { inserted, failed };
}

async function main() {
  // --dry: fetch + clean + chunk only (no embeddings, no DB writes) to sanity-check.
  // --limit N: only process the first N articles (handy with --dry).
  const dry = process.argv.includes('--dry');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  if (!dry && !supabase) {
    console.error('Supabase client not initialized. Check your .env file.');
    process.exit(1);
  }

  let titles = await fetchAllPageTitles();
  if (Number.isFinite(limit)) titles = titles.slice(0, limit);
  console.log(`Found ${titles.length} articles. Fetching + cleaning...`);

  const records: Record[] = [];
  let skipped = 0;

  for (let i = 0; i < titles.length; i += TITLES_PER_FETCH) {
    const batch = titles.slice(i, i + TITLES_PER_FETCH);
    const texts = await fetchArticleTexts(batch);
    for (const title of batch) {
      const raw = texts.get(title);
      const cleaned = raw ? cleanWikitext(raw) : '';
      if (cleaned.length < 100) {
        skipped++;
        continue;
      }
      for (const chunk of chunkText(cleaned, title)) records.push({ title, content: chunk });
    }
    console.log(`  fetched ${Math.min(i + TITLES_PER_FETCH, titles.length)}/${titles.length} articles → ${records.length} chunks`);
  }

  console.log(`\nPrepared ${records.length} chunks (${skipped} articles skipped).`);

  if (dry) {
    console.log(`\n=== DRY RUN (no embeddings, no DB writes) ===`);
    console.log(`Would embed/insert ${records.length} chunks `
      + `(~${Math.ceil(records.length / EMBED_BATCH)} embed requests).`);
    console.log(`\n--- Sample chunk ---\n${records[0]?.content ?? '(none)'}\n--------------------`);
    return;
  }

  console.log('Embedding...');
  const { inserted, failed } = await embedAndInsert(records);

  console.log(`\n=== INGESTION COMPLETE ===`);
  console.log(`Chunks inserted: ${inserted}`);
  console.log(`Chunks failed:   ${failed}`);
}

main().catch(console.error);
