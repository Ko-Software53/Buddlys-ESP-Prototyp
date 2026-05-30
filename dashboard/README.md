# Buddly · Pädagoginnen-Dashboard

Anonymisiertes Web-Dashboard für die Familien-Testphase. Fasst die Nutzung aller
Buddly-Prototypen zusammen (Zeiten, Ø-Gesprächsdauer, Themen, Use-Cases) und lässt
Pädagog:innen problematische Dialoge **flaggen** und **kommentieren**.

Reines Vite + React + TypeScript, liest direkt aus Supabase über die anonymisierten
Views — **kein eigener Backend-Server**. Datenschutz wird durch Supabase RLS + die
`educator`-Rolle erzwungen; das Frontend nutzt nur den öffentlichen Anon-Key.

## Setup

```bash
cd dashboard
npm install
cp .env.example .env.local   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY eintragen
npm run dev                  # http://localhost:5174
```

Die DB-Migration `supabase/migrations/004_dashboard_analytics.sql` muss eingespielt
sein (Supabase SQL-Editor oder `supabase db push`). Sie legt an: `profiles` (Rollen),
Flag-Spalten + `use_case` auf `conversations`, `conversation_comments`, die
Educator-RLS-Policies und die anonymisierten Views `educator_conversations` /
`educator_messages`.

## Eine Pädagogin freischalten

Account ganz normal per E-Mail/Passwort in Supabase Auth anlegen (oder von der Person
registrieren lassen), dann die Rolle setzen:

```sql
update public.profiles set role = 'educator'
where email = 'paedagogin@example.org';
```

Nur `educator`/`admin` kommen über das Login hinaus; `parent` (Default) wird abgewiesen.

## Was anonymisiert ist

- Geräte erscheinen nur als stabiler Code `Buddly-XXXX` (Hash der device_id) — kein
  Kindname, kein Alter, kein Eltern-Account.
- Im Transkript wird der hinterlegte Kindname serverseitig durch `[Name]` ersetzt
  (View `educator_messages`).
- Aggregierte Auswertungen (Übersicht) enthalten keinerlei personenbezogene Daten.

## Auto-Flagging

Der Server (`server/src/index.ts`, `finalizeCurrent`) markiert Dialoge automatisch als
problematisch bei: TTS lieferte kein Audio (Spielzeug stumm), ≤1 Nachricht (kein echter
Dialog) oder Dauer < 5 s. Pädagog:innen können zusätzlich manuell flaggen/entflaggen.

## Build / Deploy

```bash
npm run build     # -> dist/  (statisch hostbar, z. B. Railway/Vercel/Netlify)
```
