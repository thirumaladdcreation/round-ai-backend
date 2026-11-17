import { pathToFileURL } from 'node:url';
import { openDb, run, get, all, tx } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { uid, nowIso } from './util.js';
import { seedTemplates } from './templates.js';
import { seedDemoIcdIfEmpty } from './icd.js';
import { seedExampleCheckRules } from './check_rules.js';
import { mockGenerate } from './ai/mock.js';
import { validateExtractFacts, isIdentityFact } from './ai/validators.js';
import { ensurePatientChannel, ensureTeamChannel } from './chat.js';
import { topicKey } from './learning.js';

export const DEMO_PASSWORD = 'ChangeMe-12345';

const ROSA_SOURCES = [
  { kind: 'admission_note', title: 'Admission note', event_time: '2026-08-29T08:00', text: '68-year-old woman admitted with community-acquired pneumonia. Temperature 38.6 C on arrival. SpO2 93% on room air. Creatinine 0.9 mg/dL. No chest pain. Started on ceftriaxone and azithromycin.' },
  { kind: 'overnight_event', title: 'Overnight event', event_time: '2026-08-30T22:00', text: 'Patient developed increasing oxygen need overnight. SpO2 88% on room air. Started on 2 L nasal cannula. Pulse 112 bpm. Urine output 20 mL/hr over 6 hours. Creatinine 1.8 mg/dL.' },
  { kind: 'lab_review', title: 'Morning labs', event_time: '2026-08-31T06:00', text: 'Creatinine 2.1 mg/dL. Possible acute kidney injury. Blood cultures pending. No fever overnight. Pulse 98 bpm.' },
];

const ALEX_SOURCES = [
  { kind: 'admission_note', title: 'Admission note', event_time: '2026-08-30T10:00', text: '52-year-old man admitted with community-acquired pneumonia. Productive cough for three days. SpO2 94% on room air. Temperature 38.1 C.' },
];

/** Backfill approved Elevated Pulse questions on already-seeded DBs. */
function ensureElevatedPulseBank() {
  const key = topicKey('Elevated Pulse');
  const existing = get("SELECT COUNT(*) AS n FROM mcqs WHERE topic_key=? AND status='approved'", key);
  if (existing?.n > 0) return;
  const admin = get("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) return;
  const now = nowIso();
  seedApprovedMcq({
    adminId: admin.id,
    topic: 'Elevated Pulse',
    vignette: 'A 68-year-old woman with community-acquired pneumonia develops SpO2 88% on room air overnight and is placed on 2 L nasal cannula. Pulse is 112 bpm. Creatinine has risen from 0.9 to 1.8 mg/dL with low urine output.',
    question: 'Which next bedside assessment best clarifies the tachycardia in this context?',
    options: [
      'Volume status and oxygen delivery before attributing tachycardia to infection alone',
      'Immediate cardioversion for presumed unstable SVT',
      'Stopping antibiotics to reduce drug fever',
      'Ignoring pulse until blood cultures return',
    ],
    correctIndex: 0,
    explanations: [
      'Tachycardia with rising oxygen need and falling urine output warrants volume and gas-exchange assessment; the pulse is a clue, not a diagnosis.',
      'Cardioversion is for unstable arrhythmia with clear criteria, not the first step from this vignette alone.',
      'Antibiotics are treating pneumonia; stopping them is not indicated for this finding.',
      'Pending cultures do not justify ignoring a new vital-sign change.',
    ],
    now,
  });
  console.log('Backfilled approved Elevated Pulse learning questions.');
}

function seedApprovedMcq({ adminId, topic, vignette, question, options, correctIndex, explanations, now }) {
  const id = uid();
  const content = {
    vignette,
    question,
    options,
    correct_index: correctIndex,
    explanations,
    model: 'seed',
  };
  run(
    `INSERT INTO mcqs(id,topic,topic_key,difficulty,stage,content,validation,status,source,created_by,approved_by,approved_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    topic,
    topicKey(topic),
    'core',
    'application',
    JSON.stringify(content),
    JSON.stringify({ ok: true, seed: true }),
    'approved',
    'human',
    adminId,
    adminId,
    now,
    now,
  );
  return id;
}

async function seedPatientFacts({ patientId, sources, now }) {
  for (const s of sources) {
    const sid = uid();
    run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)', sid, patientId, s.kind, s.title, s.event_time, now, s.text);
    const { json } = await mockGenerate({ operation: 'extract_facts', payload: { source: { ...s, id: sid } } });
    const { output } = validateExtractFacts(json, { ...s, id: sid });
    for (const f of output.facts) {
      run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'confirmed',1,?)`, uid(), patientId, f.label, f.value, f.unit, f.event_time, sid, f.source_passage, f.assertion, now);
    }
  }
}

/**
 * All data here is fictional. Never put real patient data into a development database.
 * If a prior demo DB is contaminated (wrong-patient facts), delete the SQLite file and re-run seed.
 */
export function purgeIdentityFacts() {
  const rows = all('SELECT id, label, value FROM facts');
  let n = 0;
  for (const f of rows) {
    if (isIdentityFact(f.label, f.value)) {
      run("UPDATE facts SET reviewer_status='rejected' WHERE id=?", f.id);
      n += 1;
    }
  }
  return n;
}

/**
 * All data here is fictional. Never put real patient data into a development database.
 * If a prior demo DB is contaminated (wrong-patient facts), delete the SQLite file and re-run seed.
 */
export async function seedDemo() {
  seedTemplates();
  seedDemoIcdIfEmpty();
  seedExampleCheckRules();
  // Existing DBs: drop identity leakage and backfill learning if the bank is empty.
  if (get('SELECT 1 AS x FROM users LIMIT 1')) {
    const purged = purgeIdentityFacts();
    if (purged) console.log(`Purged ${purged} identity fact(s) from existing demo DB.`);
    ensureElevatedPulseBank();
    return null;
  }
  const teamA = uid(); const teamB = uid();
  const admin = uid(); const resident = uid(); const other = uid();
  const now = nowIso();
  const pw = hashPassword(DEMO_PASSWORD);
  tx(() => {
    run('INSERT INTO teams(id,name) VALUES(?,?)', teamA, 'Internal Medicine Team A');
    run('INSERT INTO teams(id,name) VALUES(?,?)', teamB, 'Internal Medicine Team B');
    for (const [id, email, name, role] of [[admin, 'admin@rounds.test', 'Demo Admin', 'admin'], [resident, 'resident@rounds.test', 'Demo Resident', 'resident'], [other, 'other@rounds.test', 'Other Team Resident', 'resident']]) {
      run('INSERT INTO users(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)', id, email, name, role, pw, now);
    }
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamA, resident);
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamA, admin);
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamB, other);
  });
  const patientId = uid();
  const alexId = uid();
  run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)', patientId, teamA, 'Rosa Martinez (fictional)', '509A', '60s', 'female', 10, now);
  run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)', alexId, teamA, 'Alex Rivera (fictional)', '401', '50s', 'male', 20, now);
  ensureTeamChannel({ teamId: teamA, createdBy: admin });
  ensureTeamChannel({ teamId: teamB, createdBy: other });
  ensurePatientChannel({ patient: get('SELECT * FROM patients WHERE id=?', patientId), createdBy: admin });
  ensurePatientChannel({ patient: get('SELECT * FROM patients WHERE id=?', alexId), createdBy: admin });

  await seedPatientFacts({ patientId, sources: ROSA_SOURCES, now });
  await seedPatientFacts({ patientId: alexId, sources: ALEX_SOURCES, now });

  // Confirmed problems drive Learn topics for the demo.
  const rosaFacts = get("SELECT id FROM facts WHERE patient_id=? AND label LIKE '%Creatinine%' ORDER BY created_at DESC LIMIT 1", patientId);
  const insertProblem = (label, factIds) => run(
    `INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    uid(), patientId, label, 'confirmed', JSON.stringify(factIds), '', now, now,
  );
  insertProblem('acute kidney injury', rosaFacts ? [rosaFacts.id] : []);
  insertProblem('Elevated Pulse', []);
  insertProblem('community-acquired pneumonia', []);

  // Seed accepted ICD examples so the A&P ICD toggle can be demonstrated.
  const akiProblem = get("SELECT id FROM problems WHERE patient_id=? AND label='acute kidney injury'", patientId);
  const capProblem = get("SELECT id FROM problems WHERE patient_id=? AND label='community-acquired pneumonia'", patientId);
  if (akiProblem) {
    run(
      'UPDATE problems SET code_suggestion=? WHERE id=?',
      JSON.stringify({
        code: 'N17.9',
        description: 'Acute kidney failure, unspecified',
        billable: true,
        label: 'Suggestion for clinician/coder review. Not a billing determination.',
      }),
      akiProblem.id,
    );
  }
  if (capProblem) {
    run(
      'UPDATE problems SET code_suggestion=? WHERE id=?',
      JSON.stringify({
        code: 'J18.9',
        description: 'Pneumonia, unspecified organism',
        billable: true,
        label: 'Suggestion for clinician/coder review. Not a billing determination.',
      }),
      capProblem.id,
    );
  }

  // Prefill a problem-organized Assessment and Plan for the complete demo path.
  run(
    'INSERT INTO plans(id,patient_id,plan_date,text,author_id,revision,created_at) VALUES(?,?,?,?,?,?,?)',
    uid(),
    patientId,
    now.slice(0, 10),
    [
      'Community-acquired pneumonia — continue ceftriaxone and azithromycin; follow blood cultures',
      'Acute kidney injury — hold nephrotoxins; recheck creatinine; assess volume status',
      'Elevated Pulse — correlate with oxygen delivery and volume before attributing to fever alone',
    ].join('\n'),
    admin,
    1,
    now,
  );

  seedApprovedMcq({
    adminId: admin,
    topic: 'Elevated Pulse',
    vignette: 'A 68-year-old woman with community-acquired pneumonia develops SpO2 88% on room air overnight and is placed on 2 L nasal cannula. Pulse is 112 bpm. Creatinine has risen from 0.9 to 1.8 mg/dL with low urine output.',
    question: 'Which next bedside assessment best clarifies the tachycardia in this context?',
    options: [
      'Volume status and oxygen delivery before attributing tachycardia to infection alone',
      'Immediate cardioversion for presumed unstable SVT',
      'Stopping antibiotics to reduce drug fever',
      'Ignoring pulse until blood cultures return',
    ],
    correctIndex: 0,
    explanations: [
      'Tachycardia with rising oxygen need and falling urine output warrants volume and gas-exchange assessment; the pulse is a clue, not a diagnosis.',
      'Cardioversion is for unstable arrhythmia with clear criteria, not the first step from this vignette alone.',
      'Antibiotics are treating pneumonia; stopping them is not indicated for this finding.',
      'Pending cultures do not justify ignoring a new vital-sign change.',
    ],
    now,
  });

  seedApprovedMcq({
    adminId: admin,
    topic: 'Elevated Pulse',
    vignette: 'Same patient: pulse 112 bpm on 2 L nasal cannula after overnight desaturation to SpO2 88% on room air. Blood pressure is stable.',
    question: 'Which statement best reflects how to teach this finding on rounds?',
    options: [
      'Treat tachycardia as a sign to integrate gas exchange and volume, not a rhythm diagnosis by itself',
      'Label SVT and cardiovert before examining the patient',
      'Ignore until the discharge summary',
      'Attribute solely to anxiety without vitals context',
    ],
    correctIndex: 0,
    explanations: [
      'Teaching should connect the pulse to oxygen delivery and volume using the documented facts.',
      'Cardioversion without instability criteria is not supported by this vignette.',
      'A new vital-sign change belongs in today’s assessment.',
      'Anxiety is not documented; do not invent unsupported explanations.',
    ],
    now,
  });

  seedApprovedMcq({
    adminId: admin,
    topic: 'acute kidney injury',
    vignette: 'Creatinine rose from 0.9 to 2.1 mg/dL over two days during diuresis with urine output 20 mL/hr.',
    question: 'What is the most appropriate framing of this creatinine change for rounds?',
    options: [
      'Possible acute kidney injury with low urine output — review volume status and nephrotoxins',
      'Chronic kidney disease stage 5 requiring immediate dialysis',
      'Lab error; ignore until the next admission',
      'Expected rise from antibiotics alone',
    ],
    correctIndex: 0,
    explanations: [
      'A clear rise with oliguria is AKI until proven otherwise; volume and toxin review are core.',
      'Nothing in the vignette establishes CKD stage 5 or an immediate dialysis indication.',
      'Do not discard a verified trend without clinical review.',
      'Antibiotics can contribute but do not make the rise “expected” without assessment.',
    ],
    now,
  });

  run(
    `INSERT INTO curated_reads(id,topic,topic_key,title,citation,url,pmid,why_it_matters,added_by,approved,approved_by,approved_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    uid(),
    'Elevated Pulse',
    topicKey('Elevated Pulse'),
    'Approach to tachycardia in acute illness (educational)',
    'Demo curated read — fictional citation for offline demos',
    'https://example.com/demo-tachycardia',
    null,
    'Links vital-sign change to oxygen delivery and volume before labeling a rhythm diagnosis.',
    admin,
    admin,
    now,
    now,
  );

  return { teamA, teamB, admin, resident, other, patientId, alexId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openDb(config.dbPath);
  const out = await seedDemo();
  console.log(out ? `Seeded demo data.\n  admin@rounds.test / resident@rounds.test / other@rounds.test\n  password: ${DEMO_PASSWORD}\n  Tip: delete the SQLite DB file and re-run seed if a prior demo was contaminated.` : 'Database already has users; nothing seeded.');
}
