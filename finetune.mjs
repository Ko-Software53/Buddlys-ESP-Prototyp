#!/usr/bin/env node
/**
 * Mistral Fine-Tuning CLI for Buddly
 *
 * Usage:
 *   node finetune.mjs list-files          # Show uploaded files & their IDs
 *   node finetune.mjs start               # Start fine-tuning job (interactive)
 *   node finetune.mjs status <job_id>     # Check job status
 *   node finetune.mjs watch <job_id>      # Poll status every 60s until done
 *   node finetune.mjs jobs                # List all fine-tuning jobs
 */

import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const env = readFileSync(path.join(__dirname, 'server/.env'), 'utf8');
    const key = env.match(/MISTRAL_API_KEY\s*=\s*"?([^"\n]+)"?/)?.[1];
    if (!key) throw new Error('MISTRAL_API_KEY not found in server/.env');
    return key;
  } catch {
    if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY;
    throw new Error('No MISTRAL_API_KEY found. Set it in server/.env or as env var.');
  }
}

const API_KEY = loadEnv();
const BASE = 'https://api.mistral.ai/v1';

// Base model to fine-tune — mistral-small-latest is the fine-tunable Small tier
const BASE_MODEL = 'mistral-small-latest';

// Hyperparameters: ~9700 examples, targeting ≈1 epoch (batch_size 8 → ~1213 steps)
// Adjust training_steps before running if you want more/fewer epochs.
const HYPERPARAMS = {
  training_steps: 1200,      // ≈1 epoch over 9700 examples at batch 8
  learning_rate: 0.0001,
};

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function listFiles() {
  const data = await api('GET', '/files');
  const files = data.data ?? data;
  if (!files.length) {
    console.log('No files found on your Mistral account.');
    return;
  }
  console.log('\nUploaded files on Mistral:');
  console.log('─'.repeat(80));
  for (const f of files) {
    console.log(`  ID:       ${f.id}`);
    console.log(`  Name:     ${f.filename}`);
    console.log(`  Size:     ${(f.bytes / 1024).toFixed(1)} KB`);
    console.log(`  Purpose:  ${f.purpose}`);
    console.log(`  Created:  ${new Date(f.created_at * 1000).toLocaleString()}`);
    console.log('─'.repeat(80));
  }
}

async function listJobs() {
  const data = await api('GET', '/fine_tuning/jobs');
  const jobs = data.data ?? data;
  if (!jobs.length) {
    console.log('No fine-tuning jobs found.');
    return;
  }
  console.log('\nFine-tuning jobs:');
  console.log('─'.repeat(80));
  for (const j of jobs) {
    console.log(`  ID:       ${j.id}`);
    console.log(`  Model:    ${j.fine_tuned_model ?? j.model}`);
    console.log(`  Status:   ${j.status}`);
    console.log(`  Created:  ${new Date(j.created_at * 1000).toLocaleString()}`);
    if (j.fine_tuned_model) {
      console.log(`  ✓ Model:  ${j.fine_tuned_model}`);
    }
    console.log('─'.repeat(80));
  }
}

async function getStatus(jobId) {
  const job = await api('GET', `/fine_tuning/jobs/${jobId}`);
  printJobStatus(job);
  return job;
}

function printJobStatus(job) {
  const elapsed = job.created_at
    ? Math.round((Date.now() / 1000 - job.created_at) / 60) + ' min ago'
    : '';
  console.log(`\nJob ${job.id}`);
  console.log(`  Status:   ${job.status}`);
  console.log(`  Base:     ${job.model}`);
  if (job.fine_tuned_model) {
    console.log(`  Output:   ${job.fine_tuned_model}`);
  }
  if (job.trained_tokens) {
    console.log(`  Tokens:   ${job.trained_tokens.toLocaleString()}`);
  }
  console.log(`  Created:  ${elapsed}`);
  if (job.integrations?.length) {
    console.log(`  WandB:    ${job.integrations[0].wandb?.url ?? 'connected'}`);
  }
}

async function watchJob(jobId) {
  console.log(`Watching job ${jobId} (polling every 60s, Ctrl+C to stop)…\n`);
  while (true) {
    const job = await getStatus(jobId);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(job.status)) {
      if (job.status === 'SUCCESS') {
        console.log('\n✓ Fine-tuning complete!');
        console.log(`\nAdd this to server/.env:\n  MISTRAL_MODEL=${job.fine_tuned_model}`);
      } else {
        console.log(`\n✗ Job ended with status: ${job.status}`);
      }
      break;
    }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function startJob() {
  // 1. Show available files
  await listFiles();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\nYou need to provide the file IDs for your training (and optionally validation) data.');

    const trainId = (await ask(rl, '\nTraining file ID: ')).trim();
    if (!trainId) throw new Error('Training file ID is required.');

    const valId = (await ask(rl, 'Validation file ID (leave blank to skip): ')).trim();

    const suffix = (await ask(rl, `Fine-tune suffix (default: buddly): `)).trim() || 'buddly';

    console.log('\nFine-tuning configuration:');
    console.log(`  Base model:      ${BASE_MODEL}`);
    console.log(`  Training file:   ${trainId}`);
    if (valId) console.log(`  Validation file: ${valId}`);
    console.log(`  Suffix:          ${suffix}`);
    console.log(`  Training steps:  ${HYPERPARAMS.training_steps}`);
    console.log(`  Learning rate:   ${HYPERPARAMS.learning_rate}`);

    const confirm = (await ask(rl, '\nStart job? [y/N]: ')).trim().toLowerCase();
    if (confirm !== 'y') {
      console.log('Aborted.');
      return;
    }

    const body = {
      model: BASE_MODEL,
      training_files: [{ file_id: trainId }],
      hyperparameters: HYPERPARAMS,
      suffix,
    };
    if (valId) body.validation_files = [{ file_id: valId }];

    const job = await api('POST', '/fine_tuning/jobs', body);

    console.log('\n✓ Fine-tuning job created!');
    printJobStatus(job);
    console.log(`\nMonitor with:\n  node finetune.mjs watch ${job.id}`);
    console.log(`\nOr check status:\n  node finetune.mjs status ${job.id}`);
  } finally {
    rl.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'list-files':
    await listFiles();
    break;
  case 'jobs':
    await listJobs();
    break;
  case 'start':
    await startJob();
    break;
  case 'status':
    if (!arg) { console.error('Usage: node finetune.mjs status <job_id>'); process.exit(1); }
    await getStatus(arg);
    break;
  case 'watch':
    if (!arg) { console.error('Usage: node finetune.mjs watch <job_id>'); process.exit(1); }
    await watchJob(arg);
    break;
  default:
    console.log(`Mistral Fine-Tuning CLI for Buddly

Commands:
  node finetune.mjs list-files          List uploaded files and their IDs
  node finetune.mjs start               Start a fine-tuning job (interactive)
  node finetune.mjs status <job_id>     Check job status
  node finetune.mjs watch <job_id>      Poll status every 60s until done
  node finetune.mjs jobs                List all fine-tuning jobs`);
}
